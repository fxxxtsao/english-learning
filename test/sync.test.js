'use strict';

/**
 * Tests for js/sync.js -- progress merge + offline queue.
 *
 * This is the highest-risk seam in the project (see
 * docs/specs/2026-09-02-practice-web-app.md, 測試決策): a bug here silently
 * drops a few weeks of practice records instead of failing loudly. Every
 * test either checks one of the three stated invariants directly, or
 * reproduces one of the three scenarios named in the spec.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Sync = require('../js/sync.js');
const Contract = require('../js/contract.js');

const mergeProgress = Sync.mergeProgress;
const enqueue = Sync.enqueue;
const dequeueConfirmed = Sync.dequeueConfirmed;
const makeRecord = Sync.makeRecord;

/** Builds a minimal, valid-shaped progress record for tests. */
function rec(recordId, overrides) {
  const base = {
    record_id: recordId,
    item_id: '2026-09-01:reading_q:0',
    item_type: 'reading_q',
    lesson_id: '2026-09-01',
    answered_at: '2026-09-01T00:00:00.000Z',
    correct: true,
    device: 'test-device',
    client_version: Contract.CLIENT_VERSION
  };
  return Object.assign(base, overrides);
}

function idsOf(records) {
  return records.map(function (r) { return r.record_id; }).sort();
}

// ---------------------------------------------------------------------------
// Invariant (a): no record lost -- merged record_id set == union of inputs
// ---------------------------------------------------------------------------

test('mergeProgress: merged record_id set equals the union of both inputs', () => {
  const local = [rec('local-1'), rec('local-2'), rec('shared-1')];
  const remote = [rec('remote-1'), rec('shared-1')];

  const { merged } = mergeProgress(local, remote);

  assert.deepEqual(
    idsOf(merged),
    ['local-1', 'local-2', 'remote-1', 'shared-1']
  );
});

test('mergeProgress: empty local and empty remote produce empty result', () => {
  const result = mergeProgress([], []);
  assert.deepEqual(result.toUpload, []);
  assert.deepEqual(result.merged, []);
});

test('mergeProgress: remote-only records are not dropped and are not re-uploaded', () => {
  const remoteOnly = rec('remote-only-1');
  const { toUpload, merged } = mergeProgress([], [remoteOnly]);

  assert.deepEqual(toUpload, []);
  assert.deepEqual(idsOf(merged), ['remote-only-1']);
});

// ---------------------------------------------------------------------------
// Invariant (b): resending the same record any number of times -> one entry
// ---------------------------------------------------------------------------

test('mergeProgress: the same record_id repeated within one side collapses to one', () => {
  const same = rec('dup-1');
  const { merged } = mergeProgress([same, same, same], []);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].record_id, 'dup-1');
});

test('scenario: resending the same record three sync cycles in a row yields one merged record', () => {
  const record = rec('resend-1');
  let localQueue = [record];
  let remoteRecords = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    const { toUpload, merged } = mergeProgress(localQueue, remoteRecords);
    assert.equal(merged.length, 1, 'attempt ' + attempt + ': merged must stay at one record');

    // Simulate: whatever was uploaded this round, the server now has too.
    // The local queue is left untouched (still unconfirmed) to mimic a
    // caller that resends before receiving/acting on a confirmation --
    // this is the "resend the same record" case, not the confirmed-dequeue case.
    for (const uploaded of toUpload) {
      if (!remoteRecords.some((r) => r.record_id === uploaded.record_id)) {
        remoteRecords = remoteRecords.concat([uploaded]);
      }
    }
  }

  const final = mergeProgress(localQueue, remoteRecords);
  assert.equal(final.merged.length, 1);
  assert.deepEqual(final.toUpload, [], 'record already on the server must not be re-flagged for upload');
});

// ---------------------------------------------------------------------------
// Invariant (c): merge order does not matter
// ---------------------------------------------------------------------------

test('mergeProgress: mergeProgress(A, B) and mergeProgress(B, A) produce the same merged array', () => {
  const a = [rec('a-1'), rec('shared-1')];
  const b = [rec('b-1'), rec('shared-1')];

  const forward = mergeProgress(a, b);
  const backward = mergeProgress(b, a);

  assert.deepEqual(forward.merged, backward.merged);
});

test('mergeProgress: order independence holds even when a shared record_id has diverging content', () => {
  // Should never happen in practice (record_id is a UUID minted once by
  // makeRecord), but mergeProgress must still resolve it deterministically
  // regardless of which side the conflicting copy came in on.
  const older = rec('conflict-1', { answered_at: '2026-09-01T00:00:00.000Z', correct: true });
  const newer = rec('conflict-1', { answered_at: '2026-09-02T00:00:00.000Z', correct: false });

  const forward = mergeProgress([older], [newer]);
  const backward = mergeProgress([newer], [older]);

  assert.deepEqual(forward.merged, backward.merged);
  // The earlier-written copy is treated as the fact (append-only: first
  // write wins), regardless of which argument position it arrived in.
  assert.equal(forward.merged[0].answered_at, '2026-09-01T00:00:00.000Z');
  assert.equal(backward.merged[0].answered_at, '2026-09-01T00:00:00.000Z');
});

