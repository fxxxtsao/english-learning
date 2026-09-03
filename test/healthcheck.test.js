'use strict';

// Tests for tools/healthcheck.js: batch health-check over the `lessons`
// fixture. Verifies it (a) surfaces every one of the 7 known-bad fixture
// rows with the right error code, and (b) computes correct numbers for
// every metric in docs/specs/2026-09-02-content-pipeline.md's "驗收查詢".

var test = require('node:test');
var assert = require('node:assert');
var path = require('node:path');

var Contract = require('../js/contract.js');
var Healthcheck = require('../tools/healthcheck.js');

var FIXTURE_PATH = path.join(__dirname, 'fixtures', 'lessons-rows.json');

// Pin "now" to a fixed instant so date-dependent metrics (30-day supply
// rate, 24h audio-backfill window) are deterministic regardless of when the
// test suite actually runs. All fixture dates (2026-08-18 .. 2026-08-29)
// sit well inside a 30-day window ending here, and well past 24h before it.
var FIXED_NOW = new Date('2026-09-02T00:00:00Z');

function loadReport() {
  var rows = Healthcheck.loadRowsFromFile(FIXTURE_PATH);
  var records = Healthcheck.buildRecordsFromRows(rows);
  return Healthcheck.computeReport(records, { now: FIXED_NOW, source: FIXTURE_PATH });
}

function metric(report, key) {
  var found = report.metrics.filter(function (m) { return m.key === key; })[0];
  assert.ok(found, 'metric "' + key + '" should exist in report');
  return found;
}

function issuesWithCode(report, code) {
  return report.issues.filter(function (i) { return i.code === code; });
}

// ---------------------------------------------------------------------
// Loading / flattening the fixture
// ---------------------------------------------------------------------

test('loadRowsFromFile flattens the {good, bad, material} fixture into 11 raw rows', function () {
  var rows = Healthcheck.loadRowsFromFile(FIXTURE_PATH);
  assert.strictEqual(rows.length, 11); // 3 good + 7 bad + 1 material
});

test('buildRecordsFromRows produces one record per row, in order', function () {
  var rows = Healthcheck.loadRowsFromFile(FIXTURE_PATH);
  var records = Healthcheck.buildRecordsFromRows(rows);
  assert.strictEqual(records.length, 11);
});

// ---------------------------------------------------------------------
// All 7 known-bad rows must be caught, with the right error code
// ---------------------------------------------------------------------

test('healthcheck catches all 7 known-bad fixture rows with the expected error code', function () {
  var report = loadReport();

  assert.ok(issuesWithCode(report, Contract.ERRORS.BAD_JSON).length >= 1, 'bad_json not caught');
  assert.ok(issuesWithCode(report, Contract.ERRORS.MISSING_FIELD).length >= 1, 'missing_transcript not caught');
  assert.ok(issuesWithCode(report, Contract.ERRORS.ROW_TOO_SHORT).length >= 1, 'row_too_short not caught');
  assert.ok(issuesWithCode(report, Contract.ERRORS.BAD_OPTION_COUNT).length >= 1, 'bad_option_count not caught');
  assert.ok(issuesWithCode(report, Contract.ERRORS.BAD_ANSWER_INDEX).length >= 1, 'bad_answer_index not caught');
  assert.ok(issuesWithCode(report, Contract.ERRORS.VOCAB_NOT_IN_TEXT).length >= 1, 'vocab_not_in_text not caught');
  assert.ok(issuesWithCode(report, Contract.ERRORS.BAD_AUDIO_SEGMENT).length >= 1, 'bad_audio_segment not caught');
});

test('the 3 good fixture rows produce no parse or validate errors at all', function () {
  var report = loadReport();
  var goodLocations = ['2026-08-25', '2026-08-27', '2026-08-29'];
  var issuesOnGoodRows = report.issues.filter(function (i) {
    return goodLocations.indexOf(i.location) !== -1;
  });
  assert.deepStrictEqual(issuesOnGoodRows, []);
});

