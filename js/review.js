/**
 * Review scheduling and adaptive difficulty for the English learning project.
 *
 * Pure functions only: no Date.now(), no network, no localStorage. Time is
 * always passed in by the caller, which is what makes these trivially
 * testable and safe to call from the Service Worker as well as the page.
 *
 * Loaded in the same three runtimes as js/contract.js (browser <script>,
 * Service Worker via importScripts, Node require), so this file must stay
 * free of `import`/`export` and of anything newer than ES2017. Contract
 * must already be available (global `Contract`, or require-able as
 * ./contract.js) before this file runs.
 *
 * Source of truth: docs/specs/2026-09-02-practice-web-app.md
 */
(function (root, factory) {
  var Contract = (typeof module !== 'undefined' && module.exports)
    ? require('./contract.js')
    : root.Contract;
  var api = factory(Contract);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.Review = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Contract) {
  'use strict';

  var DAY_MS = 24 * 60 * 60 * 1000;

  /** Accepts a Date instance or an ISO8601 string; always returns a Date. */
  function toDate(value) {
    return value instanceof Date ? value : new Date(value);
  }

  /** Groups records by item_id. Returns { item_id: [records...] }. */
  function groupByItem(records) {
    var groups = {};
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      if (!groups[record.item_id]) {
        groups[record.item_id] = [];
      }
      groups[record.item_id].push(record);
    }
    return groups;
  }

  function byAnsweredAtAsc(a, b) {
    return toDate(a.answered_at).getTime() - toDate(b.answered_at).getTime();
  }

  /**
   * Replays one item's answer history (already sorted chronologically) and
   * returns the interval level that applies after the last answer.
   *
   * The level starts at 0 (the first entry of INTERVALS_DAYS). Every
   * correct answer advances one level (capped at the last level); every
   * wrong answer resets to level 0. So three correct answers in a row move
   * the level 0 -> 1 -> 2 -> 3, landing on the 4th interval (14 days).
   */
  function replayIntervalIndex(sortedItemRecords) {
    var maxIndex = Contract.REVIEW.INTERVALS_DAYS.length - 1;
    var index = 0;
    for (var i = 0; i < sortedItemRecords.length; i++) {
      if (sortedItemRecords[i].correct) {
        index = Math.min(index + 1, maxIndex);
      } else {
        index = 0;
      }
    }
    return index;
  }

  /**
   * Computes the due items at `now` from a (possibly unordered) list of
   * answer records. Only items that already have at least one record are
   * considered here -- "never practised" items are the caller's concern
   * (they are prioritized ahead of due items, per REVIEW.NEW_ITEM_PRIORITY).
   *
   * @param {Array} records - PROGRESS_COLUMNS-shaped rows, any order.
   * @param {Date|string} now - current time, as a Date or an ISO8601 string.
   * @returns {Array} due items, most-overdue first, each shaped
   *   { item_id, item_type, lesson_id, due_at, interval_index, last_answered_at }.
   */
  function scheduleNext(records, now) {
    var nowMs = toDate(now).getTime();
    var groups = groupByItem(records);
    var dueItems = [];

    Object.keys(groups).forEach(function (itemId) {
      var sorted = groups[itemId].slice().sort(byAnsweredAtAsc);
      var lastRecord = sorted[sorted.length - 1];
      var intervalIndex = replayIntervalIndex(sorted);
      var lastAnsweredAt = toDate(lastRecord.answered_at);
      var days = Contract.REVIEW.INTERVALS_DAYS[intervalIndex];

      // Deliberate choice: round the last answer down to LOCAL midnight
      // before adding the interval, instead of adding a strict 24h *
      // days from the exact answer time. This app is used by one person
      // who opens it once during a commute and once during a work break,
      // not at a fixed hour -- with a plain "+24h" calculation, answering
      // at 11pm would mean the item isn't due again until 11pm the *next*
      // day, which reads as "not due tomorrow" to a normal user. Flooring
      // to local midnight makes "1 day later" mean "the next calendar day"
      // instead, matching that expectation.
      var localMidnight = new Date(lastAnsweredAt.getFullYear(), lastAnsweredAt.getMonth(), lastAnsweredAt.getDate());
      var dueAt = new Date(localMidnight.getTime() + days * DAY_MS);

      // Boundary: an item due exactly at `now` counts as due.
      if (dueAt.getTime() <= nowMs) {
        dueItems.push({
          item_id: itemId,
          item_type: lastRecord.item_type,
          lesson_id: lastRecord.lesson_id,
          due_at: dueAt.toISOString(),
          interval_index: intervalIndex,
          last_answered_at: lastAnsweredAt.toISOString()
        });
      }
    });

    // Most overdue (earliest due_at) first.
    dueItems.sort(function (a, b) {
      return new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
    });

    return dueItems;
  }

  /**
   * Adjusts the CEFR level based on the rolling accuracy of the most
   * recent LEVEL_ADJUST.WINDOW answers (across all item types).
   *
   * Boundary decision (deliberately strict, matching the spec wording
   * "高於"/"低於" -- above/below, not "at or above/below"):
   *   - accuracy >  UP_ABOVE   -> level up
   *   - accuracy <  DOWN_BELOW -> level down
   *   - accuracy === UP_ABOVE or === DOWN_BELOW -> no change (falls in
   *     the "in between" band, same as any other mid-range accuracy)
   *
   * @param {Array} records - PROGRESS_COLUMNS-shaped rows, any order.
   * @param {string} currentLevel - current CEFR level.
   * @returns {string} the (possibly unchanged) CEFR level.
   */
  function adjustLevel(records, currentLevel) {
    if (!Contract.isCefrLevel(currentLevel)) {
      return Contract.DEFAULT_LEVEL;
    }

    var recentWindow = records
      .slice()
      .sort(byAnsweredAtAsc)
      .slice(-Contract.LEVEL_ADJUST.WINDOW);

    if (recentWindow.length < Contract.LEVEL_ADJUST.MIN_SAMPLE) {
      return currentLevel;
    }

    var correctCount = recentWindow.filter(function (r) { return r.correct; }).length;
    var accuracy = correctCount / recentWindow.length;

    if (accuracy > Contract.LEVEL_ADJUST.UP_ABOVE) {
      return Contract.shiftLevel(currentLevel, 1);
    }
    if (accuracy < Contract.LEVEL_ADJUST.DOWN_BELOW) {
      return Contract.shiftLevel(currentLevel, -1);
    }
    return currentLevel;
  }

  return {
    scheduleNext: scheduleNext,
    adjustLevel: adjustLevel
  };
});
