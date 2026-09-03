#!/usr/bin/env node
'use strict';

/**
 * Daily health-check for the `lessons` sheet.
 *
 * Batch-scans every lesson row (from a local fixture-shaped JSON file, or by
 * calling the Apps Script Web App's `action=lessons` endpoint over HTTP) and
 * reports every automatable metric from the "驗收查詢" section of
 * docs/specs/2026-09-02-content-pipeline.md.
 *
 * Reuses js/contract.js and js/lesson.js (parseLessonRow / validateLesson)
 * as-is -- this file only aggregates their per-row output into batch
 * statistics and a report. It does not re-implement any parsing or
 * validation rule.
 *
 * Usage:
 *   node tools/healthcheck.js <local-json-file-or-apps-script-lessons-url> [--json]
 *
 * Exit code: 0 if every metric is OK, 1 if any metric is FAIL (or the run
 * itself errors out), so this can be wired into a scheduled alert later.
 */

var fs = require('fs');
var path = require('path');

var Contract = require('../js/contract.js');
var Lesson = require('../js/lesson.js');

// ---------------------------------------------------------------------
// Small generic helpers
// ---------------------------------------------------------------------

/** Parse error codes that mean the row never became a usable lesson object. */
var CRITICAL_CODES = [
  Contract.ERRORS.ROW_TOO_SHORT,
  Contract.ERRORS.MISSING_FIELD,
  Contract.ERRORS.BAD_JSON,
  Contract.ERRORS.NOT_AN_ARRAY,
  Contract.ERRORS.DUPLICATE_LESSON_ID,
  Contract.ERRORS.DUPLICATE_SOURCE_URL
];

function isCriticalCode(code) {
  return CRITICAL_CODES.indexOf(code) !== -1;
}

function pctStr(numerator, denominator, decimals) {
  if (!denominator) return 'N/A';
  var v = (numerator / denominator) * 100;
  return v.toFixed(decimals === undefined ? 1 : decimals) + '%';
}

function statusOkIf(cond) {
  return cond ? 'OK' : 'FAIL';
}

function groupBy(list, key) {
  var groups = {};
  list.forEach(function (item) {
    var k = item[key];
    if (k === undefined || k === null || k === '') return;
    if (!groups[k]) groups[k] = [];
    groups[k].push(item);
  });
  return groups;
}

/** All errors (parse + validate) attached to one record. */
function recordErrors(rec) {
  return [].concat(rec.parseErrors || [], rec.validateErrors || []);
}

function countCodeOccurrences(records, codes) {
  var n = 0;
  records.forEach(function (rec) {
    recordErrors(rec).forEach(function (e) {
      if (codes.indexOf(e.code) !== -1) n++;
    });
  });
  return n;
}

function recordHasAnyCode(rec, codes) {
  return recordErrors(rec).some(function (e) { return codes.indexOf(e.code) !== -1; });
}

function dateOnlyUTC(d) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function addDaysUTC(ms, days) {
  return ms + days * 86400000;
}

