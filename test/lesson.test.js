'use strict';

// Tests for js/lesson.js: Sheets row parsing (parseLessonRow) and content
// validation (validateLesson). See docs/specs/2026-09-02-content-pipeline.md,
// "測試決策", for the seam these two functions are meant to cover.

var test = require('node:test');
var assert = require('node:assert');
var path = require('node:path');

var Contract = require('../js/contract.js');
var Lesson = require('../js/lesson.js');
var fixtures = require(path.join('..', 'test', 'fixtures', 'lessons-rows.json'));

function errorCodes(errors) {
  return errors.map(function (e) { return e.code; });
}

// ---------------------------------------------------------------------
// Good rows
// ---------------------------------------------------------------------

test('parseLessonRow parses every good fixture row into a lesson with no errors', function () {
  fixtures.good.forEach(function (row, i) {
    var result = Lesson.parseLessonRow(row);
    assert.notStrictEqual(result.lesson, null, 'good row ' + i + ' should parse to a lesson');
    assert.deepStrictEqual(result.errors, [], 'good row ' + i + ' should have no parse errors');
  });
});

test('validateLesson returns no errors for every good fixture row', function () {
  fixtures.good.forEach(function (row, i) {
    var parsed = Lesson.parseLessonRow(row);
    var errors = Lesson.validateLesson(parsed.lesson);
    assert.deepStrictEqual(errors, [], 'good row ' + i + ' should validate cleanly, got: ' + JSON.stringify(errors));
  });
});

test('parseLessonRow converts audio_start_sec / audio_end_sec to integers', function () {
  var parsed = Lesson.parseLessonRow(fixtures.good[0]);
  assert.strictEqual(typeof parsed.lesson.audio_start_sec, 'number');
  assert.strictEqual(typeof parsed.lesson.audio_end_sec, 'number');
});

test('parseLessonRow parses the JSON columns into objects/arrays, not strings', function () {
  var parsed = Lesson.parseLessonRow(fixtures.good[0]);
  assert.ok(Array.isArray(parsed.lesson.reading_questions));
  assert.ok(Array.isArray(parsed.lesson.listening_questions));
  assert.ok(Array.isArray(parsed.lesson.vocab));
});

// ---------------------------------------------------------------------
// Google Sheets auto-converted Date cells (lesson_id / generated_at)
// ---------------------------------------------------------------------

test('parseLessonRow converts a Date-object lesson_id (Sheets auto-conversion) to YYYY-MM-DD using LOCAL date parts, not UTC', function () {
  var row = fixtures.good[0].slice();
  // A date-only Sheets cell comes back as local midnight of that day.
  var localMidnight = new Date(2026, 7, 25); // 2026-08-25, local time (month is 0-indexed)
  row[0] = localMidnight;

  var parsed = Lesson.parseLessonRow(row);
  assert.notStrictEqual(parsed.lesson, null, 'row should still parse: ' + JSON.stringify(parsed.errors));
  assert.strictEqual(parsed.lesson.lesson_id, '2026-08-25');
  assert.ok(Lesson.validateLesson(parsed.lesson).every(function (e) { return e.code !== Contract.ERRORS.BAD_LESSON_ID; }));
});

test('parseLessonRow converts a Date-object generated_at (Sheets auto-conversion) to a valid ISO8601 string', function () {
  var row = fixtures.good[0].slice();
  row[13] = new Date('2026-08-25T09:12:00Z');

  var parsed = Lesson.parseLessonRow(row);
  assert.notStrictEqual(parsed.lesson, null, 'row should still parse: ' + JSON.stringify(parsed.errors));
  assert.strictEqual(typeof parsed.lesson.generated_at, 'string');
  assert.ok(Lesson.validateLesson(parsed.lesson).every(function (e) { return e.code !== Contract.ERRORS.BAD_TIMESTAMP; }));
});

test('parseLessonRow does not lose a lesson to a Sheets-converted Date lesson_id (regression: String(Date) used to fail isValidLessonId and corrupt itemId parsing)', function () {
  var row = fixtures.good[0].slice();
  row[0] = new Date(2026, 8, 2); // 2026-09-02, local time -- String(Date) would contain colons (e.g. "00:00:00")
  var parsed = Lesson.parseLessonRow(row);
  assert.notStrictEqual(parsed.lesson, null);
  // A malformed lesson_id like "Wed Sep 02 2026 00:00:00 GMT+0800" contains
  // colons, which would make Contract.itemId(lessonId, type, idx).split(':')
  // produce more than 3 parts downstream in app.js. Guard that here too.
  assert.strictEqual(parsed.lesson.lesson_id.split(':').length, 1);
  assert.strictEqual(parsed.lesson.lesson_id, '2026-09-02');
});

