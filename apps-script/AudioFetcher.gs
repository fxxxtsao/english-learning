/**
 * AudioFetcher.gs
 *
 * Daily job (fetchPendingAudio): download the MP3 for every `lessons` row
 * that doesn't have an audio_file_id yet, save it into a Drive folder, and
 * write the resulting file id back to column O.
 *
 * Weekly job (cleanupOldAudio): trash MP3s older than the retention window.
 *
 * Setup job (installTriggers): (re)install the two time-driven triggers.
 *
 * Runs in the Google Apps Script V8 runtime: no import/require, everything
 * here is a global. Depends on `Contract` being defined by Shared.gs (a
 * hand-synced copy of js/contract.js, see test/shared-sync.test.js) loaded
 * in the same Apps Script project.
 *
 * Spec: docs/specs/2026-09-02-content-pipeline.md
 *   - "轉換決策" audio paragraph (fetch design, 8-week retention)
 *   - "測試決策" Apps Script paragraph (runtime checks instead of unit tests,
 *     since Apps Script code cannot be run/tested outside its own runtime)
 *   - "資料契約" lessons columns A-O
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Apps Script kills a single execution at 6 minutes, hard. fetchPendingAudio
 * stops picking up new rows once this much time has elapsed, leaving a
 * SAFETY_BUFFER_MS margin before that hard cutoff so the *last* row it
 * starts still has room to finish before Google terminates the run.
 */
var HARD_LIMIT_MS = 6 * 60 * 1000;
var SAFETY_BUFFER_MS = 60 * 1000;
var TIME_BUDGET_MS = HARD_LIMIT_MS - SAFETY_BUFFER_MS; // 5 minutes

/** Give up on a row (and email the user once) after this many consecutive failures. */
var MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Drive folder that holds fetched audio, resolved lazily by getAudioFolder_():
 * a Script Property `AUDIO_FOLDER_ID` if one is set, otherwise a folder
 * named AUDIO_FOLDER_NAME is found-or-created and its id cached back into
 * Script Properties. This means no manual Drive setup is required before
 * the first run.
 */
var AUDIO_FOLDER_NAME = 'English Learning Audio';

/**
 * Optional Script Property. If the Apps Script project is bound to the
 * "English Learning" spreadsheet, SpreadsheetApp.getActiveSpreadsheet()
 * resolves it even from a time-driven trigger and no property is needed.
 * Set SPREADSHEET_ID only if this project is standalone.
 */
// (read at call time via PropertiesService - see getSpreadsheet_)

/** Diagnostics sheet this script writes to, created on first use if absent. */
var AUDIO_LOG_SHEET_NAME = 'audio_log';

/**
 * Safety switch for cleanupOldAudio(). MUST default to true: a user's first
 * run of the cleanup job has to be safe by default, i.e. it only reports
 * what *would* be trashed. Flip to false in the script editor only after
 * reading a dry run's audio_log output and confirming it looks right.
 */
var DRY_RUN = true;

/**
 * Trigger schedule. The spec asks for fetch to run "1 hour after Spark's
 * schedule" and cleanup "once a week", but Spark's own schedule lives in
 * the Gemini Spark UI (outside this repo) and isn't readable from here -
 * docs/prompts/spark-daily-lesson.md only says "every morning". FETCH_HOUR
 * assumes Spark is configured for ~07:00; change it here if that assumption
 * doesn't match the actual Spark schedule.
 */
var FETCH_HOUR = 8; // 1h after an assumed 07:00 Spark run
// Held as a name, not as ScriptApp.WeekDay.SUNDAY. Top-level statements run
// while Apps Script loads the project -- before the user has authorised it --
// and touching a Google service there makes the whole project fail to load
// with an unhelpful "unknown error", no matter which function was run.
// Resolved to the real enum inside installTriggers() instead.
var CLEANUP_WEEKDAY_NAME = 'SUNDAY';
var CLEANUP_HOUR = 3; // low-traffic hour, arbitrary otherwise