/** Returns a UTC day-timestamp for a YYYY-MM-DD string, or null if malformed. */
function parseYmdUTC(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// ---------------------------------------------------------------------
// Loading rows / building records
// ---------------------------------------------------------------------

/**
 * Reads a local JSON file and returns a flat array of raw sheet rows.
 * Accepts two shapes:
 *   - a plain 2D array of rows (as the `lessons` sheet's values look)
 *   - the {good: [...rows], bad: {key: row, ...}, material: [...rows]}
 *     shape used by the test fixture (test/fixtures/lessons-rows.json),
 *     flattened into one list. `material` is optional -- sample material
 *     rows (lesson_id empty, source_url + reading_text filled in).
 */
function loadRowsFromFile(filePath) {
  var raw = fs.readFileSync(filePath, 'utf8');
  var data = JSON.parse(raw);

  if (Array.isArray(data)) {
    return data;
  }

  if (data && typeof data === 'object') {
    var rows = [];
    if (Array.isArray(data.good)) {
      rows = rows.concat(data.good);
    }
    if (data.bad && typeof data.bad === 'object') {
      Object.keys(data.bad).forEach(function (k) {
        rows.push(data.bad[k]);
      });
    }
    if (Array.isArray(data.material)) {
      rows = rows.concat(data.material);
    }
    if (rows.length > 0) return rows;
  }

  throw new Error('無法辨識的 JSON 格式：' + filePath + '（需為二維陣列，或 {good, bad} 格式）');
}

/** Best-effort human-readable location label for a raw row that may be fatally broken or a material row (no lesson_id either way). */
function rowLabel(row, index, parsed) {
  if (parsed && parsed.lesson && parsed.lesson.lesson_id) return parsed.lesson.lesson_id;
  if (parsed && parsed.kind === 'material' && parsed.material && parsed.material.source_url) {
    return '（素材）' + parsed.material.source_url;
  }
  if (Array.isArray(row) && typeof row[0] === 'string' && row[0].trim() !== '') return row[0];
  return '第 ' + (index + 1) + ' 列';
}

/** Runs parseLessonRow + validateLesson over raw rows (the local-file source path). */
function buildRecordsFromRows(rows) {
  return rows.map(function (row, idx) {
    var parsed = Lesson.parseLessonRow(row);
    var validateErrors = parsed.lesson ? Lesson.validateLesson(parsed.lesson) : [];
    return {
      location: rowLabel(row, idx, parsed),
      lesson: parsed.lesson,
      kind: parsed.kind,
      material: parsed.material || null,
      parseErrors: parsed.errors,
      validateErrors: validateErrors
    };
  });
}

/**
 * Builds records from the Apps Script `action=lessons` response.
 * That endpoint already ran parseLessonRow() server-side (see
 * apps-script/Code.gs actionLessons): `lessons` are pre-parsed lesson
 * objects, `errors` are the fatal per-row parse failures. validateLesson()
 * has NOT been run server-side, so it is run here for every lesson.
 */
function buildRecordsFromApiResponse(body) {
  var records = [];
  (body.lessons || []).forEach(function (lesson) {
    records.push({
      location: lesson.lesson_id || '(未知 lesson_id)',
      lesson: lesson,
      parseErrors: [],
      validateErrors: Lesson.validateLesson(lesson)
    });
  });
  (body.errors || []).forEach(function (entry) {
    records.push({
      location: entry.lesson_id || ('第 ' + entry.row + ' 列'),
      lesson: null,
      parseErrors: entry.errors || [],
      validateErrors: []
    });
  });
  // Material rows arrive only when include_materials=1 (see buildLessonsUrl).
  // They carry no questions yet, so running validateLesson on them would just
  // report the absence of things that are not due yet; they are recorded so
  // the report can count remaining inventory and so their source_urls join
  // the duplicate check.
  (body.materials || []).forEach(function (material) {
    records.push({
      location: material.title || ('第 ' + material._row + ' 列'),
      lesson: null,
      kind: 'material',
      material: material,
      parseErrors: [],
      validateErrors: []
    });
  });
  return records;
}

/** Ensures the URL targets action=lessons without discarding an existing token query param. */
function buildLessonsUrl(url) {
  var u = new URL(url);
  if (!u.searchParams.has('action')) {
    u.searchParams.set('action', Contract.ACTIONS.LESSONS);
  }
  // The web app is served material rows filtered out; this tool needs them,
  // to report how many days of lessons remain and to include their
  // source_urls in the duplicate check.
  u.searchParams.set('include_materials', '1');
  return u.toString();
}

async function fetchLessonsFromUrl(url) {
  var res = await fetch(buildLessonsUrl(url));
  if (!res.ok) {
    throw new Error('HTTP 請求失敗，狀態碼 ' + res.status);
  }
  var body = await res.json();
  if (!body || body.ok !== true) {
    throw new Error('Apps Script 回傳失敗：' + ((body && body.error) || 'unknown_error'));
  }
  return body;
}

// ---------------------------------------------------------------------
// Report computation
// ---------------------------------------------------------------------

/**
 * Aggregates a list of {location, lesson, parseErrors, validateErrors}
 * records into the full health-check report.
 *
 * `opts.now` lets callers (tests) pin "today" for date-dependent metrics
 * (30-day supply rate, 24h audio-backfill window) instead of relying on the
 * real clock.
 */
function computeReport(records, opts) {
  opts = opts || {};
  var now = opts.now || new Date();
  var source = opts.source || null;

  var totalRows = records.length;
  var parsedRecords = records.filter(function (r) { return !!r.lesson; });
  var parsedLessons = parsedRecords.map(function (r) { return r.lesson; });

  // Material rows (kind: 'material'): lesson_id empty, source_url +
  // reading_text filled in -- content tools/fetch-materials.js already
  // fetched, Gemini Spark just hasn't written questions for it yet. Normal
  // inventory, not corruption -- excluded from every per-lesson quality
  // metric's denominator below, never added to `issues`, but still an input
  // to the source_url dedupe check (re-fetching the same article is a real
  // problem regardless of whether it became a lesson yet).
  var materialRecords = records.filter(function (r) { return r.kind === 'material'; });
  var materialCount = materialRecords.length;

  // Flat issue list: every parse/validate error on every record.
  var issues = [];
  records.forEach(function (rec) {
    recordErrors(rec).forEach(function (e) {
      issues.push({
        severity: isCriticalCode(e.code) ? 'critical' : 'warning',
        location: rec.location,
        code: e.code,
        message: e.message
      });
    });
  });

  // --- cross-row: daily row count / duplicate lesson_id ---
  var byLessonId = groupBy(parsedLessons, 'lesson_id');
  var lessonIdDupGroups = Object.keys(byLessonId).filter(function (k) { return byLessonId[k].length > 1; });
  var maxDailyCount = Object.keys(byLessonId).reduce(function (m, k) {
    return Math.max(m, byLessonId[k].length);
  }, 0);

  lessonIdDupGroups.forEach(function (k) {
    issues.push({
      severity: 'critical',
      location: k,
      code: Contract.ERRORS.DUPLICATE_LESSON_ID,
      message: 'lesson_id "' + k + '" 重複出現 ' + byLessonId[k].length + ' 次'
    });
  });

  // --- cross-row: duplicate source_url (covers material rows too -- see
  // materialRecords comment above) ---
  var sourceUrlSubjects = parsedLessons.concat(materialRecords.map(function (r) { return r.material; }));
  var bySourceUrl = groupBy(sourceUrlSubjects, 'source_url');
  var sourceUrlDupGroups = Object.keys(bySourceUrl).filter(function (k) { return bySourceUrl[k].length > 1; });
  sourceUrlDupGroups.forEach(function (k) {
    issues.push({
      severity: 'critical',
      location: k,
      code: Contract.ERRORS.DUPLICATE_SOURCE_URL,
      message: 'source_url "' + k + '" 重複出現 ' + bySourceUrl[k].length + ' 次'
    });
  });

  // --- 30-day supply rate ---
  var windowEnd = dateOnlyUTC(now);
  var windowStart = addDaysUTC(windowEnd, -29);
  var daysWithContent = Object.keys(byLessonId).filter(function (id) {
    var d = parseYmdUTC(id);
    return d !== null && d >= windowStart && d <= windowEnd;
  });

  // --- required field empty rate (excludes ROW_TOO_SHORT rows: field-level
  // detail is unknowable there since parseLessonRow bails before checking;
  // excludes material rows, which are expected to be missing most required
  // fields and never generate MISSING_FIELD for it) ---
  var rowTooShortCount = records.filter(function (r) {
    return recordHasAnyCode(r, [Contract.ERRORS.ROW_TOO_SHORT]);
  }).length;
  var requiredFieldSlots = (totalRows - rowTooShortCount - materialCount) * (Contract.LESSON_COLUMNS.length - 1);
  var missingFieldCount = countCodeOccurrences(records, [Contract.ERRORS.MISSING_FIELD]);

  // --- JSON parse rate (reading_questions / listening_questions / vocab) ---
  // Only counts rows that actually reached the JSON-parsing stage in
  // parseLessonRow -- ROW_TOO_SHORT / MISSING_FIELD rows never got there,
  // and material rows return before that stage too (their reading_questions
  // / listening_questions / vocab columns are empty by design).
  var jsonEligible = records.filter(function (r) {
    return r.kind !== 'material' && !recordHasAnyCode(r, [Contract.ERRORS.ROW_TOO_SHORT, Contract.ERRORS.MISSING_FIELD]);
  });
  var jsonSlots = jsonEligible.length * 3;
  var jsonFails = countCodeOccurrences(jsonEligible, [Contract.ERRORS.BAD_JSON, Contract.ERRORS.NOT_AN_ARRAY]);

  // --- question structure rate (reading: 4Q, listening: 3Q, 4 options, valid answer_index) ---
  var qsPairs = 0;
  var qsFails = 0;
  parsedRecords.forEach(function (rec) {
    ['reading_questions', 'listening_questions'].forEach(function (field) {
      qsPairs++;
      var bad = rec.validateErrors.some(function (e) {
        var onField = e.field === field || (e.field && e.field.indexOf(field + '[') === 0);
        var structureCode = ['BAD_QUESTION_COUNT', 'BAD_OPTION_COUNT', 'BAD_ANSWER_INDEX'].indexOf(e.code) !== -1;
        return onField && structureCode;
      });
      if (bad) qsFails++;
    });
  });

  // --- vocab term-in-source rate ---
  var vocabTotal = 0;
  var vocabFails = 0;
  parsedRecords.forEach(function (rec) {
    if (Array.isArray(rec.lesson.vocab)) vocabTotal += rec.lesson.vocab.length;
    vocabFails += rec.validateErrors.filter(function (e) {
      return e.code === Contract.ERRORS.VOCAB_NOT_IN_TEXT;
    }).length;
  });

  // --- audio segment length rate ---
  var audioSegTotal = parsedRecords.length;
  var audioSegFails = parsedRecords.filter(function (rec) {
    return rec.validateErrors.some(function (e) { return e.code === Contract.ERRORS.BAD_AUDIO_SEGMENT; });
  }).length;

  // --- audio backfill rate: among lessons written >=24h ago, audio_file_id non-empty ---
  var eligible = parsedRecords.filter(function (rec) {
    var t = Date.parse(rec.lesson.generated_at);
    if (isNaN(t)) return false;
    return now.getTime() - t >= 24 * 60 * 60 * 1000;
  });
  var filled = eligible.filter(function (rec) {
    return rec.lesson.audio_file_id && String(rec.lesson.audio_file_id).trim() !== '';
  });

  var metrics = [
    {
      key: 'daily_row_count',
      label: '每日產出列數',
      status: statusOkIf(lessonIdDupGroups.length === 0),
      detail: '共 ' + totalRows + ' 列，分布於 ' + Object.keys(byLessonId).length + ' 天，單日最多 ' +
        maxDailyCount + ' 列，超過 1 列的天數 ' + lessonIdDupGroups.length + '（期望每天 <= 1 列；0 列另需人工核對是否已收到通知信）',
      data: { total_rows: totalRows, distinct_days: Object.keys(byLessonId).length, max_daily_count: maxDailyCount, anomaly_days: lessonIdDupGroups.length }
    },
    {
      key: 'supply_30d',
      label: '連續供應率（近 30 天）',
      status: statusOkIf(daysWithContent.length >= 20),
      detail: daysWithContent.length + '/30 天有內容（期望 >= 20 天；未滿 30 天生產紀錄時此數字僅供參考）',
      data: { days_with_content: daysWithContent.length, window_days: 30 }
    },
    {
      key: 'dedupe_lesson_id',
      label: '去重（lesson_id）',
      status: statusOkIf(lessonIdDupGroups.length === 0),
      detail: lessonIdDupGroups.length + ' 組重複（期望 0，零容忍）',
      data: { duplicate_groups: lessonIdDupGroups.length }
    },
    {
      key: 'dedupe_source_url',
      label: '去重（source_url）',
      status: statusOkIf(sourceUrlDupGroups.length === 0),
      detail: sourceUrlDupGroups.length + ' 組重複（期望 0，零容忍）',
      data: { duplicate_groups: sourceUrlDupGroups.length }
    },
    {
      key: 'required_field_empty_rate',
      label: '必填欄位空值率',
      status: statusOkIf(missingFieldCount === 0),
      detail: pctStr(missingFieldCount, requiredFieldSlots) + '（' + missingFieldCount + '/' + requiredFieldSlots + '，期望 0%）',
      data: { empty_count: missingFieldCount, total_slots: requiredFieldSlots }
    },
    {
      key: 'json_parse_rate',
      label: 'JSON 可解析率',
      status: statusOkIf(jsonFails === 0),
      detail: pctStr(jsonSlots - jsonFails, jsonSlots) + '（' + (jsonSlots - jsonFails) + '/' + jsonSlots + '，期望 100%）',
      data: { ok_count: jsonSlots - jsonFails, total_slots: jsonSlots }
    },
    {
      key: 'question_structure_rate',
      label: '題目結構符合率',
      status: statusOkIf(qsFails === 0),
      detail: pctStr(qsPairs - qsFails, qsPairs) + '（' + (qsPairs - qsFails) + '/' + qsPairs + '，期望 100%）',
      data: { ok_count: qsPairs - qsFails, total_pairs: qsPairs }
    },
    {
      key: 'vocab_term_rate',
      label: '單字出處符合率',
      status: statusOkIf(vocabFails === 0),
      detail: pctStr(vocabTotal - vocabFails, vocabTotal) + '（' + (vocabTotal - vocabFails) + '/' + vocabTotal + '，期望 100%）',
      data: { ok_count: vocabTotal - vocabFails, total_terms: vocabTotal }
    },
    {
      key: 'audio_segment_rate',
      label: '音檔區段長度符合率',
      status: statusOkIf(audioSegFails === 0),
      detail: pctStr(audioSegTotal - audioSegFails, audioSegTotal) + '（' + (audioSegTotal - audioSegFails) + '/' + audioSegTotal + '，期望 100%）',
      data: { ok_count: audioSegTotal - audioSegFails, total_lessons: audioSegTotal }
    },
    {
      key: 'audio_backfill_rate',
      label: '音檔回填率（寫入滿 24 小時的列）',
      status: eligible.length === 0 ? 'OK' : statusOkIf(filled.length === eligible.length),
      detail: eligible.length === 0
        ? '無寫入滿 24 小時的列可評估'
        : pctStr(filled.length, eligible.length) + '（' + filled.length + '/' + eligible.length + '，期望 100%）',
      data: { filled_count: filled.length, eligible_count: eligible.length }
    },
    {
      // Informational only (always OK) -- this is inventory, not a quality
      // gate. It tells the user how many days of content are still sitting
      // in the sheet waiting for Gemini Spark to write questions for it.
      key: 'material_inventory',
      label: '素材庫存',
      status: 'OK',
      detail: materialCount + ' 列尚未出題',
      data: { material_count: materialCount }
    }
  ];

  var ok = metrics.every(function (m) { return m.status === 'OK'; });

  return {
    source: source,
    generated_at: now.toISOString(),
    total_rows: totalRows,
    parsed_rows: parsedRecords.length,
    material_rows: materialCount,
    broken_rows: totalRows - parsedRecords.length - materialCount,
    ok: ok,
    metrics: metrics,
    issues: issues
  };
}

// ---------------------------------------------------------------------
// Human-readable report
// ---------------------------------------------------------------------

function formatHumanReport(report) {
  var lines = [];
  lines.push('=== 英語學習內容每日健檢報告 ===');
  lines.push('來源：' + (report.source || '(未提供)'));
  lines.push('產出時間：' + report.generated_at);
  lines.push('掃描列數：' + report.total_rows + '（成功解析 ' + report.parsed_rows + ' 列，素材待出題 ' +
    report.material_rows + ' 列，結構損壞 ' + report.broken_rows + ' 列）');
  lines.push('');
  report.metrics.forEach(function (m) {
    lines.push('[' + m.status + '] ' + m.label + '：' + m.detail);
  });
  lines.push('');
  lines.push('--- 問題清單（共 ' + report.issues.length + ' 筆）---');
  if (report.issues.length === 0) {
    lines.push('（無問題）');
  } else {
    report.issues.forEach(function (iss) {
      var sev = iss.severity === 'critical' ? '嚴重' : '警告';
      lines.push('[' + sev + '] ' + iss.location + ' - ' + iss.code + '：' + iss.message);
    });
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------

async function main() {
  var argv = process.argv.slice(2);
  var jsonMode = argv.indexOf('--json') !== -1;
  var source = argv.filter(function (a) { return a !== '--json'; })[0];

  if (!source) {
    console.error('用法：node tools/healthcheck.js <本機 JSON 檔路徑 或 Apps Script lessons endpoint 網址> [--json]');
    process.exitCode = 1;
    return;
  }

  var records;
  try {
    if (/^https?:\/\//i.test(source)) {
      var body = await fetchLessonsFromUrl(source);
      records = buildRecordsFromApiResponse(body);
    } else {
      var rows = loadRowsFromFile(path.resolve(source));
      records = buildRecordsFromRows(rows);
    }
  } catch (err) {
    console.error('健檢工具執行失敗：' + ((err && err.message) || String(err)));
    process.exitCode = 1;
    return;
  }

  var report = computeReport(records, { source: source });

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatHumanReport(report));
  }

  process.exitCode = report.ok ? 0 : 1;
}

module.exports = {
  loadRowsFromFile: loadRowsFromFile,
  buildRecordsFromRows: buildRecordsFromRows,
  buildRecordsFromApiResponse: buildRecordsFromApiResponse,
  buildLessonsUrl: buildLessonsUrl,
  computeReport: computeReport,
  formatHumanReport: formatHumanReport
};

if (require.main === module) {
  main();
}