// ---------------------------------------------------------------------------
// Scenario 1: two devices accumulate offline, then both sync -- nothing lost
// ---------------------------------------------------------------------------

test('scenario: two devices offline-accumulate independently, both records survive the merge', () => {
  const deviceA = [rec('a-1'), rec('a-2')];
  const deviceB = [rec('b-1'), rec('b-2')];

  // Device B already synced (server == deviceB's records). Device A syncs next.
  const remoteAfterB = deviceB;
  const { toUpload, merged } = mergeProgress(deviceA, remoteAfterB);

  assert.deepEqual(idsOf(toUpload), ['a-1', 'a-2']);
  assert.deepEqual(idsOf(merged), ['a-1', 'a-2', 'b-1', 'b-2']);
});

// ---------------------------------------------------------------------------
// Scenario 2: upload interrupted mid-way -- only confirmed ids are dequeued
// ---------------------------------------------------------------------------

test('scenario: partial server confirmation leaves unconfirmed records queued for retry', () => {
  const queue = [rec('p-1'), rec('p-2'), rec('p-3')];

  // Connection drops after the server confirms only p-1 and p-3.
  const confirmedIds = ['p-1', 'p-3'];
  const remaining = dequeueConfirmed(queue, confirmedIds);

  assert.deepEqual(idsOf(remaining), ['p-2']);

  // Next sync attempt: the still-queued record must still round-trip
  // through mergeProgress without being lost or duplicated.
  const remoteAfterPartialConfirm = [rec('p-1'), rec('p-3')];
  const { toUpload, merged } = mergeProgress(remaining, remoteAfterPartialConfirm);

  assert.deepEqual(idsOf(toUpload), ['p-2']);
  assert.deepEqual(idsOf(merged), ['p-1', 'p-2', 'p-3']);
});

test('dequeueConfirmed: confirming nothing leaves the whole queue untouched', () => {
  const queue = [rec('x-1'), rec('x-2')];
  const remaining = dequeueConfirmed(queue, []);
  assert.deepEqual(remaining, queue);
});

test('dequeueConfirmed: does not mutate the input queue', () => {
  const queue = [rec('x-1'), rec('x-2')];
  const copy = queue.slice();
  dequeueConfirmed(queue, ['x-1']);
  assert.deepEqual(queue, copy);
});

// ---------------------------------------------------------------------------
// enqueue
// ---------------------------------------------------------------------------

test('enqueue: adds a new record without mutating the original array', () => {
  const original = [rec('e-1')];
  const originalSnapshot = original.slice();

  const next = enqueue(original, rec('e-2'));

  assert.deepEqual(idsOf(next), ['e-1', 'e-2']);
  assert.deepEqual(original, originalSnapshot, 'input array must not be mutated');
  assert.notEqual(next, original, 'enqueue must return a new array');
});

test('enqueue: adding a record whose record_id is already queued does not duplicate it', () => {
  const original = [rec('e-1')];
  const next = enqueue(original, rec('e-1', { correct: false }));

  assert.equal(next.length, 1);
  assert.equal(next[0].correct, true, 'the already-queued (earlier) copy is kept, not overwritten');
});

test('enqueue: starting from an empty queue works', () => {
  const next = enqueue([], rec('e-1'));
  assert.deepEqual(idsOf(next), ['e-1']);
});

// ---------------------------------------------------------------------------
// makeRecord
// ---------------------------------------------------------------------------

test('makeRecord: builds a record with a UUID, the given fields, and the client version', () => {
  const record = makeRecord({
    item_id: '2026-09-01:vocab:2',
    item_type: 'vocab',
    lesson_id: '2026-09-01',
    correct: false,
    device: 'iphone',
    answered_at: '2026-09-01T12:00:00.000Z'
  });

  assert.match(
    record.record_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  );
  assert.equal(record.item_id, '2026-09-01:vocab:2');
  assert.equal(record.item_type, 'vocab');
  assert.equal(record.lesson_id, '2026-09-01');
  assert.equal(record.correct, false);
  assert.equal(record.device, 'iphone');
  assert.equal(record.answered_at, '2026-09-01T12:00:00.000Z');
  assert.equal(record.client_version, Contract.CLIENT_VERSION);
});

test('makeRecord: two calls produce different record_ids', () => {
  const a = makeRecord({ item_id: 'x', item_type: 'reading_q', lesson_id: 'l', correct: true, device: 'd', answered_at: 't' });
  const b = makeRecord({ item_id: 'x', item_type: 'reading_q', lesson_id: 'l', correct: true, device: 'd', answered_at: 't' });
  assert.notEqual(a.record_id, b.record_id);
});

test('makeRecord: throws a clear error for an invalid item_type', () => {
  assert.throws(
    () => makeRecord({ item_id: 'x', item_type: 'not_a_real_type', lesson_id: 'l', correct: true, device: 'd', answered_at: 't' }),
    /item_type/
  );
});

for (const itemType of Contract.ITEM_TYPES) {
  test('makeRecord: accepts item_type "' + itemType + '" from Contract.ITEM_TYPES', () => {
    const record = makeRecord({ item_id: 'x', item_type: itemType, lesson_id: 'l', correct: true, device: 'd', answered_at: 't' });
    assert.equal(record.item_type, itemType);
  });
}