var FAILURE_PROP_KEY = 'AUDIO_FETCH_FAILURES';

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Scans the `lessons` sheet for rows with an empty audio_file_id, downloads
 * each one's audio_url, and writes the saved Drive file id back to column O.
 *
 * Time-budget guarantee: the elapsed-time check below runs ONLY between
 * rows, never inside the download -> validate -> save -> write-back sequence
 * for a single row (see processOneRow_). Once that sequence starts it always
 * runs to completion - either the id gets written back right after the Drive
 * save succeeds, or the row is recorded as a failure and nothing is saved to
 * Drive at all. So this function's own time-budget logic can never be the
 * reason a file exists in Drive with its id not yet written back. (This
 * covers everything under this script's control; it cannot rule out Google
 * itself hard-killing the process mid network call if a single fetch somehow
 * ran past the ~5-minute budget with the buffer already spent - unlikely for
 * a 120-180s audio clip under UrlFetchApp's own 50MB cap, but see the report
 * for the honest limitation.)
 */
function fetchPendingAudio() {
  var startTime = new Date().getTime();
  var sheet = getLessonsSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('[AudioFetcher] fetchPendingAudio: lessons sheet has no data rows.');
    return;
  }

  // Resolve the destination folder once, before touching any row. A folder
  // problem (ambiguous name, no access) is a whole-run problem, not a
  // per-lesson one: resolving it inside the loop instead would let every row
  // fail separately, each accumulating its own failure count and eventually
  // sending its own "gave up" email -- a burst of mail about a single root
  // cause. Letting it throw here stops the run once, loudly.
  getAudioFolder_();

  var colCount = Contract.LESSON_COLUMNS.length;
  var values = sheet.getRange(2, 1, lastRow - 1, colCount).getValues();

  var idxLessonId = Contract.LESSON_COLUMNS.indexOf('lesson_id');
  var idxAudioUrl = Contract.LESSON_COLUMNS.indexOf('audio_url');
  var idxAudioFileId = Contract.LESSON_COLUMNS.indexOf('audio_file_id');

  var processed = 0;
  var stoppedForTime = false;

  for (var i = 0; i < values.length; i++) {
    // Budget check: only ever between rows. See function doc comment above.
    if (new Date().getTime() - startTime > TIME_BUDGET_MS) {
      stoppedForTime = true;
      break;
    }

    var row = values[i];
    var sheetRow = i + 2; // 1-based sheet row; +1 to skip the header row
    var lessonId = normalizeLessonId_(row[idxLessonId]);
    var audioUrl = row[idxAudioUrl];
    var audioFileId = row[idxAudioFileId];

    if (!lessonId) continue;    // blank/incomplete row, nothing to key off
    if (audioFileId) continue;  // already fetched

    if (!audioUrl) {
      // Per spec, a Spark-written row has every column filled except
      // audio_file_id; a lesson_id with no audio_url is a corrupt row.
      // Not this function's job to fix - just note it and move on.
      logAudioEvent_(lessonId, 'skip_no_audio_url', 'row has lesson_id but empty audio_url');
      continue;
    }

    if (isAbandoned_(lessonId)) continue; // stop retrying a known-bad link daily

    processed++;
    processOneRow_(sheet, sheetRow, lessonId, audioUrl, idxAudioFileId);
  }

  Logger.log('[AudioFetcher] fetchPendingAudio done. rowsAttempted=' + processed +
    ' stoppedForTimeBudget=' + stoppedForTime +
    ' elapsedMs=' + (new Date().getTime() - startTime));
}

/**
 * Trashes MP3s for lessons older than Contract.AUDIO_RETENTION_WEEKS.
 *
 * A file is only ever trashed if BOTH hold:
 *   (a) its Drive file id resolves AND the file actually lives inside this
 *       script's designated audio folder (confirms this script saved it -
 *       see fileInFolder_)
 *   (b) the lesson_id it's linked from (via the lessons sheet's O column)
 *       parses to a date older than the retention cutoff
 * Any file whose ownership can't be confirmed this way is left untouched,
 * per spec ("任何無法確認歸屬的檔案一律不刪").
 *
 * DRY_RUN defaults to true: it only logs what would be trashed. Only when
 * DRY_RUN is false does it call setTrashed(true) - Drive's trash, not
 * permanent deletion, so a mistake is still recoverable for ~30 days - and
 * clear the row's audio_file_id so the web app never serves a dead id.
 */
