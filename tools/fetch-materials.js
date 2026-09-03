#!/usr/bin/env node
/**
 * Collects VOA Learning English articles into lesson material.
 *
 * Why this exists: Gemini Spark cannot reach these pages. VOA's Akamai layer
 * refuses its requests outright, and BBC opts out of Google's crawler
 * entirely, so no amount of prompt wording gets Spark to the source. This
 * script does the fetching instead, and leaves Spark the part it can do --
 * writing questions from text that is already in the sheet.
 *
 * Two page types matter and they are easy to confuse. The podcast feeds point
 * at clip pages (`/a/<id>.html`, page_type "clipsexternal") which carry the
 * audio but no words. The article pages (`/a/<slug>/<id>.html`, page_type
 * "article") carry both. Only the latter is usable, so links are gathered
 * from the category listings, which link to articles.
 *
 * Usage:
 *   node tools/fetch-materials.js --count 10 --out materials.json
 *   node tools/fetch-materials.js --count 200 --pages 12
 *
 * Output is a JSON array; each entry maps onto the lessons sheet columns that
 * do not depend on a model (see docs/specs/2026-09-02-content-pipeline.md).
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * VOA category ("zone") listings that carry article links. 1574 was checked
 * too and yields none -- it lists clips only -- so it is deliberately absent.
 */
const ZONES = [
  { id: 955, name: 'Health & Lifestyle' },
  { id: 1579, name: 'Science & Technology' }
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BASE = 'https://learningenglish.voanews.com';

/** Polite pause between requests. This is an archive fetch, not a race. */
const DELAY_MS = 700;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, '--')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Article links from one category listing page. */
async function collectLinks(zoneId, page) {
  const url = page > 1 ? `${BASE}/z/${zoneId}?p=${page}` : `${BASE}/z/${zoneId}`;
  const html = await get(url);
  const found = new Set();
  const re = /\/a\/([a-z0-9-]+)\/(\d+)\.html/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    found.add(`${BASE}/a/${m[1]}/${m[2]}.html`);
  }
  return [...found];
}

/**
 * Pulls the transcript and audio URL out of one article page.
 * Returns null (rather than throwing) when a page is unusable, so one odd
 * article cannot end a long run.
 */
