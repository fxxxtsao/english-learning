/**
 * Progress sync: merging local/remote answer records and managing the
 * offline upload queue.
 *
 * See docs/specs/2026-09-02-practice-web-app.md, sections "實作決策 /
 * 答題紀錄採 append-only" + "離線佇列", and the mergeProgress row in
 * "測試決策". Records are append-only: `record_id` is the primary key and
 * an existing record is never overwritten.
 *
 * This file is loaded in the same three runtimes as js/contract.js, so it
 * must stay free of `import`/`export` and of anything newer than ES2017:
 *   1. the browser, via a plain <script> tag (after contract.js)
 *   2. the Service Worker, via importScripts()
 *   3. Node, via require() in the tests
 *
 * All functions here are pure: storage (localStorage, IndexedDB, ...) and
 * the current time are always passed in by the caller, never touched here.
 */
(function (root, factory) {
  var Contract = (typeof module !== 'undefined' && module.exports)
    ? require('./contract.js')
    : root.Contract;
  var api = factory(Contract);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.Sync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Contract) {
  'use strict';

  /** Same global-object detection as the outer UMD wrapper, for crypto lookup below. */
  var globalScope = typeof globalThis !== 'undefined' ? globalThis : this;

  /**
   * RFC4122 v4 UUID built from Math.random(). Only used when neither
   * crypto.randomUUID() nor Node's require('crypto').randomUUID() is
   * available (old browsers, Apps Script). Not cryptographically strong,
   * but record_id only needs to be unique enough to dedupe one person's
   * answer log, so that is not a concern here.
   */
  function randomUUIDFallback() {
    var template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
    return template.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /** Prefers the platform UUID generator, falls back when it is missing. */
  function generateUUID() {
    if (globalScope.crypto && typeof globalScope.crypto.randomUUID === 'function') {
      return globalScope.crypto.randomUUID();
    }
    if (typeof require === 'function') {
      try {
        var nodeCrypto = require('crypto');
        if (nodeCrypto && typeof nodeCrypto.randomUUID === 'function') {
          return nodeCrypto.randomUUID();
        }
      } catch (e) {
        // 'crypto' not resolvable in this runtime (e.g. Apps Script) -- fall through.
      }
    }
    return randomUUIDFallback();
  }

  /**
   * Decides which copy of a record wins when the same record_id shows up
   * more than once (e.g. a record the server already confirmed is still
   * sitting in the local queue).
   *
   * Data is append-only, so in the expected case both copies are
   * byte-identical and this choice does not matter. As a defensive
   * tie-break for the case where they somehow differ, we treat the copy
   * with the earlier `answered_at` as the one that was actually written
   * first -- the fact -- and keep it, falling back to a plain string
   * comparison of the serialized record for a total order when
   * `answered_at` ties. Both rules look only at record content, never at
   * which argument position a record arrived in; that is what makes
   * mergeProgress(A, B) and mergeProgress(B, A) agree on `merged`.
   */
  function pickCanonical(a, b) {
    if (a === b) return a;
    var aTime = a.answered_at || '';
    var bTime = b.answered_at || '';
    if (aTime !== bTime) {
      return aTime < bTime ? a : b;
    }
    var aStr = JSON.stringify(a);
    var bStr = JSON.stringify(b);
    return aStr <= bStr ? a : b;
  }

  /**
   * Merges a local offline queue with the set of records already known to
   * the server.
   *
   * - `toUpload`: records that exist locally but not remotely -- the ones
   *   this device still needs to send.
   * - `merged`: the deduplicated union of both sides, sorted by record_id
   *   so the result does not depend on argument order (see pickCanonical).
   *
   * Invariants (see test/sync.test.js):
   *   a. no record lost: record_ids in `merged` == record_ids in
   *      localQueue union remoteRecords
   *   b. resending the same record any number of times still yields one
   *      entry in `merged`
   *   c. mergeProgress(A, B) and mergeProgress(B, A) produce the same
   *      `merged` (array, content and order)
   */
  function mergeProgress(localQueue, remoteRecords) {
    localQueue = localQueue || [];
    remoteRecords = remoteRecords || [];

    var byId = {};

    function absorb(list) {
      for (var i = 0; i < list.length; i++) {
        var record = list[i];
        var existing = byId[record.record_id];
        byId[record.record_id] = existing ? pickCanonical(existing, record) : record;
      }
    }

    absorb(localQueue);
    absorb(remoteRecords);

    var remoteIds = {};
    for (var r = 0; r < remoteRecords.length; r++) {
      remoteIds[remoteRecords[r].record_id] = true;
    }

    var toUpload = [];
    var seenLocal = {};
    for (var l = 0; l < localQueue.length; l++) {
      var localRecord = localQueue[l];
      if (remoteIds[localRecord.record_id]) continue;
      if (seenLocal[localRecord.record_id]) continue;
      seenLocal[localRecord.record_id] = true;
      toUpload.push(byId[localRecord.record_id]);
    }

    var mergedIds = Object.keys(byId).sort();
    var merged = mergedIds.map(function (id) {
      return byId[id];
    });

    return { toUpload: toUpload, merged: merged };
  }

  /**
   * Adds a record to the offline queue. Returns a new array; the input
   * queue is never mutated. A record whose record_id is already queued is
   * not added again.
   */
  function enqueue(queue, record) {
    var alreadyQueued = queue.some(function (r) {
      return r.record_id === record.record_id;
    });
    if (alreadyQueued) {
      return queue.slice();
    }
    return queue.concat([record]);
  }

  /**
   * Removes only the records the server has confirmed it wrote
   * (confirmedIds). Anything not confirmed stays in the queue -- this is
   * what lets a dropped connection be retried safely instead of silently
   * losing answers.
   */
  function dequeueConfirmed(queue, confirmedIds) {
    var confirmedSet = {};
    for (var i = 0; i < confirmedIds.length; i++) {
      confirmedSet[confirmedIds[i]] = true;
    }
    return queue.filter(function (record) {
      return !confirmedSet[record.record_id];
    });
  }

  /**
   * Builds a new progress record for one answered item.
   *
   * `answered_at` is not defaulted here -- the caller owns "now" (see
   * docs/specs 測試決策: these functions stay pure by taking time in as a
   * parameter, never reading the clock themselves). If a caller omits it,
   * that value is simply carried through as-is; it is the caller's job to
   * supply it.
   *
   * Throws if item_type is not one of Contract.ITEM_TYPES -- an invalid
   * item_type is a programming bug, not bad input data, so it should fail
   * loudly and immediately rather than produce a record that will only be
   * noticed as corrupt much later.
   */
  function makeRecord(options) {
    options = options || {};
    var itemType = options.item_type;
    if (Contract.ITEM_TYPES.indexOf(itemType) === -1) {
      throw new Error(
        'makeRecord: invalid item_type "' + itemType + '", expected one of ' +
        Contract.ITEM_TYPES.join(', ')
      );
    }
    return {
      record_id: generateUUID(),
      item_id: options.item_id,
      item_type: itemType,
      lesson_id: options.lesson_id,
      answered_at: options.answered_at,
      correct: options.correct,
      device: options.device,
      client_version: Contract.CLIENT_VERSION
    };
  }

  return {
    mergeProgress: mergeProgress,
    enqueue: enqueue,
    dequeueConfirmed: dequeueConfirmed,
    makeRecord: makeRecord
  };
});