test('row counts: 11 total, 7 parsed into a lesson, 1 material row, 3 structurally broken', function () {
  var report = loadReport();
  assert.strictEqual(report.total_rows, 11);
  assert.strictEqual(report.parsed_rows, 7);
  assert.strictEqual(report.material_rows, 1);
  assert.strictEqual(report.broken_rows, 3);
});

// ---------------------------------------------------------------------
// Material rows (lesson_id empty, source_url + reading_text filled in --
// normal inventory produced by tools/fetch-materials.js, not corruption).
// See docs/specs/2026-09-02-content-pipeline.md, "空值語意有三種".
// ---------------------------------------------------------------------

test('the 1 material fixture row produces no parse or validate errors either', function () {
  var report = loadReport();
  var materialIssues = report.issues.filter(function (i) {
    return i.location.indexOf('ai-tutors-help-students-focus') !== -1;
  });
  assert.deepStrictEqual(materialIssues, []);
});

test('material_inventory metric: 1 material row in the fixture, always status OK (informational, not a quality gate)', function () {
  var report = loadReport();
  var m = metric(report, 'material_inventory');
  assert.strictEqual(m.data.material_count, 1);
  assert.strictEqual(m.status, 'OK');
  assert.ok(m.detail.indexOf('1') !== -1 && m.detail.indexOf('尚未出題') !== -1, m.detail);
});

test('required_field_empty_rate and json_parse_rate denominators exclude material rows (regression: a material row must not be treated as a row with 5 empty required fields)', function () {
  // Isolated from the shared fixture on purpose: one lesson-less material row
  // only, so any leak of material rows into these denominators would show up
  // immediately as a non-zero total_slots instead of the correct 0.
  var rows = [require(FIXTURE_PATH).material[0]];
  var records = Healthcheck.buildRecordsFromRows(rows);
  var report = Healthcheck.computeReport(records, { now: FIXED_NOW, source: 'material-only' });
  assert.strictEqual(metric(report, 'required_field_empty_rate').data.total_slots, 0);
  assert.strictEqual(metric(report, 'json_parse_rate').data.total_slots, 0);
  assert.strictEqual(report.material_rows, 1);
  assert.strictEqual(report.broken_rows, 0);
  assert.strictEqual(report.issues.length, 0);
});

test('dedupe_source_url still catches a material row that reuses a source_url already used by a real lesson', function () {
  var goodRow = require(FIXTURE_PATH).good[0]; // source_url: .../solar-power-helps-kenyan-farmers/7214563.html
  var materialRow = require(FIXTURE_PATH).material[0].slice();
  materialRow[3] = goodRow[3]; // reuse the good row's source_url
  var records = Healthcheck.buildRecordsFromRows([goodRow, materialRow]);
  var report = Healthcheck.computeReport(records, { now: FIXED_NOW, source: 'dedupe-check' });
  var m = metric(report, 'dedupe_source_url');
  assert.strictEqual(m.data.duplicate_groups, 1);
  assert.strictEqual(m.status, 'FAIL');
  var dupIssues = issuesWithCode(report, Contract.ERRORS.DUPLICATE_SOURCE_URL);
  assert.strictEqual(dupIssues.length, 1);
  assert.ok(dupIssues[0].message.indexOf('2 次') !== -1, dupIssues[0].message);
});

// ---------------------------------------------------------------------
// Per-metric numbers
// ---------------------------------------------------------------------

test('daily_row_count: 7 distinct days, no day has more than 1 row', function () {
  var report = loadReport();
  var m = metric(report, 'daily_row_count');
  assert.strictEqual(m.data.distinct_days, 7);
  assert.strictEqual(m.data.max_daily_count, 1);
  assert.strictEqual(m.data.anomaly_days, 0);
  assert.strictEqual(m.status, 'OK');
});

