/**
 * GENERATED FILE - DO NOT EDIT BY HAND.
 *
 * Built by tools/build-shared.js from:
 *   - js/contract.js
 *   - js/lesson.js
 *
 * Apps Script has no import/require, so the shared contract and parser
 * are concatenated here. Edit the source files, re-run the builder, then
 * paste this whole file into the Apps Script project as Shared.gs.
 */

// ===== BEGIN js/contract.js =====
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
    SET_LEVEL: 'set_level'
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
// ===== END js/contract.js =====

// ===== BEGIN js/lesson.js =====
/**
 * Row parsing and content validation for the `lessons` sheet.
 *
 * Same runtime constraint as js/contract.js: this file is loaded in the
 * browser (<script>), the Service Worker (importScripts()), Google Apps
 * Script (copied by hand into apps-script/Shared.gs), and Node (require(),
 * in the tests). It must stay free of `import`/`export` and of anything
 * newer than ES2017.
 *
 * Depends on js/contract.js for column order, rule constants and error
 * codes. In Node it is pulled in with require('./contract.js'); in the
 * browser/Service Worker/Apps Script it is expected to already be on the
 * global object as `Contract` (load contract.js first).
 *
 * ---
 * Fatal vs. non-fatal boundary (docs/specs/2026-09-02-content-pipeline.md,
 * "測試決策" / "驗收查詢"):
 *
 *   FATAL -> parseLessonRow() returns { lesson: null, errors }.
 *     The row is structurally unusable, so there is no lesson object worth
 *     handing to a caller:
 *       - row has fewer cells than Contract.LESSON_COLUMNS (ROW_TOO_SHORT)
 *       - a required column (see Contract.LESSON_REQUIRED_COLUMNS) is empty
 *         (MISSING_FIELD)
 *       - reading_questions / listening_questions / vocab do not parse as
 *         JSON (BAD_JSON), or parse to something other than an array
 *         (NOT_AN_ARRAY)
 *
 *   NON-FATAL -> parseLessonRow() still returns a lesson object; these are
 *   instead caught by validateLesson(lesson), which never rejects the
 *   lesson itself, only reports problems with it:
 *       - question count / option count / answer_index range / missing
 *         explanation
 *       - vocab count, vocab entry shape, vocab term not found in the
 *         source text
 *       - audio segment length out of range
 *       - bad level / source / lesson_id / generated_at
 *
 * The reasoning: a structurally broken row can't be rendered at all, so
 * there is nothing useful to return. A structurally sound lesson with a
 * content problem (e.g. one vocab term the model hallucinated) is still
 * renderable -- the caller (daily health-check, or the web app) is in a
 * better position to decide whether to show it, skip it, or just flag it.
 *
 * Source of truth: docs/specs/2026-09-02-content-pipeline.md
 */