function cleanupOldAudio() {
  var sheet = getLessonsSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('[AudioFetcher] cleanupOldAudio: lessons sheet has no data rows.');
    return;
  }

  var colCount = Contract.LESSON_COLUMNS.length;
  var values = sheet.getRange(2, 1, lastRow - 1, colCount).getValues();

  var idxLessonId = Contract.LESSON_COLUMNS.indexOf('lesson_id');
  var idxAudioFileId = Contract.LESSON_COLUMNS.indexOf('audio_file_id');

  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Contract.AUDIO_RETENTION_WEEKS * 7);

  var folder = getAudioFolder_();
  var folderId = folder.getId();

  var deleted = 0;
  var dryRunCandidates = 0;
  var skippedUnconfirmed = 0;

  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var sheetRow = i + 2;
    var lessonId = normalizeLessonId_(row[idxLessonId]);
    var fileId = row[idxAudioFileId];

    if (!lessonId || !fileId) continue; // nothing saved for this row, nothing to clean up

    var lessonDate = parseLessonDate_(lessonId);
    if (!lessonDate || lessonDate >= cutoff) continue; // not old enough (or unparseable -> leave alone)

    var file;
    try {
      file = DriveApp.getFileById(fileId);
    } catch (e) {
      logAudioEvent_(lessonId, 'cleanup_skip_unconfirmed', 'fileId=' + fileId + ' does not resolve: ' + e.message);
      skippedUnconfirmed++;
      continue;
    }

    if (!fileInFolder_(file, folderId)) {
      logAudioEvent_(lessonId, 'cleanup_skip_unconfirmed', 'fileId=' + fileId + ' is not inside the AudioFetcher folder, refusing to touch it');
      skippedUnconfirmed++;
      continue;
    }

    // Ownership confirmed and old enough. Log BEFORE mutating anything.
    if (DRY_RUN) {
      logAudioEvent_(lessonId, 'cleanup_dry_run', 'would trash fileId=' + fileId);
      dryRunCandidates++;
      continue;
    }

    logAudioEvent_(lessonId, 'cleanup_delete', 'trashing fileId=' + fileId);
    // DriveApp trash (not a permanent delete): recoverable from Drive's
    // trash for ~30 days if this ever turns out to be wrong.
    file.setTrashed(true);
    sheet.getRange(sheetRow, idxAudioFileId + 1).setValue('');
    deleted++;
  }

  Logger.log('[AudioFetcher] cleanupOldAudio done. dryRun=' + DRY_RUN +
    ' deleted=' + deleted +
    ' dryRunCandidates=' + dryRunCandidates +
    ' skippedUnconfirmed=' + skippedUnconfirmed);
}

/**
 * (Re)installs this script's two time-driven triggers. Always removes any
 * existing triggers pointing at fetchPendingAudio/cleanupOldAudio first, so
 * running this more than once never results in duplicate triggers firing
 * the same job twice a day.
 */
function installTriggers() {
  removeTriggers_(['fetchPendingAudio', 'cleanupOldAudio']);

  ScriptApp.newTrigger('fetchPendingAudio')
    .timeBased()
    .everyDays(1)
    .atHour(FETCH_HOUR)
    .create();

  ScriptApp.newTrigger('cleanupOldAudio')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay[CLEANUP_WEEKDAY_NAME])
    .atHour(CLEANUP_HOUR)
    .create();

  Logger.log('[AudioFetcher] triggers installed: fetchPendingAudio daily @' + FETCH_HOUR +
    ':00, cleanupOldAudio weekly (' + CLEANUP_WEEKDAY_NAME + ') @' + CLEANUP_HOUR + ':00');
}

// ---------------------------------------------------------------------------
// fetchPendingAudio helpers
// ---------------------------------------------------------------------------

/**
 * Downloads, validates and (on success) persists the audio for one row.
 * Always runs to completion once called: every branch either returns after
 * recording a failure (nothing written to Drive or the sheet) or returns
 * after both the Drive save AND the sheet write-back have happened. There
 * is no path that saves a file without writing back its id.
 */