test('supply_30d: all 7 usable lesson days fall inside the 30-day window ending at FIXED_NOW', function () {
  var report = loadReport();
  var m = metric(report, 'supply_30d');
  assert.strictEqual(m.data.days_with_content, 7);
  // 7 < 20, so this is expected to read FAIL against the fixture's tiny sample.
  assert.strictEqual(m.status, 'FAIL');
});

test('dedupe_lesson_id: zero duplicate lesson_id groups', function () {
  var report = loadReport();
  var m = metric(report, 'dedupe_lesson_id');
  assert.strictEqual(m.data.duplicate_groups, 0);
  assert.strictEqual(m.status, 'OK');
});

test('dedupe_source_url: exactly 1 duplicate group (5 rows intentionally reuse the same source_url fixture text)', function () {
  var report = loadReport();
  var m = metric(report, 'dedupe_source_url');
  assert.strictEqual(m.data.duplicate_groups, 1);
  assert.strictEqual(m.status, 'FAIL');
  var dupIssues = issuesWithCode(report, Contract.ERRORS.DUPLICATE_SOURCE_URL);
  assert.strictEqual(dupIssues.length, 1);
  assert.ok(dupIssues[0].message.indexOf('5 次') !== -1, dupIssues[0].message);
});

test('required_field_empty_rate: exactly 1 empty required field (the missing transcript), row_too_short excluded from the denominator', function () {
  var report = loadReport();
  var m = metric(report, 'required_field_empty_rate');
  // 10 rows total, 1 is ROW_TOO_SHORT -> 9 rows * 14 required fields (excludes audio_file_id)
  assert.strictEqual(m.data.total_slots, 9 * (Contract.LESSON_COLUMNS.length - 1));
  assert.strictEqual(m.data.empty_count, 1);
  assert.strictEqual(m.status, 'FAIL');
});

test('json_parse_rate: 1 failure (bad_json) out of rows that reached JSON parsing', function () {
  var report = loadReport();
  var m = metric(report, 'json_parse_rate');
  // 10 rows - 1 ROW_TOO_SHORT - 1 MISSING_FIELD = 8 rows reached JSON parsing, * 3 fields = 24 slots
  assert.strictEqual(m.data.total_slots, 24);
  assert.strictEqual(m.data.ok_count, 23);
  assert.strictEqual(m.status, 'FAIL');
});

test('question_structure_rate: 12/14 (reading_questions, listening_questions) pairs pass structure checks', function () {
  var report = loadReport();
  var m = metric(report, 'question_structure_rate');
  // 7 parsed lessons * 2 fields = 14 pairs; bad_option_count and bad_answer_index each break 1 field
  assert.strictEqual(m.data.total_pairs, 14);
  assert.strictEqual(m.data.ok_count, 12);
  assert.strictEqual(m.status, 'FAIL');
});

test('vocab_term_rate: exactly 1 vocab entry (elephant) not found in source text', function () {
  var report = loadReport();
  var m = metric(report, 'vocab_term_rate');
  assert.strictEqual(m.data.total_terms - m.data.ok_count, 1);
  assert.strictEqual(m.status, 'FAIL');
});

test('audio_segment_rate: 6/7 parsed lessons have a valid 120-180s segment', function () {
  var report = loadReport();
  var m = metric(report, 'audio_segment_rate');
  assert.strictEqual(m.data.total_lessons, 7);
  assert.strictEqual(m.data.ok_count, 6);
  assert.strictEqual(m.status, 'FAIL');
});

test('audio_backfill_rate: 1/7 parsed lessons (all written >24h before FIXED_NOW) have audio_file_id filled', function () {
  var report = loadReport();
  var m = metric(report, 'audio_backfill_rate');
  assert.strictEqual(m.data.eligible_count, 7);
  assert.strictEqual(m.data.filled_count, 1);
  assert.strictEqual(m.status, 'FAIL');
});

