/**
 * Shared data contract for the English learning project.
 *
 * This file is loaded in THREE different runtimes, so it must stay free of
 * `import`/`export` and of anything newer than ES2017:
 *   1. the browser, via a plain <script> tag
 *   2. the Service Worker, via importScripts()
 *   3. Google Apps Script, as a copy in apps-script/Shared.gs
 *   4. Node, via require() in the tests
 *
 * Source of truth: docs/specs/2026-09-02-content-pipeline.md
 *                  docs/specs/2026-09-02-practice-web-app.md
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.Contract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Column order of the `lessons` sheet, A..O. Never reorder. */
  var LESSON_COLUMNS = [
    'lesson_id',        // A  YYYY-MM-DD, globally unique
    'level',            // B  CEFR
    'source',           // C  voa_le | bbc_le
    'source_url',       // D  dedupe key
    'title',            // E
    'reading_text',     // F
    'reading_questions',// G  JSON string, 4 questions
    'audio_url',        // H
    'audio_start_sec',  // I  int
    'audio_end_sec',    // J  int
    'transcript',       // K
    'listening_questions', // L  JSON string, 3 questions
    'vocab',            // M  JSON string, 8-12 entries
    'generated_at',     // N  ISO8601
    'audio_file_id'     // O  filled in later by AudioFetcher; empty is normal
  ];

  /**
   * Columns that must be non-empty for a row to be usable.
   * `audio_file_id` is deliberately absent: empty means "not fetched yet",
   * which is a normal transient state, not corruption.
   */
  var LESSON_REQUIRED_COLUMNS = LESSON_COLUMNS.filter(function (c) {
    return c !== 'audio_file_id';
  });

  /** Column order of the `progress` sheet. One row = one answer. */
  var PROGRESS_COLUMNS = [
    'record_id',      // UUID, dedupe key for append
    'item_id',
    'item_type',      // see ITEM_TYPES
    'lesson_id',
    'answered_at',    // ISO8601 UTC
    'correct',        // boolean
    'device',
    'client_version'
  ];

  /** `settings` sheet: A1 is the label, B1 holds the value. */
  var SETTINGS = {
    SHEET: 'settings',
    LEVEL_LABEL_CELL: 'A1',
    LEVEL_VALUE_CELL: 'B1',
    LEVEL_LABEL: 'current_level'
  };

  var SHEETS = {
    LESSONS: 'lessons',
    PROGRESS: 'progress',
    SETTINGS: 'settings'
  };

  var ITEM_TYPES = ['reading_q', 'listening_q', 'vocab'];

  var SOURCES = ['voa_le', 'bbc_le'];

  /** CEFR ladder, ordered easiest to hardest. Index is the level number. */
  var CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

  var DEFAULT_LEVEL = 'B1';

  /**
   * Every rule that is checked by validateLesson(), in one place, so the
   * generator prompt, the validator and the tests cannot drift apart.
   */
  var RULES = {
    READING_QUESTION_COUNT: 4,
    LISTENING_QUESTION_COUNT: 3,
    OPTIONS_PER_QUESTION: 4,
    VOCAB_MIN: 8,
    VOCAB_MAX: 12,
    AUDIO_SEGMENT_MIN_SEC: 120,
    AUDIO_SEGMENT_MAX_SEC: 180
  };

  /** Simplified SM-2. Answer right -> next interval; answer wrong -> back to index 0. */
  var REVIEW = {
    INTERVALS_DAYS: [1, 3, 7, 14, 30],
    /** Items never practised come before items merely due. */
    NEW_ITEM_PRIORITY: true
  };

  /** Rolling accuracy thresholds for automatic level adjustment. */
  var LEVEL_ADJUST = {
    WINDOW: 20,        // consider the most recent N answers
    MIN_SAMPLE: 20,    // below this, never adjust
    UP_ABOVE: 0.85,
    DOWN_BELOW: 0.60
  };

  var OFFLINE = {
    CACHE_DAYS: 7,          // lessons + audio kept on device
    QUEUE_STORAGE_KEY: 'el.queue.v1',
    LESSON_STORAGE_KEY: 'el.lessons.v1',
    PROGRESS_STORAGE_KEY: 'el.progress.v1',
    SETTINGS_STORAGE_KEY: 'el.settings.v1'
  };

  /** Apps Script side: how long downloaded MP3s stay in Drive. */
  var AUDIO_RETENTION_WEEKS = 8;

  /** Apps Script Web App actions. Used by both js/api.js and Code.gs. */
  var ACTIONS = {
    LESSONS: 'lessons',
    AUDIO: 'audio',
    PROGRESS: 'progress',
    APPEND: 'append',
    SET_LEVEL: 'set_level',
    /**
     * Batch-writes material rows (lesson_id empty: text and audio ready,
     * questions not written yet). Called by tools/upload-materials.js, never
     * by the web app -- fetching moved off Gemini Spark once the source sites
     * turned out to block it. See docs/specs/2026-09-02-content-pipeline.md.
     */
    ADD_MATERIALS: 'add_materials'
  };

  /**
   * Named error codes. parseLessonRow / validateLesson return these instead of
   * throwing, so one bad row can never take down a whole batch.
   * Shape: { code, field, message, lesson_id? }
   */
  var ERRORS = {
    MISSING_FIELD: 'MISSING_FIELD',
    BAD_JSON: 'BAD_JSON',
    NOT_AN_ARRAY: 'NOT_AN_ARRAY',
    BAD_QUESTION_COUNT: 'BAD_QUESTION_COUNT',
    BAD_OPTION_COUNT: 'BAD_OPTION_COUNT',
    BAD_ANSWER_INDEX: 'BAD_ANSWER_INDEX',
    MISSING_EXPLANATION: 'MISSING_EXPLANATION',
    BAD_VOCAB_COUNT: 'BAD_VOCAB_COUNT',
    BAD_VOCAB_ENTRY: 'BAD_VOCAB_ENTRY',
    VOCAB_NOT_IN_TEXT: 'VOCAB_NOT_IN_TEXT',
    BAD_AUDIO_SEGMENT: 'BAD_AUDIO_SEGMENT',
    BAD_LEVEL: 'BAD_LEVEL',
    BAD_SOURCE: 'BAD_SOURCE',
    BAD_LESSON_ID: 'BAD_LESSON_ID',
    BAD_TIMESTAMP: 'BAD_TIMESTAMP',
    BAD_URL: 'BAD_URL',
    ROW_TOO_SHORT: 'ROW_TOO_SHORT',
    DUPLICATE_LESSON_ID: 'DUPLICATE_LESSON_ID',
    DUPLICATE_SOURCE_URL: 'DUPLICATE_SOURCE_URL'
  };

  /** Bumped by hand when the client changes in a way worth telling apart in the data. */
  var CLIENT_VERSION = '1.0.0';

  /** Builds a stable item id so the same question always maps to the same review item. */
  function itemId(lessonId, itemType, index) {
    return lessonId + ':' + itemType + ':' + index;
  }

  function isCefrLevel(value) {
    return CEFR_LEVELS.indexOf(value) !== -1;
  }

  /** Shifts a CEFR level by n steps, clamped at both ends. */
  function shiftLevel(level, steps) {
    var i = CEFR_LEVELS.indexOf(level);
    if (i === -1) return DEFAULT_LEVEL;
    var next = Math.min(CEFR_LEVELS.length - 1, Math.max(0, i + steps));
    return CEFR_LEVELS[next];
  }

  /** Standard error object used everywhere errors are collected. */
  function makeError(code, field, message) {
    return { code: code, field: field || null, message: message || code };
  }

  return {
    LESSON_COLUMNS: LESSON_COLUMNS,
    LESSON_REQUIRED_COLUMNS: LESSON_REQUIRED_COLUMNS,
    PROGRESS_COLUMNS: PROGRESS_COLUMNS,
    SETTINGS: SETTINGS,
    SHEETS: SHEETS,
    ITEM_TYPES: ITEM_TYPES,
    SOURCES: SOURCES,
    CEFR_LEVELS: CEFR_LEVELS,
    DEFAULT_LEVEL: DEFAULT_LEVEL,
    RULES: RULES,
    REVIEW: REVIEW,
    LEVEL_ADJUST: LEVEL_ADJUST,
    OFFLINE: OFFLINE,
    AUDIO_RETENTION_WEEKS: AUDIO_RETENTION_WEEKS,
    ACTIONS: ACTIONS,
    ERRORS: ERRORS,
    CLIENT_VERSION: CLIENT_VERSION,
    itemId: itemId,
    isCefrLevel: isCefrLevel,
    shiftLevel: shiftLevel,
    makeError: makeError
  };
});