function processOneRow_(sheet, sheetRow, lessonId, audioUrl, idxAudioFileId) {
  try {
    var response = UrlFetchApp.fetch(audioUrl, { muteHttpExceptions: true });
    var status = response.getResponseCode();
    if (status !== 200) {
      failRow_(lessonId, 'HTTP ' + status + ' fetching ' + audioUrl);
      return;
    }

    var blob = response.getBlob();
    var size = blob.getBytes().length;
    var mimeType = blob.getContentType() || '';

    // Runtime checks required by spec: size > 0 and MIME type is audio/*.
    // Either failing means we do NOT save anything and do NOT touch column
    // O - it stays empty and gets retried tomorrow (up to the failure cap).
    if (size <= 0) {
      failRow_(lessonId, 'downloaded file is empty (0 bytes)');
      return;
    }
    if (mimeType.indexOf('audio/') !== 0) {
      failRow_(lessonId, 'unexpected MIME type "' + mimeType + '" (expected audio/*)');
      return;
    }

    var folder = getAudioFolder_();
    blob.setName(lessonId + '.mp3');
    var file = folder.createFile(blob);
    try {
      sheet.getRange(sheetRow, idxAudioFileId + 1).setValue(file.getId());
    } catch (writeBackError) {
      // The file made it into Drive but its id never made it back into the
      // sheet (e.g. a transient Sheets API error). Left alone, the row
      // still looks empty next run, so it gets re-downloaded and re-saved
      // forever, piling up orphaned duplicates. Trash this one now so the
      // row simply retries tomorrow like any other failure, with nothing
      // left behind in Drive.
      try {
        file.setTrashed(true);
      } catch (trashError) {
        logAudioEvent_(lessonId, 'orphan_trash_failed',
          'fileId=' + file.getId() + ' could not be trashed after write-back failure (' +
          writeBackError.message + '): ' + trashError.message);
      }
      throw writeBackError;
    }
    clearFailure_(lessonId);
    logAudioEvent_(lessonId, 'fetch_success', 'fileId=' + file.getId() + ' bytes=' + size);
  } catch (e) {
    failRow_(lessonId, 'exception: ' + e.message);
  }
}

/** Records one failed attempt and, on the attempt that crosses the cap, emails the user once. */
function failRow_(lessonId, reason) {
  var entry = recordFailure_(lessonId, reason);
  logAudioEvent_(lessonId, 'fetch_fail', 'attempt=' + entry.count + ' reason=' + reason);
  if (entry.abandoned && entry.count === MAX_CONSECUTIVE_FAILURES + 1) {
    // Fires exactly once: the moment count crosses the cap. isAbandoned_
    // short-circuits every future scan for this lessonId, so count can
    // never grow past this value and this branch can never re-fire.
    notifyAbandoned_(lessonId, reason);
    logAudioEvent_(lessonId, 'abandoned', 'notified user after ' + entry.count + ' consecutive failures');
  }
}

function notifyAbandoned_(lessonId, reason) {
  var email = Session.getEffectiveUser().getEmail();
  if (!email) {
    Logger.log('[AudioFetcher] cannot email: no effective user email available');
    return;
  }
  var subject = 'English Learning: audio fetch gave up on ' + lessonId;
  var body = [
    'AudioFetcher.gs stopped retrying the audio download for lesson ' + lessonId,
    'after ' + MAX_CONSECUTIVE_FAILURES + ' consecutive failures.',
    '',
    'Last error: ' + reason,
    '',
    'audio_file_id for this row stays empty and will NOT be retried',
    'automatically. Check audio_url in the lessons sheet.',
    '',
    'To retry manually: delete the "' + lessonId + '" entry from the',
    'AUDIO_FETCH_FAILURES script property (Project Settings > Script',
    'properties), then run fetchPendingAudio() again.'
  ].join('\n');
  MailApp.sendEmail(email, subject, body);
}

// ---------------------------------------------------------------------------
// Failure-count store (Script Properties, keyed by lesson_id)
// ---------------------------------------------------------------------------

function getFailureStore_() {
  var raw = PropertiesService.getScriptProperties().getProperty(FAILURE_PROP_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    return {}; // corrupt property value - start clean rather than throw
  }
}

function saveFailureStore_(store) {
  PropertiesService.getScriptProperties().setProperty(FAILURE_PROP_KEY, JSON.stringify(store));
}

/** Increments the consecutive-failure count for a lesson and returns the updated entry. */
function recordFailure_(lessonId, reason) {
  var store = getFailureStore_();
  var entry = store[lessonId] || { count: 0, abandoned: false };
  entry.count += 1;
  entry.lastError = reason;
  entry.lastAttempt = new Date().toISOString();
  if (entry.count > MAX_CONSECUTIVE_FAILURES) {
    entry.abandoned = true;
  }
  store[lessonId] = entry;
  saveFailureStore_(store);
  return entry;
}

/** Called on a successful fetch so a one-off past failure doesn't linger forever. */
function clearFailure_(lessonId) {
  var store = getFailureStore_();
  if (store[lessonId]) {
    delete store[lessonId];
    saveFailureStore_(store);
  }
}

function isAbandoned_(lessonId) {
  var store = getFailureStore_();
  return !!(store[lessonId] && store[lessonId].abandoned);
}

