#!/usr/bin/env node
/**
 * Builds apps-script/Shared.gs from js/contract.js + js/lesson.js.
 *
 * Google Apps Script has no module system, so the shared contract and the
 * lesson parser have to be pasted into the script project by hand. Doing
 * that by hand drifts silently; this script concatenates the real files so
 * the copy is always byte-identical to the source, and
 * test/shared-sync.test.js fails if Shared.gs is stale.
 *
 * Run:  node tools/build-shared.js
 * Check: node --test test/shared-sync.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const SOURCES = ['js/contract.js', 'js/lesson.js'];
const TARGET = 'apps-script/Shared.gs';

const BANNER = [
  '/**',
  ' * GENERATED FILE - DO NOT EDIT BY HAND.',
  ' *',
  ' * Built by tools/build-shared.js from:',
  ...SOURCES.map((s) => ` *   - ${s}`),
  ' *',
  ' * Apps Script has no import/require, so the shared contract and parser',
  ' * are concatenated here. Edit the source files, re-run the builder, then',
  ' * paste this whole file into the Apps Script project as Shared.gs.',
  ' */',
  ''
].join('\n');

/**
 * Apps Script code (Code.gs, AudioFetcher.gs) calls these as plain globals,
 * which is the Apps Script convention. The UMD modules only expose them under
 * their namespace objects, so bridge the two here rather than making every
 * call site carry a prefix.
 */
const GLOBAL_ALIASES = `
// ---------------------------------------------------------------------------
// Global aliases for Apps Script call sites.
// Apps Script code addresses these as bare globals; the UMD wrappers above
// only mount namespace objects (Contract, Lesson) on globalThis.
// ---------------------------------------------------------------------------

function parseLessonRow(row) {
  return Lesson.parseLessonRow(row);
}

function validateLesson(lesson) {
  return Lesson.validateLesson(lesson);
}
`;

function build() {
  const parts = [BANNER];

  for (const rel of SOURCES) {
    const abs = path.join(ROOT, rel);
    const code = fs.readFileSync(abs, 'utf8');
    parts.push(`// ===== BEGIN ${rel} =====`);
    parts.push(code.trimEnd());
    parts.push(`// ===== END ${rel} =====`);
    parts.push('');
  }

  parts.push(GLOBAL_ALIASES.trim());
  parts.push('');

  return parts.join('\n');
}

/** Exported so the sync test can rebuild in memory and compare. */
function expectedContent() {
  return build();
}

if (require.main === module) {
  const out = path.join(ROOT, TARGET);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, build(), 'utf8');
  console.log(`已產生 ${TARGET}（來源：${SOURCES.join(', ')}）`);
}

module.exports = { expectedContent, SOURCES, TARGET };