// ---------------------------------------------------------------------
// audio_start_sec / audio_end_sec that parseInt cannot make sense of
// ---------------------------------------------------------------------

test('bad_audio_number: a non-numeric audio_start_sec is fatal (BAD_AUDIO_SEGMENT, lesson null), not a silent NaN', function () {
  var row = fixtures.good[0].slice();
  row[8] = 'not-a-number'; // audio_start_sec
  var parsed = Lesson.parseLessonRow(row);
  assert.strictEqual(parsed.lesson, null);
  assert.ok(errorCodes(parsed.errors).indexOf(Contract.ERRORS.BAD_AUDIO_SEGMENT) !== -1, JSON.stringify(parsed.errors));
  var flagged = parsed.errors.filter(function (e) { return e.field === 'audio_start_sec'; });
  assert.strictEqual(flagged.length, 1);
});

test('bad_audio_number: a non-numeric audio_end_sec is fatal (BAD_AUDIO_SEGMENT, lesson null), not a silent NaN', function () {
  var row = fixtures.good[0].slice();
  row[9] = 'oops'; // audio_end_sec
  var parsed = Lesson.parseLessonRow(row);
  assert.strictEqual(parsed.lesson, null);
  assert.ok(errorCodes(parsed.errors).indexOf(Contract.ERRORS.BAD_AUDIO_SEGMENT) !== -1, JSON.stringify(parsed.errors));
  var flagged = parsed.errors.filter(function (e) { return e.field === 'audio_end_sec'; });
  assert.strictEqual(flagged.length, 1);
});

// ---------------------------------------------------------------------
// Bad rows: fatal cases (parseLessonRow returns lesson: null)
// ---------------------------------------------------------------------

test('bad_json: malformed JSON in reading_questions is fatal (BAD_JSON, lesson null)', function () {
  var result = Lesson.parseLessonRow(fixtures.bad.bad_json);
  assert.strictEqual(result.lesson, null);
  assert.ok(errorCodes(result.errors).indexOf(Contract.ERRORS.BAD_JSON) !== -1, JSON.stringify(result.errors));
});

test('missing_transcript: empty required column is fatal (MISSING_FIELD, lesson null)', function () {
  var result = Lesson.parseLessonRow(fixtures.bad.missing_transcript);
  assert.strictEqual(result.lesson, null);
  assert.ok(errorCodes(result.errors).indexOf(Contract.ERRORS.MISSING_FIELD) !== -1, JSON.stringify(result.errors));
  var transcriptError = result.errors.filter(function (e) { return e.field === 'transcript'; });
  assert.strictEqual(transcriptError.length, 1);
});

test('row_too_short: a row with fewer than 15 cells is fatal (ROW_TOO_SHORT, lesson null)', function () {
  var result = Lesson.parseLessonRow(fixtures.bad.row_too_short);
  assert.strictEqual(result.lesson, null);
  assert.ok(errorCodes(result.errors).indexOf(Contract.ERRORS.ROW_TOO_SHORT) !== -1, JSON.stringify(result.errors));
});

// ---------------------------------------------------------------------
// Bad rows: non-fatal cases (parseLessonRow still returns a lesson;
// validateLesson is what flags the problem)
// ---------------------------------------------------------------------

test('bad_option_count: a question with 3 options still parses, validateLesson flags BAD_OPTION_COUNT', function () {
  var parsed = Lesson.parseLessonRow(fixtures.bad.bad_option_count);
  assert.notStrictEqual(parsed.lesson, null);
  assert.deepStrictEqual(parsed.errors, []);
  var errors = Lesson.validateLesson(parsed.lesson);
  assert.ok(errorCodes(errors).indexOf(Contract.ERRORS.BAD_OPTION_COUNT) !== -1, JSON.stringify(errors));
});

test('bad_answer_index: answer_index of 4 still parses, validateLesson flags BAD_ANSWER_INDEX', function () {
  var parsed = Lesson.parseLessonRow(fixtures.bad.bad_answer_index);
  assert.notStrictEqual(parsed.lesson, null);
  assert.deepStrictEqual(parsed.errors, []);
  var errors = Lesson.validateLesson(parsed.lesson);
  assert.ok(errorCodes(errors).indexOf(Contract.ERRORS.BAD_ANSWER_INDEX) !== -1, JSON.stringify(errors));
});