// ---------------------------------------------------------------------
// Overall ok flag / exit-code source
// ---------------------------------------------------------------------

test('report.ok is false when any metric is FAIL (fixture has several)', function () {
  var report = loadReport();
  assert.strictEqual(report.ok, false);
});

test('a report built from only the 3 good rows is fully ok', function () {
  var fixtures = require(FIXTURE_PATH);
  var records = Healthcheck.buildRecordsFromRows(fixtures.good);
  var report = Healthcheck.computeReport(records, { now: FIXED_NOW, source: 'good-only' });
  assert.strictEqual(report.issues.length, 0);
  // supply_30d is sample-size dependent (3 days < 20) and expected to FAIL on
  // a 3-row sample; audio_backfill_rate reflects the fixture's own realistic
  // state (only 1 of the 3 good rows has audio_file_id filled in). Every
  // other metric should read OK on all-good, non-duplicate data.
  var sampleSizeDependent = ['supply_30d', 'audio_backfill_rate'];
  report.metrics.forEach(function (m) {
    if (sampleSizeDependent.indexOf(m.key) !== -1) return;
    assert.strictEqual(m.status, 'OK', m.key + ' expected OK, got ' + m.status + ': ' + m.detail);
  });
});

// ---------------------------------------------------------------------
// Apps Script HTTP source path (buildRecordsFromApiResponse / buildLessonsUrl)
// ---------------------------------------------------------------------

test('buildLessonsUrl appends action=lessons while preserving an existing token', function () {
  var url = Healthcheck.buildLessonsUrl('https://script.google.com/macros/s/abc/exec?token=xyz');
  var parsed = new URL(url);
  assert.strictEqual(parsed.searchParams.get('token'), 'xyz');
  assert.strictEqual(parsed.searchParams.get('action'), Contract.ACTIONS.LESSONS);
});

test('buildLessonsUrl leaves an explicit action untouched', function () {
  var url = Healthcheck.buildLessonsUrl('https://script.google.com/macros/s/abc/exec?token=xyz&action=lessons&since=2026-01-01');
  var parsed = new URL(url);
  assert.strictEqual(parsed.searchParams.get('action'), 'lessons');
  assert.strictEqual(parsed.searchParams.get('since'), '2026-01-01');
});

test('buildRecordsFromApiResponse turns pre-parsed lessons + tagged fatal errors into records', function () {
  var fixtures = require(FIXTURE_PATH);
  var goodParsed = Healthcheck.buildRecordsFromRows([fixtures.good[0]])[0].lesson;

  var body = {
    ok: true,
    lessons: [goodParsed],
    errors: [
      { row: 5, lesson_id: '2026-08-18', errors: [Contract.makeError(Contract.ERRORS.BAD_JSON, 'reading_questions', 'boom')] }
    ]
  };

  var records = Healthcheck.buildRecordsFromApiResponse(body);
  assert.strictEqual(records.length, 2);

  var okRecord = records.filter(function (r) { return r.lesson !== null; })[0];
  assert.strictEqual(okRecord.location, '2026-08-25');
  assert.deepStrictEqual(okRecord.validateErrors, []); // validateLesson is run here, not server-side

  var fatalRecord = records.filter(function (r) { return r.lesson === null; })[0];
  assert.strictEqual(fatalRecord.location, '2026-08-18');
  assert.strictEqual(fatalRecord.parseErrors[0].code, Contract.ERRORS.BAD_JSON);
});

// ---------------------------------------------------------------------
// Human report formatting
// ---------------------------------------------------------------------

test('formatHumanReport includes an OK/FAIL line per metric and a problem list', function () {
  var report = loadReport();
  var text = Healthcheck.formatHumanReport(report);
  report.metrics.forEach(function (m) {
    assert.ok(text.indexOf('[' + m.status + '] ' + m.label) !== -1, 'missing line for ' + m.key);
  });
  assert.ok(text.indexOf('問題清單') !== -1);
});
