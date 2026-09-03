/**
 * Guards the hand-copied Apps Script bundle against drift.
 *
 * apps-script/Shared.gs is a generated concatenation of js/contract.js and
 * js/lesson.js (see tools/build-shared.js). If someone edits a source file
 * and forgets to rebuild, the Apps Script side silently runs old validation
 * logic while the web side runs the new one -- exactly the two-sided drift
 * the spec warns about. This test makes that failure loud and immediate.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { expectedContent, TARGET } = require('../tools/build-shared.js');

const targetPath = path.resolve(__dirname, '..', TARGET);

test('Shared.gs exists', () => {
  assert.ok(
    fs.existsSync(targetPath),
    `${TARGET} is missing. Run: node tools/build-shared.js`
  );
});

test('Shared.gs is up to date with its sources', () => {
  const actual = fs.readFileSync(targetPath, 'utf8');
  assert.equal(
    actual,
    expectedContent(),
    `${TARGET} is stale. Run: node tools/build-shared.js`
  );
});

test('Shared.gs exposes the globals Apps Script code calls', () => {
  const actual = fs.readFileSync(targetPath, 'utf8');
  assert.match(actual, /function parseLessonRow\(row\)/);
  assert.match(actual, /function validateLesson\(lesson\)/);
});

test('Shared.gs carries no module-system syntax Apps Script cannot run', () => {
  const actual = fs.readFileSync(targetPath, 'utf8');
  // `require(` and `module.exports` do appear inside the UMD wrappers, but
  // only behind a `typeof module !== 'undefined'` guard, so they never run
  // under Apps Script. Bare ES module syntax would be a hard parse error.
  assert.doesNotMatch(actual, /^\s*import\s/m, 'ES import found');
  assert.doesNotMatch(actual, /^\s*export\s/m, 'ES export found');
});