test('vocab_not_in_text: a vocab term absent from the source text still parses, validateLesson flags VOCAB_NOT_IN_TEXT', function () {
  var parsed = Lesson.parseLessonRow(fixtures.bad.vocab_not_in_text);
  assert.notStrictEqual(parsed.lesson, null);
  assert.deepStrictEqual(parsed.errors, []);
  var errors = Lesson.validateLesson(parsed.lesson);
  assert.ok(errorCodes(errors).indexOf(Contract.ERRORS.VOCAB_NOT_IN_TEXT) !== -1, JSON.stringify(errors));
  var flagged = errors.filter(function (e) { return e.code === Contract.ERRORS.VOCAB_NOT_IN_TEXT; });
  assert.ok(flagged.some(function (e) { return e.message.indexOf('elephant') !== -1; }));
});

test('bad_audio_segment: a 40-second segment still parses, validateLesson flags BAD_AUDIO_SEGMENT', function () {
  var parsed = Lesson.parseLessonRow(fixtures.bad.bad_audio_segment);
  assert.notStrictEqual(parsed.lesson, null);
  assert.deepStrictEqual(parsed.errors, []);
  assert.strictEqual(parsed.lesson.audio_end_sec - parsed.lesson.audio_start_sec, 40);
  var errors = Lesson.validateLesson(parsed.lesson);
  assert.ok(errorCodes(errors).indexOf(Contract.ERRORS.BAD_AUDIO_SEGMENT) !== -1, JSON.stringify(errors));
});

// ---------------------------------------------------------------------
// Material rows (lesson_id empty, source_url + reading_text filled in --
// normal inventory from tools/fetch-materials.js, not a corrupted row).
// See docs/specs/2026-09-02-content-pipeline.md, "空值語意有三種".
// ---------------------------------------------------------------------

test('parseLessonRow recognizes the material fixture row: lesson null, no errors, kind "material"', function () {
  var parsed = Lesson.parseLessonRow(fixtures.material[0]);
  assert.strictEqual(parsed.lesson, null);
  assert.deepStrictEqual(parsed.errors, []);
  assert.strictEqual(parsed.kind, 'material');
  assert.ok(parsed.material, 'a material row should carry a `material` payload');
  assert.strictEqual(parsed.material.source_url, fixtures.material[0][3]);
  assert.strictEqual(parsed.material.reading_text, fixtures.material[0][5]);
});

test('a good fixture row parses with kind "lesson"', function () {
  var parsed = Lesson.parseLessonRow(fixtures.good[0]);
  assert.strictEqual(parsed.kind, 'lesson');
});

test('a fatally broken row (e.g. row_too_short) parses with kind "broken", never "material"', function () {
  var parsed = Lesson.parseLessonRow(fixtures.bad.row_too_short);
  assert.strictEqual(parsed.lesson, null);
  assert.strictEqual(parsed.kind, 'broken');
});

test('a row missing both lesson_id and source_url is a real MISSING_FIELD failure, not a material row', function () {
  var row = fixtures.good[0].slice();
  row[0] = ''; // lesson_id
  row[3] = ''; // source_url
  var parsed = Lesson.parseLessonRow(row);
  assert.strictEqual(parsed.lesson, null);
  assert.notStrictEqual(parsed.kind, 'material');
  assert.strictEqual(parsed.kind, 'broken');
  assert.ok(errorCodes(parsed.errors).indexOf(Contract.ERRORS.MISSING_FIELD) !== -1, JSON.stringify(parsed.errors));
});

test('a row with lesson_id empty and source_url present but reading_text empty is a real MISSING_FIELD failure, not a material row', function () {
  var row = fixtures.good[0].slice();
  row[0] = ''; // lesson_id
  row[5] = ''; // reading_text
  var parsed = Lesson.parseLessonRow(row);
  assert.strictEqual(parsed.lesson, null);
  assert.notStrictEqual(parsed.kind, 'material');
  assert.ok(errorCodes(parsed.errors).indexOf(Contract.ERRORS.MISSING_FIELD) !== -1, JSON.stringify(parsed.errors));
});

test('Lesson.isMaterialRow is exported and matches the same rule directly on a lesson-shaped object', function () {
  assert.strictEqual(typeof Lesson.isMaterialRow, 'function');
  assert.strictEqual(Lesson.isMaterialRow({ lesson_id: '', source_url: 'https://x', reading_text: 'text' }), true);
  assert.strictEqual(Lesson.isMaterialRow({ lesson_id: '2026-08-01', source_url: 'https://x', reading_text: 'text' }), false);
  assert.strictEqual(Lesson.isMaterialRow({ lesson_id: '', source_url: '', reading_text: 'text' }), false);
  assert.strictEqual(Lesson.isMaterialRow({ lesson_id: '', source_url: 'https://x', reading_text: '' }), false);
  assert.strictEqual(Lesson.isMaterialRow(null), false);
});