(function (root, factory) {
  var Contract = (typeof module !== 'undefined' && module.exports)
    ? require('./contract.js')
    : root.Contract;
  var api = factory(Contract);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.Lesson = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Contract) {
  'use strict';

  /** True for undefined/null/whitespace-only-string cells. Numbers (incl. 0) are not empty. */
  function isEmptyCell(value) {
    if (value === undefined || value === null) return true;
    if (typeof value === 'string' && value.trim() === '') return true;
    return false;
  }

  /** True if the cell came back as a real Date object (Sheets auto-converts date-like cells when read via getValues()). */
  function isDateValue(value) {
    return Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime());
  }

  /** Formats a Date using its LOCAL calendar date as YYYY-MM-DD. Sheets' Date for a date-only cell is local midnight, so toISOString() (UTC) would shift it a day in most timezones -- this avoids that. */
  function formatLocalDateStr(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1);
    var day = String(d.getDate());
    if (m.length < 2) m = '0' + m;
    if (day.length < 2) day = '0' + day;
    return y + '-' + m + '-' + day;
  }

  // ---------------------------------------------------------------------
  // parseLessonRow
  // ---------------------------------------------------------------------

  function parseLessonRow(row) {
    var errors = [];

    if (!Array.isArray(row) || row.length < Contract.LESSON_COLUMNS.length) {
      errors.push(Contract.makeError(
        Contract.ERRORS.ROW_TOO_SHORT,
        null,
        'Row has ' + (Array.isArray(row) ? row.length : typeof row) +
          ' cells, expected ' + Contract.LESSON_COLUMNS.length
      ));
      return { lesson: null, errors: errors };
    }

    var raw = {};
    Contract.LESSON_COLUMNS.forEach(function (name, i) {
      raw[name] = row[i];
    });

    var missingRequired = false;
    Contract.LESSON_REQUIRED_COLUMNS.forEach(function (name) {
      if (isEmptyCell(raw[name])) {
        errors.push(Contract.makeError(
          Contract.ERRORS.MISSING_FIELD,
          name,
          'Required field "' + name + '" is empty'
        ));
        missingRequired = true;
      }
    });
    if (missingRequired) {
      return { lesson: null, errors: errors };
    }

    var jsonFields = ['reading_questions', 'listening_questions', 'vocab'];
    var parsed = {};
    var badJson = false;
    jsonFields.forEach(function (name) {
      var value;
      try {
        value = JSON.parse(raw[name]);
      } catch (e) {
        errors.push(Contract.makeError(
          Contract.ERRORS.BAD_JSON,
          name,
          'Could not parse JSON in "' + name + '": ' + e.message
        ));
        badJson = true;
        return;
      }
      if (!Array.isArray(value)) {
        errors.push(Contract.makeError(
          Contract.ERRORS.NOT_AN_ARRAY,
          name,
          'Field "' + name + '" parsed but is not an array'
        ));
        badJson = true;
        return;
      }
      parsed[name] = value;
    });
    if (badJson) {
      return { lesson: null, errors: errors };
    }

    // parseInt on a non-numeric string returns NaN without throwing; left
    // unchecked, that NaN flows all the way to the player (audio.currentTime
    // = NaN) instead of being caught here where the row can still be
    // rejected cleanly.
    var audioStartSec = parseInt(raw.audio_start_sec, 10);
    var audioEndSec = parseInt(raw.audio_end_sec, 10);
    var badAudioNumber = false;
    if (Number.isNaN(audioStartSec)) {
      errors.push(Contract.makeError(
        Contract.ERRORS.BAD_AUDIO_SEGMENT,
        'audio_start_sec',
        'audio_start_sec "' + raw.audio_start_sec + '" is not a valid number'
      ));
      badAudioNumber = true;
    }
    if (Number.isNaN(audioEndSec)) {
      errors.push(Contract.makeError(
        Contract.ERRORS.BAD_AUDIO_SEGMENT,
        'audio_end_sec',
        'audio_end_sec "' + raw.audio_end_sec + '" is not a valid number'
      ));
      badAudioNumber = true;
    }
    if (badAudioNumber) {
      return { lesson: null, errors: errors };
    }

    var lesson = {
      // Google Sheets auto-converts date-looking cells to real Date objects
      // when read via getDataRange().getValues(). A naive String(Date)
      // yields e.g. "Wed Sep 02 2026 00:00:00 GMT+0800", which both fails
      // isValidLessonId() and, because of the colons in its time portion,
      // corrupts Contract.itemId()'s ':' -split parsing downstream. Detect
      // the Date case and format it explicitly instead.
      lesson_id: isDateValue(raw.lesson_id) ? formatLocalDateStr(raw.lesson_id) : String(raw.lesson_id),
      level: String(raw.level),
      source: String(raw.source),
      source_url: String(raw.source_url),
      title: String(raw.title),
      reading_text: String(raw.reading_text),
      reading_questions: parsed.reading_questions,
      audio_url: String(raw.audio_url),
      audio_start_sec: audioStartSec,
      audio_end_sec: audioEndSec,
      transcript: String(raw.transcript),
      listening_questions: parsed.listening_questions,
      vocab: parsed.vocab,
      generated_at: isDateValue(raw.generated_at) ? raw.generated_at.toISOString() : String(raw.generated_at),
      audio_file_id: isEmptyCell(raw.audio_file_id) ? '' : String(raw.audio_file_id)
    };

    return { lesson: lesson, errors: errors };
  }

  // ---------------------------------------------------------------------
  // validateLesson and its helpers
  // ---------------------------------------------------------------------

  function validateQuestionSet(questions, fieldName, expectedCount, errors) {
    if (!Array.isArray(questions)) {
      errors.push(Contract.makeError(
        Contract.ERRORS.BAD_QUESTION_COUNT,
        fieldName,
        fieldName + ' is not an array'
      ));
      return;
    }
    if (questions.length !== expectedCount) {
      errors.push(Contract.makeError(
        Contract.ERRORS.BAD_QUESTION_COUNT,
        fieldName,
        fieldName + ' has ' + questions.length + ' questions, expected ' + expectedCount
      ));
    }

    questions.forEach(function (q, i) {
      var label = fieldName + '[' + i + ']';
      var options = q && q.options;
      if (!Array.isArray(options) || options.length !== Contract.RULES.OPTIONS_PER_QUESTION) {
        errors.push(Contract.makeError(
          Contract.ERRORS.BAD_OPTION_COUNT,
          label,
          label + ' has ' + (Array.isArray(options) ? options.length : 0) +
            ' options, expected ' + Contract.RULES.OPTIONS_PER_QUESTION
        ));
      }

      var idx = q && q.answer_index;
      var maxIndex = Contract.RULES.OPTIONS_PER_QUESTION - 1;
      if (typeof idx !== 'number' || Math.floor(idx) !== idx || idx < 0 || idx > maxIndex) {
        errors.push(Contract.makeError(
          Contract.ERRORS.BAD_ANSWER_INDEX,
          label,
          label + ' answer_index (' + idx + ') is out of range 0-' + maxIndex
        ));
      }

      var explanation = q && q.explanation;
      if (typeof explanation !== 'string' || explanation.trim() === '') {
        errors.push(Contract.makeError(
          Contract.ERRORS.MISSING_EXPLANATION,
          label,
          label + ' is missing an explanation'
        ));
      }
    });
  }

  /** A short word ending in a single vowel + single consonant (consonant not w/x/y) -- doubles the consonant before -ed/-ing (stop -> stopped, run -> running). */
  var CVC_DOUBLE_RE = /^[^aeiou]*[aeiou][^aeiouwxy]$/;

  /** Common English inflections of a lowercase, letters-only base term. */
  function inflections(term) {
    var forms = [term];
    if (/[^aeiou]y$/.test(term)) {
      var stem = term.slice(0, -1);
      forms.push(stem + 'ies');   // study -> studies
      forms.push(stem + 'ied');   // study -> studied
      forms.push(term + 'ing');   // study -> studying
    } else if (/e$/.test(term)) {
      forms.push(term + 's');               // increase -> increases
      forms.push(term + 'd');                // increase -> increased
      forms.push(term.slice(0, -1) + 'ing'); // increase -> increasing
    } else if (/[sxz]$/.test(term) || /[sc]h$/.test(term)) {
      forms.push(term + 'es');  // watch -> watches
      forms.push(term + 'ed');  // watch -> watched
      forms.push(term + 'ing'); // watch -> watching
    } else if (CVC_DOUBLE_RE.test(term)) {
      var doubled = term + term.charAt(term.length - 1);
      forms.push(term + 's');      // stop -> stops
      forms.push(doubled + 'ed');  // stop -> stopped
      forms.push(doubled + 'ing'); // run -> running
    } else {
      forms.push(term + 's');   // develop -> develops
      forms.push(term + 'ed');  // develop -> developed
      forms.push(term + 'ing'); // develop -> developing
    }
    return forms;
  }

  /** Lower-cased word tokens (letters plus internal apostrophes) found in text. */
  function buildTokenSet(text) {
    var tokens = text.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || [];
    var set = {};
    tokens.forEach(function (t) {
      set[t] = true;
    });
    return set;
  }

  /**
   * Whether `term` (in its base form, or a common inflected form) can be
   * found in the lesson's source text. Single words are matched against a
   * token set with -s/-es/-ed/-ing/-ies/-ied variants; multi-word or
   * hyphenated terms fall back to a normalized, case-insensitive phrase
   * search over the raw text.
   */
  function termFound(term, tokenSet, haystackRaw) {
    if (typeof term !== 'string' || term.trim() === '') return false;
    var t = term.trim().toLowerCase();

    if (/^[a-z]+$/.test(t)) {
      var forms = inflections(t);
      for (var i = 0; i < forms.length; i++) {
        if (tokenSet[forms[i]]) return true;
      }
      // None of the regular inflected forms matched -- fall through to the
      // looser phrase search below instead of giving up. Regular inflection
      // rules can't cover every case (irregular verbs, etc.), so this gives
      // the term one more chance before it gets flagged as VOCAB_NOT_IN_TEXT.
    }

    var pattern = t.replace(/[^a-z]+/g, '[^a-zA-Z]+');
    try {
      var re = new RegExp('(^|[^a-zA-Z])' + pattern + '([^a-zA-Z]|$)', 'i');
      return re.test(haystackRaw);
    } catch (e) {
      return haystackRaw.toLowerCase().indexOf(t) !== -1;
    }
  }

  function validateVocab(lesson, errors) {
    var vocab = lesson.vocab;
    if (!Array.isArray(vocab)) {
      errors.push(Contract.makeError(Contract.ERRORS.BAD_VOCAB_COUNT, 'vocab', 'vocab is not an array'));
      return;
    }
    if (vocab.length < Contract.RULES.VOCAB_MIN || vocab.length > Contract.RULES.VOCAB_MAX) {
      errors.push(Contract.makeError(
        Contract.ERRORS.BAD_VOCAB_COUNT,
        'vocab',
        'vocab has ' + vocab.length + ' entries, expected ' +
          Contract.RULES.VOCAB_MIN + '-' + Contract.RULES.VOCAB_MAX
      ));
    }

    var haystack =
      (typeof lesson.reading_text === 'string' ? lesson.reading_text : '') + ' ' +
      (typeof lesson.transcript === 'string' ? lesson.transcript : '');
    var tokenSet = buildTokenSet(haystack);

    vocab.forEach(function (entry, i) {
      var label = 'vocab[' + i + ']';
      var hasRequiredFields = !!entry &&
        typeof entry.term === 'string' && entry.term.trim() !== '' &&
        typeof entry.pos === 'string' && entry.pos.trim() !== '' &&
        typeof entry.definition_en === 'string' && entry.definition_en.trim() !== '' &&
        typeof entry.definition_zh === 'string' && entry.definition_zh.trim() !== '' &&
        typeof entry.example === 'string' && entry.example.trim() !== '';

      if (!hasRequiredFields) {
        errors.push(Contract.makeError(
          Contract.ERRORS.BAD_VOCAB_ENTRY,
          label,
          label + ' is missing one or more required fields'
        ));
        return;
      }

      if (!termFound(entry.term, tokenSet, haystack)) {
        errors.push(Contract.makeError(
          Contract.ERRORS.VOCAB_NOT_IN_TEXT,
          label,
          'Vocab term "' + entry.term + '" was not found in reading_text or transcript'
        ));
      }
    });
  }

  function validateAudioSegment(lesson, errors) {
    var start = lesson.audio_start_sec;
    var end = lesson.audio_end_sec;
    var duration = end - start;
    if (
      typeof start !== 'number' || typeof end !== 'number' || isNaN(duration) ||
      duration < Contract.RULES.AUDIO_SEGMENT_MIN_SEC || duration > Contract.RULES.AUDIO_SEGMENT_MAX_SEC
    ) {
      errors.push(Contract.makeError(
        Contract.ERRORS.BAD_AUDIO_SEGMENT,
        'audio_end_sec',
        'audio segment length ' + duration + 's is outside ' +
          Contract.RULES.AUDIO_SEGMENT_MIN_SEC + '-' + Contract.RULES.AUDIO_SEGMENT_MAX_SEC + 's'
      ));
    }
  }

  /** YYYY-MM-DD, and an actual calendar date (rejects e.g. 2026-02-30). */
  function isValidLessonId(value) {
    if (typeof value !== 'string') return false;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return false;
    var year = parseInt(m[1], 10);
    var month = parseInt(m[2], 10);
    var day = parseInt(m[3], 10);
    var d = new Date(Date.UTC(year, month - 1, day));
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
  }

  /** ISO8601 date-time, e.g. 2026-08-25T09:12:00Z or with a numeric offset. */
  function isValidIso8601(value) {
    if (typeof value !== 'string') return false;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(value)) return false;
    return !isNaN(Date.parse(value));
  }

  function validateLesson(lesson) {
    var errors = [];

    if (!lesson || typeof lesson !== 'object') {
      errors.push(Contract.makeError(Contract.ERRORS.MISSING_FIELD, null, 'Lesson is null or not an object'));
      return errors;
    }

    validateQuestionSet(lesson.reading_questions, 'reading_questions', Contract.RULES.READING_QUESTION_COUNT, errors);
    validateQuestionSet(lesson.listening_questions, 'listening_questions', Contract.RULES.LISTENING_QUESTION_COUNT, errors);
    validateVocab(lesson, errors);
    validateAudioSegment(lesson, errors);

    if (!Contract.isCefrLevel(lesson.level)) {
      errors.push(Contract.makeError(
        Contract.ERRORS.BAD_LEVEL,
        'level',
        'Level "' + lesson.level + '" is not a valid CEFR level'
      ));
    }

    if (Contract.SOURCES.indexOf(lesson.source) === -1) {
      errors.push(Contract.makeError(
        Contract.ERRORS.BAD_SOURCE,
        'source',
        'Source "' + lesson.source + '" is not a recognized source'
      ));
    }

    if (!isValidLessonId(lesson.lesson_id)) {
      errors.push(Contract.makeError(
        Contract.ERRORS.BAD_LESSON_ID,
        'lesson_id',
        'lesson_id "' + lesson.lesson_id + '" is not a valid YYYY-MM-DD date'
      ));
    }

    if (!isValidIso8601(lesson.generated_at)) {
      errors.push(Contract.makeError(
        Contract.ERRORS.BAD_TIMESTAMP,
        'generated_at',
        'generated_at "' + lesson.generated_at + '" is not a valid ISO8601 timestamp'
      ));
    }

    return errors;
  }

  return {
    parseLessonRow: parseLessonRow,
    validateLesson: validateLesson
  };
});
// ===== END js/lesson.js =====

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
