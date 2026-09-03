#!/usr/bin/env node
/**
 * Uploads fetched material into the lessons sheet as unassigned rows.
 *
 * Kept separate from tools/fetch-materials.js on purpose: fetching a few
 * hundred articles takes a while, and a failed upload should not mean
 * fetching them all over again. Run the fetch once, upload the file as many
 * times as it takes.
 *
 * Rows land with lesson_id empty, which marks them as material -- text and
 * audio ready, questions not written yet. Gemini Spark picks one up each day
 * and fills in the questions, at which point it becomes a lesson.
 *
 * Usage:
 *   node tools/upload-materials.js materials.json --url <exec URL> --token <token>
 *   node tools/upload-materials.js materials.json --setup MY-SETUP.local.md
 *
 * Duplicate source_urls are rejected by the server, so re-running is safe.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Contract = require(path.resolve(__dirname, '..', 'js', 'contract.js'));

/** Sent per request. Apps Script has a 6-minute execution limit. */
const BATCH_SIZE = 25;

function parseArgs(argv) {
  const args = { file: null, url: null, token: null, setup: null };
  args.file = argv[2] && !argv[2].startsWith('--') ? argv[2] : null;
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (['url', 'token', 'setup'].includes(key)) args[key] = argv[i + 1];
  }
  return args;
}

/**
 * Reads the exec URL and sync token out of MY-SETUP.local.md, so they never
 * have to be typed on a command line (where they end up in shell history).
 */
function readSetup(file) {
  const text = fs.readFileSync(file, 'utf8');
  const url = (text.match(/https:\/\/script\.google\.com\/\S*?\/exec/) || [])[0];
  const token = (text.match(/^[a-f0-9]{32,}$/m) || [])[0];
  return { url, token };
}

async function postBatch(endpoint, token, materials) {
  const res = await fetch(`${endpoint}?token=${encodeURIComponent(token)}&action=${Contract.ACTIONS.ADD_MATERIALS}`, {
    method: 'POST',
    // text/plain avoids a CORS preflight Apps Script does not answer; the
    // body is still JSON and Code.gs parses it as such. Same choice as js/api.js.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(materials)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(`伺服器回報：${body.error}`);
  return body;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.file) {
    console.error('用法：node tools/upload-materials.js <materials.json> --setup MY-SETUP.local.md');
    process.exit(1);
  }

  let { url, token } = args;
  if (!url || !token) {
    const setupFile = args.setup || 'MY-SETUP.local.md';
    if (!fs.existsSync(setupFile)) {
      console.error(`找不到 ${setupFile}，請改用 --url 與 --token 指定`);
      process.exit(1);
    }
    const found = readSetup(setupFile);
    url = url || found.url;
    token = token || found.token;
  }

  if (!url || !token) {
    console.error('缺少 Apps Script 網址或同步權杖');
    process.exit(1);
  }

  const materials = JSON.parse(fs.readFileSync(path.resolve(args.file), 'utf8'));
  console.log(`準備上傳 ${materials.length} 筆素材，每批 ${BATCH_SIZE} 筆`);

  let written = 0;
  let skipped = 0;

  for (let i = 0; i < materials.length; i += BATCH_SIZE) {
    const batch = materials.slice(i, i + BATCH_SIZE);
    const label = `第 ${i + 1}-${i + batch.length} 筆`;
    try {
      const result = await postBatch(url, token, batch);
      written += (result.written || []).length;
      skipped += (result.skipped || []).length;
      console.log(`  ${label}：寫入 ${(result.written || []).length}、跳過 ${(result.skipped || []).length}`);
    } catch (err) {
      console.log(`  ${label} 失敗：${err.message}`);
      console.log('  已寫入的部分不受影響，修正後重跑即可（重複的 source_url 會被伺服器擋掉）');
      process.exit(1);
    }
  }

  console.log(`\n完成：新增 ${written} 列素材，跳過 ${skipped} 列（多為重複的 source_url）`);
  console.log('這些列的 lesson_id 是空的，代表尚未出題。Spark 每天會挑一列填上題目。');
}

main().catch((err) => {
  console.error('失敗：' + err.message);
  process.exit(1);
});