// ---------------------------------------------------------------------
// Whole-batch resilience: no bad row may ever throw
// ---------------------------------------------------------------------

test('parsing and validating every fixture row (good and bad) in one batch never throws', function () {
  var rows = fixtures.good.concat(Object.keys(fixtures.bad).map(function (k) { return fixtures.bad[k]; }));
  var results = [];
  assert.doesNotThrow(function () {
    rows.forEach(function (row) {
      var parsed = Lesson.parseLessonRow(row);
      var errors = parsed.lesson ? Lesson.validateLesson(parsed.lesson) : [];
      results.push({ lesson: parsed.lesson, parseErrors: parsed.errors, validateErrors: errors });
    });
  });
  assert.strictEqual(results.length, rows.length);
});

test('parseLessonRow and validateLesson never throw on garbage input', function () {
  var garbageRows = [
    null,
    undefined,
    [],
    'not a row',
    42,
    {},
    [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null]
  ];
  garbageRows.forEach(function (row) {
    assert.doesNotThrow(function () {
      Lesson.parseLessonRow(row);
    });
  });

  var garbageLessons = [null, undefined, {}, 'x', 42, { vocab: 'not an array', reading_questions: null }];
  garbageLessons.forEach(function (lesson) {
    assert.doesNotThrow(function () {
      Lesson.validateLesson(lesson);
    });
  });
});

// ---------------------------------------------------------------------
// Vocab term morphology
// ---------------------------------------------------------------------

function lessonWithVocabAndText(term, text) {
  var q4 = [
    { prompt: 'p', options: ['a', 'b', 'c', 'd'], answer_index: 0, explanation: 'e' },
    { prompt: 'p', options: ['a', 'b', 'c', 'd'], answer_index: 0, explanation: 'e' },
    { prompt: 'p', options: ['a', 'b', 'c', 'd'], answer_index: 0, explanation: 'e' },
    { prompt: 'p', options: ['a', 'b', 'c', 'd'], answer_index: 0, explanation: 'e' }
  ];
  var q3 = [
    { prompt: 'p', options: ['a', 'b', 'c', 'd'], answer_index: 0, explanation: 'e' },
    { prompt: 'p', options: ['a', 'b', 'c', 'd'], answer_index: 0, explanation: 'e' },
    { prompt: 'p', options: ['a', 'b', 'c', 'd'], answer_index: 0, explanation: 'e' }
  ];
  return {
    lesson_id: '2026-08-01',
    level: 'B1',
    source: 'voa_le',
    reading_text: text,
    reading_questions: q4,
    audio_start_sec: 0,
    audio_end_sec: 150,
    transcript: 'placeholder transcript',
    listening_questions: q3,
    vocab: [{ term: term, pos: 'v', definition_en: 'x', definition_zh: 'x', example: 'x' }],
    generated_at: '2026-08-01T00:00:00Z'
  };
}

test('vocab term "develop" is matched by the inflected form "developed" in the source text', function () {
  var lesson = lessonWithVocabAndText('develop', 'The engineers developed a new device last year.');
  var errors = Lesson.validateLesson(lesson);
  assert.strictEqual(errorCodes(errors).indexOf(Contract.ERRORS.VOCAB_NOT_IN_TEXT), -1, JSON.stringify(errors));
});

test('vocab term "study" is matched by the inflected form "studies" in the source text', function () {
  var lesson = lessonWithVocabAndText('study', 'The research team studies market trends every quarter.');
  var errors = Lesson.validateLesson(lesson);
  assert.strictEqual(errorCodes(errors).indexOf(Contract.ERRORS.VOCAB_NOT_IN_TEXT), -1, JSON.stringify(errors));
});

test('vocab term genuinely absent from the text is flagged as VOCAB_NOT_IN_TEXT', function () {
  var lesson = lessonWithVocabAndText('elephant', 'The engineers developed a new device last year.');
  var errors = Lesson.validateLesson(lesson);
  assert.notStrictEqual(errorCodes(errors).indexOf(Contract.ERRORS.VOCAB_NOT_IN_TEXT), -1, JSON.stringify(errors));
});