// ---------------------------------------------------------------------------
// Shared helpers (spreadsheet, folder, logging, triggers)
// ---------------------------------------------------------------------------

/**
 * Resolves the "English Learning" spreadsheet. Prefers a Script Property
 * SPREADSHEET_ID (for a standalone script); falls back to
 * getActiveSpreadsheet(), which works even from a time-driven trigger when
 * this Apps Script project is container-bound to that spreadsheet.
 */
function getSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error(
    'No spreadsheet available. Either bind this Apps Script project to the ' +
    '"English Learning" spreadsheet, or set a Script Property SPREADSHEET_ID.'
  );
}

function getLessonsSheet_() {
  var sheet = getSpreadsheet_().getSheetByName(Contract.SHEETS.LESSONS);
  if (!sheet) throw new Error('Sheet "' + Contract.SHEETS.LESSONS + '" not found.');
  return sheet;
}

function getAudioLogSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(AUDIO_LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(AUDIO_LOG_SHEET_NAME);
    sheet.appendRow(['timestamp', 'lesson_id', 'action', 'detail']);
  }
  return sheet;
}

/** Writes every fetch/cleanup event to both the Apps Script execution log and the audio_log sheet. */
function logAudioEvent_(lessonId, action, detail) {
  Logger.log('[AudioFetcher] ' + action + ' lesson=' + lessonId + ' ' + detail);
  try {
    getAudioLogSheet_().appendRow([new Date().toISOString(), lessonId, action, detail]);
  } catch (e) {
    // Logging must never break the main job. The execution log line above
    // already has the record even if the sheet write itself fails.
    Logger.log('[AudioFetcher] failed to write audio_log sheet: ' + e.message);
  }
}

/**
 * Resolves the Drive folder audio gets saved into. Caches the id in Script
 * Properties on first resolution so repeated runs don't need to search by
 * name, and so cleanupOldAudio() can check "is this file inside our
 * folder?" cheaply.
 */
function getAudioFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('AUDIO_FOLDER_ID');
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (e) {
      Logger.log('[AudioFetcher] stored AUDIO_FOLDER_ID ' + id + ' no longer resolves: ' + e.message);
    }
  }
  var existing = DriveApp.getFoldersByName(AUDIO_FOLDER_NAME);
  var matches = [];
  while (existing.hasNext() && matches.length < 2) {
    matches.push(existing.next());
  }

  var folder;
  if (matches.length === 0) {
    folder = DriveApp.createFolder(AUDIO_FOLDER_NAME);
  } else if (matches.length === 1) {
    folder = matches[0];
  } else {
    // 2+ same-named folders (e.g. one the user made plus one someone shared
    // with them): picking either one silently risks saving audio into the
    // wrong folder, and permanently breaks cleanupOldAudio's ownership
    // check (fileInFolder_) against whichever one we didn't pick. Log
    // clearly and abort instead of guessing.
    var msg = 'Found ' + matches.length + '+ Drive folders named "' + AUDIO_FOLDER_NAME +
      '"; refusing to guess which one to use. Rename/remove the extra folder(s), ' +
      'or set the Script Property AUDIO_FOLDER_ID to the correct folder\'s id.';
    logAudioEvent_(null, 'audio_folder_ambiguous', msg);
    throw new Error('[AudioFetcher] ' + msg);
  }

  props.setProperty('AUDIO_FOLDER_ID', folder.getId());
  return folder;
}

function fileInFolder_(file, folderId) {
  var parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === folderId) return true;
  }
  return false;
}

/**
 * Normalizes a lesson_id cell value to a "YYYY-MM-DD" string. Google Sheets
 * can silently store a plain-looking "2026-09-02" entry as a real Date
 * value instead of text, depending on the column's cell format - this
 * accepts either shape so that quirk can't corrupt failure-store keys,
 * Drive file names, or the age comparison in cleanupOldAudio.
 */
function normalizeLessonId_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return value;
}

/**
 * Parses a lesson_id (YYYY-MM-DD, see Contract.LESSON_COLUMNS) into a local
 * Date at midnight. Built by hand instead of `new Date(lessonId)` because
 * the built-in ISO-date parser treats a bare YYYY-MM-DD as UTC midnight,
 * which can silently shift by a day against the script's own timezone when
 * compared to `new Date()`.
 */
function parseLessonDate_(lessonId) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(lessonId);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function removeTriggers_(handlerNames) {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (handlerNames.indexOf(triggers[i].getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}