async function fetchArticle(url) {
  const html = await get(url);

  const pageType = (html.match(/page_type:"([^"]+)"/) || [])[1];
  if (pageType !== 'article') return null;

  const title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '')
    .replace(/\s*\|\s*VOA.*$/i, '')
    .trim();

  const paragraphs = [];
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = pRe.exec(html)) !== null) {
    const text = stripTags(m[1]);
    if (text.split(/\s+/).length > 5) paragraphs.push(text);
  }
  // VOA appends its own glossary to every article. Keeping it would make the
  // reading text trail off into definitions, and would quietly defeat the
  // vocab check in validateLesson: every term the model picked would be
  // "found in the text" because the glossary defines it right there.
  //
  // The "Words in This Story" heading itself is not a <p>, so it never
  // reaches this array -- only the entries below it do. Detect those by their
  // shape ("term - n. definition") and drop from the first one onward, since
  // the glossary always sits at the end of the article.
  const glossaryEntry = /^\S+(\s\S+)?\s+[-–—]\s*(n|v|adj|adv|prep|conj|pron)\b\.?\s/i;
  let cut = paragraphs.length;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    if (glossaryEntry.test(paragraphs[i])) cut = i;
    else if (cut < paragraphs.length) break; // reached real prose again
  }
  const body = paragraphs.slice(0, cut).join('\n\n');

  // The page writes these URLs inside HTML-encoded quotes (&quot;), so the
  // match must stop at & as well -- otherwise it runs on into the next
  // JSON field and produces a URL that 404s.
  const mp3s = [...new Set(html.match(/https:\/\/[^\s"'&<>\\]+\.mp3/g) || [])];
  const audio = mp3s.find((u) => u.includes('_hq.')) || mp3s[0] || '';

  const date = (html.match(/"datePublished"\s*:\s*"([^"]+)"/) ||
    html.match(/pub_date:"([^"]+)"/) || [])[1] || '';

  if (!title || !body || !audio) return null;
  if (body.split(/\s+/).length < 150) return null; // too short to practise on

  const segment = openingSegment(body);

  return {
    // VOA Learning English sits at roughly CEFR B1 across these categories,
    // which also matches the project's starting level. The web app adjusts
    // from here based on how the answers actually go.
    level: 'B1',
    source: 'voa_le',
    source_url: url,
    title,
    reading_text: body,
    audio_url: audio,
    // The audio is a straight reading of the article, so the practice segment
    // starts at zero -- which is a sentence boundary by definition, and saves
    // guessing where a later one falls without listening to the file.
    audio_start_sec: 0,
    audio_end_sec: SEGMENT_SECONDS,
    transcript: segment,
    word_count: body.split(/\s+/).length,
    published: date
  };
}

/** Practice segment length, within the 120-180s the spec allows. */
const SEGMENT_SECONDS = 180;

/** VOA Learning English is read deliberately slowly; this is about its pace. */
const WORDS_PER_MINUTE = 110;

/**
 * The transcript for the practice segment: the opening of the article, cut at
 * a sentence end near however many words fit in SEGMENT_SECONDS. Ending
 * mid-sentence would make the listening questions unanswerable from the text
 * the learner is given.
 */
function openingSegment(body) {
  const budget = Math.round((SEGMENT_SECONDS / 60) * WORDS_PER_MINUTE);
  const words = body.split(/\s+/);
  if (words.length <= budget) return body;

  const rough = words.slice(0, budget).join(' ');
  const lastStop = Math.max(
    rough.lastIndexOf('. '),
    rough.lastIndexOf('." '),
    rough.lastIndexOf('? '),
    rough.lastIndexOf('! ')
  );
  return lastStop > rough.length * 0.5 ? rough.slice(0, lastStop + 1) : rough;
}

function parseArgs(argv) {
  const args = { count: 10, pages: 6, out: 'materials.json' };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    if (key === 'count' || key === 'pages') args[key] = parseInt(value, 10);
    else if (key === 'out') args.out = value;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`目標 ${args.count} 篇，每個分類最多翻 ${args.pages} 頁`);

  const links = [];
  for (const zone of ZONES) {
    for (let page = 1; page <= args.pages; page++) {
      if (links.length >= args.count * 2) break;
      try {
        const found = await collectLinks(zone.id, page);
        if (!found.length) break;
        for (const url of found) if (!links.includes(url)) links.push(url);
        console.log(`  ${zone.name} 第 ${page} 頁：+${found.length}（累計 ${links.length}）`);
      } catch (err) {
        console.log(`  ${zone.name} 第 ${page} 頁失敗：${err.message}`);
        break;
      }
      await sleep(DELAY_MS);
    }
  }

  console.log(`\n收集到 ${links.length} 個文章連結，開始逐篇抓取內容`);

  const materials = [];
  const skipped = [];
  for (const url of links) {
    if (materials.length >= args.count) break;
    try {
      const article = await fetchArticle(url);
      if (article) {
        materials.push(article);
        console.log(`  [${materials.length}/${args.count}] ${article.word_count} 字 - ${article.title.slice(0, 50)}`);
      } else {
        skipped.push(url);
      }
    } catch (err) {
      skipped.push(url);
    }
    await sleep(DELAY_MS);
  }

  const outPath = path.resolve(args.out);
  fs.writeFileSync(outPath, JSON.stringify(materials, null, 2), 'utf8');
  console.log(`\n完成：${materials.length} 篇寫入 ${outPath}`);
  if (skipped.length) console.log(`略過 ${skipped.length} 篇（非文章頁、缺音檔或內文過短）`);
}

main().catch((err) => {
  console.error('失敗：' + err.message);
  process.exit(1);
});