test('vocab term "stop" is matched by the doubled-consonant inflected form "stopped" (regression: used to false-positive VOCAB_NOT_IN_TEXT)', function () {
  var lesson = lessonWithVocabAndText('stop', 'The train stopped suddenly at the station.');
  var errors = Lesson.validateLesson(lesson);
  assert.strictEqual(errorCodes(errors).indexOf(Contract.ERRORS.VOCAB_NOT_IN_TEXT), -1, JSON.stringify(errors));
});

test('vocab term "stop" is matched by the doubled-consonant inflected form "stopping"', function () {
  var lesson = lessonWithVocabAndText('stop', 'She kept stopping to take photos along the way.');
  var errors = Lesson.validateLesson(lesson);
  assert.strictEqual(errorCodes(errors).indexOf(Contract.ERRORS.VOCAB_NOT_IN_TEXT), -1, JSON.stringify(errors));
});

test('vocab term "run" is matched by the doubled-consonant inflected form "running"', function () {
  var lesson = lessonWithVocabAndText('run', 'He was running late for the morning meeting.');
  var errors = Lesson.validateLesson(lesson);
  assert.strictEqual(errorCodes(errors).indexOf(Contract.ERRORS.VOCAB_NOT_IN_TEXT), -1, JSON.stringify(errors));
});

test('a longer word that happens to end consonant-vowel-consonant (e.g. "develop") is not double-consonant inflected', function () {
  // Guards against the CVC-doubling rule over-firing on multi-syllable
  // words where English does not double the final consonant.
  var lesson = lessonWithVocabAndText('develop', 'The team developed something.');
  var errors = Lesson.validateLesson(lesson);
  assert.strictEqual(errorCodes(errors).indexOf(Contract.ERRORS.VOCAB_NOT_IN_TEXT), -1, JSON.stringify(errors));
});

// ---------------------------------------------------------------------
// Format checks (level / source / lesson_id / generated_at)
// ---------------------------------------------------------------------

test('validateLesson flags an invalid CEFR level', function () {
  var lesson = lessonWithVocabAndText('develop', 'The team developed something.');
  lesson.vocab = []; // avoid unrelated vocab-count noise in this targeted check
  lesson.level = 'Z9';
  var errors = Lesson.validateLesson(lesson);
  assert.ok(errorCodes(errors).indexOf(Contract.ERRORS.BAD_LEVEL) !== -1, JSON.stringify(errors));
});

test('validateLesson flags an unrecognized source', function () {
  var lesson = lessonWithVocabAndText('develop', 'The team developed something.');
  lesson.vocab = [];
  lesson.source = 'nytimes';
  var errors = Lesson.validateLesson(lesson);
  assert.ok(errorCodes(errors).indexOf(Contract.ERRORS.BAD_SOURCE) !== -1, JSON.stringify(errors));
});

test('validateLesson flags a malformed lesson_id', function () {
  var lesson = lessonWithVocabAndText('develop', 'The team developed something.');
  lesson.vocab = [];
  lesson.lesson_id = '08-01-2026';
  var errors = Lesson.validateLesson(lesson);
  assert.ok(errorCodes(errors).indexOf(Contract.ERRORS.BAD_LESSON_ID) !== -1, JSON.stringify(errors));
});

test('validateLesson rejects a lesson_id that is not a real calendar date', function () {
  var lesson = lessonWithVocabAndText('develop', 'The team developed something.');
  lesson.vocab = [];
  lesson.lesson_id = '2026-02-30';
  var errors = Lesson.validateLesson(lesson);
  assert.ok(errorCodes(errors).indexOf(Contract.ERRORS.BAD_LESSON_ID) !== -1, JSON.stringify(errors));
});

test('validateLesson flags a malformed generated_at timestamp', function () {
  var lesson = lessonWithVocabAndText('develop', 'The team developed something.');
  lesson.vocab = [];
  lesson.generated_at = 'not-a-timestamp';
  var errors = Lesson.validateLesson(lesson);
  assert.ok(errorCodes(errors).indexOf(Contract.ERRORS.BAD_TIMESTAMP) !== -1, JSON.stringify(errors));
});

test('validateLesson accepts a valid ISO8601 generated_at', function () {
  var lesson = lessonWithVocabAndText('develop', 'The team developed something.');
  lesson.vocab = [];
  lesson.generated_at = '2026-08-01T00:00:00.000Z';
  var errors = Lesson.validateLesson(lesson);
  assert.strictEqual(errorCodes(errors).indexOf(Contract.ERRORS.BAD_TIMESTAMP), -1, JSON.stringify(errors));
});
