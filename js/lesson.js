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
 *   FATAL -> parseLessonRow() returns { lesson: null, errors, kind: 'broken' }.
 *     The row is structurally unusable, so there is no lesson object worth
 *     handing to a caller:
 *       - row has fewer cells than Contract.LESSON_COLUMNS (ROW_TOO_SHORT)
 *       - a required column (see Contract.LESSON_REQUIRED_COLUMNS) is empty
 *         (MISSING_FIELD)
 *       - reading_questions / listening_questions / vocab do not parse as
 *         JSON (BAD_JSON), or parse to something other than an array
 *         (NOT_AN_ARRAY)
 *
 *   NON-FATAL -> parseLessonRow() still returns a lesson object (kind:
 *   'lesson'); these are instead caught by validateLesson(lesson), which
 *   never rejects the lesson itself, only reports problems with it:
 *       - question count / option count / answer_index range / missing
 *         explanation
 *       - vocab count, vocab entry shape, vocab term not found in the
 *         source text
 *       - audio segment length out of range
 *       - bad level / source / lesson_id / generated_at
 *
 *   MATERIAL (not fatal, not a lesson) -> parseLessonRow() returns
 *   { lesson: null, errors: [], kind: 'material', material }.
 *     `lesson_id` is empty but `source_url` and `reading_text` are filled in
 *     -- tools/fetch-materials.js already fetched this content, Gemini Spark
 *     just hasn't turned it into a lesson (written questions) yet. This is
 *     normal inventory, not corruption, so it never produces an error. See
 *     isMaterialRow() and docs/specs/2026-09-02-content-pipeline.md's
 *     "空值語意有三種" for the exact rule.
 *
 * The reasoning: a structurally broken row can't be rendered at all, so
 * there is nothing useful to return. A structurally sound lesson with a
 * content problem (e.g. one vocab term the model hallucinated) is still
 * renderable -- the caller (daily health-check, or the web app) is in a
 * better position to decide whether to show it, skip it, or just flag it.
 * A material row isn't renderable either, but it isn't broken -- the caller
 * needs `kind` to tell the two "lesson: null" cases apart.
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

  /**
   * A "material row": `lesson_id` empty but `source_url` and `reading_text`
   * filled in. tools/fetch-materials.js writes rows in exactly this shape --
   * content fetched, questions not written yet -- and it is normal inventory
   * to sit in that state for months, not a corrupted row. Works on the raw
   * per-column object built inside parseLessonRow, or on any lesson-shaped
   * object (e.g. an already-parsed lesson) that exposes the same three
   * fields, so other callers (the web app, tools/healthcheck.js) can reuse
   * the exact same rule instead of re-deriving it.
   */
  function isMaterialRow(entry) {
    if (!entry || typeof entry !== 'object') return false;
    return isEmptyCell(entry.lesson_id) && !isEmptyCell(entry.source_url) && !isEmptyCell(entry.reading_text);
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
      return { lesson: null, errors: errors, kind: 'broken' };
    }

    var raw = {};
    Contract.LESSON_COLUMNS.forEach(function (name, i) {
      raw[name] = row[i];
    });

    // Material row: lesson_id empty, source_url + reading_text present.
    // Checked before the required-field loop below on purpose -- a material
    // row is *expected* to be missing lesson_id, reading_questions,
    // listening_questions, vocab and generated_at, and none of that should
    // ever surface as an error.
    if (isMaterialRow(raw)) {
      var material = {
        level: String(raw.level),
        source: String(raw.source),
        source_url: String(raw.source_url),
        title: String(raw.title),
        reading_text: String(raw.reading_text),
        audio_url: String(raw.audio_url),
        audio_start_sec: raw.audio_start_sec,
        audio_end_sec: raw.audio_end_sec,
        transcript: String(raw.transcript)
      };
      return { lesson: null, errors: [], kind: 'material', material: material };
    }

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
      return { lesson: null, errors: errors, kind: 'broken' };
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
      return { lesson: null, errors: errors, kind: 'broken' };
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
      return { lesson: null, errors: errors, kind: 'broken' };
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

    return { lesson: lesson, errors: errors, kind: 'lesson' };
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
    validateLesson: validateLesson,
    isMaterialRow: isMaterialRow
  };
});
