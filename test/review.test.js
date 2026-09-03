'use strict';

// Tests for js/review.js. Node-only (node:test + node:assert), no external
// packages. Pure-function seam: only feed data in, only check return
// values -- no DOM, no network, no localStorage.

const test = require('node:test');
const assert = require('node:assert/strict');

const Contract = require('../js/contract.js');
const Review = require('../js/review.js');

const DAY_MS = 24 * 60 * 60 * 1000;

function isoPlusDays(isoString, days) {
  return new Date(new Date(isoString).getTime() + days * DAY_MS).toISOString();
}

// scheduleNext floors the last-answered time to LOCAL midnight before
// adding the interval (see js/review.js for the rationale). Tests that
// assert an exact due_at must predict that same local-midnight rounding
// rather than assuming a strict "+24h * days" from the exact timestamp.
function localMidnightPlusDays(isoString, days) {
  const d = new Date(isoString);
  const localMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return new Date(localMidnight.getTime() + days * DAY_MS).toISOString();
}

let recordCounter = 0;
function makeRecord(overrides) {
  recordCounter += 1;
  return Object.assign(
    {
      record_id: 'r' + recordCounter,
      item_id: 'lesson-1:reading_q:0',
      item_type: 'reading_q',
      lesson_id: 'lesson-1',
      answered_at: '2026-01-01T00:00:00.000Z',
      correct: true,
      device: 'test-device',
      client_version: Contract.CLIENT_VERSION
    },
    overrides
  );
}

// ---------------------------------------------------------------------------
// scheduleNext
// ---------------------------------------------------------------------------

test('scheduleNext: three consecutive correct answers advance the interval to the 4th level (14 days)', () => {
  const records = [
    makeRecord({ answered_at: '2026-01-01T00:00:00.000Z', correct: true }),
    makeRecord({ answered_at: '2026-01-02T00:00:00.000Z', correct: true }),
    makeRecord({ answered_at: '2026-01-03T00:00:00.000Z', correct: true })
  ];
  const expectedDueAt = localMidnightPlusDays('2026-01-03T00:00:00.000Z', 14);
  const now = isoPlusDays(expectedDueAt, 1); // comfortably past due

  const due = Review.scheduleNext(records, now);

  assert.equal(due.length, 1);
  assert.equal(due[0].interval_index, 3);
  assert.equal(due[0].due_at, expectedDueAt);
  assert.equal(due[0].last_answered_at, '2026-01-03T00:00:00.000Z');
});

test('scheduleNext: a wrong answer after two correct answers resets the interval to 1 day', () => {
  const records = [
    makeRecord({ answered_at: '2026-01-01T00:00:00.000Z', correct: true }),
    makeRecord({ answered_at: '2026-01-02T00:00:00.000Z', correct: true }),
    makeRecord({ answered_at: '2026-01-03T00:00:00.000Z', correct: false })
  ];
  const expectedDueAt = localMidnightPlusDays('2026-01-03T00:00:00.000Z', 1);
  const now = isoPlusDays(expectedDueAt, 1);

  const due = Review.scheduleNext(records, now);

  assert.equal(due.length, 1);
  assert.equal(due[0].interval_index, 0);
  assert.equal(due[0].due_at, expectedDueAt);
});

test('scheduleNext: an item due exactly at `now` counts as due; one millisecond earlier it does not', () => {
  const records = [makeRecord({ answered_at: '2026-01-01T00:00:00.000Z', correct: true })];
  const dueAt = localMidnightPlusDays('2026-01-01T00:00:00.000Z', 3); // level 0 -> 1 after one correct answer

  const dueExact = Review.scheduleNext(records, dueAt);
  assert.equal(dueExact.length, 1);
  assert.equal(dueExact[0].due_at, dueAt);

  const oneMsEarlier = new Date(new Date(dueAt).getTime() - 1).toISOString();
  const dueBefore = Review.scheduleNext(records, oneMsEarlier);
  assert.equal(dueBefore.length, 0);
});

test('scheduleNext: shuffled record order produces the same result as chronological order', () => {
  const chronological = [
    makeRecord({ item_id: 'x:reading_q:0', lesson_id: 'x', answered_at: '2026-01-01T00:00:00.000Z', correct: true }),
    makeRecord({ item_id: 'x:reading_q:0', lesson_id: 'x', answered_at: '2026-01-02T00:00:00.000Z', correct: false }),
    makeRecord({ item_id: 'x:reading_q:0', lesson_id: 'x', answered_at: '2026-01-03T00:00:00.000Z', correct: true })
  ];
  const shuffled = [chronological[2], chronological[0], chronological[1]];
  const now = '2026-02-01T00:00:00.000Z';

  assert.deepEqual(Review.scheduleNext(shuffled, now), Review.scheduleNext(chronological, now));
});

test('scheduleNext: results are sorted with the most overdue item first', () => {
  const records = [
    // one wrong answer -> due 1 day later = 2026-01-11 (less overdue)
    makeRecord({
      item_id: 'a:vocab:0',
      lesson_id: 'a',
      item_type: 'vocab',
      answered_at: '2026-01-10T00:00:00.000Z',
      correct: false
    }),
    // one wrong answer -> due 1 day later = 2026-01-02 (more overdue)
    makeRecord({
      item_id: 'b:vocab:0',
      lesson_id: 'b',
      item_type: 'vocab',
      answered_at: '2026-01-01T00:00:00.000Z',
      correct: false
    })
  ];
  const now = '2026-03-01T00:00:00.000Z';

  const due = Review.scheduleNext(records, now);

  assert.equal(due.length, 2);
  assert.equal(due[0].item_id, 'b:vocab:0');
  assert.equal(due[1].item_id, 'a:vocab:0');
});

test('scheduleNext: an answer given late at night becomes due the next calendar day, not a full 24h later', () => {
  // Deliberate product decision (see js/review.js): the user opens the app
  // once during a commute and once during a work break, so "review it
  // tomorrow" should mean the next calendar day -- not exactly 24h after
  // the moment they answered. Answering at 23:00 and checking again at
  // 08:00 the next morning is only 9 hours later, well under 24h.
  const answeredAt = new Date(2026, 0, 1, 23, 0, 0); // 2026-01-01 23:00 local, wrong answer -> 1-day interval
  const records = [makeRecord({ answered_at: answeredAt.toISOString(), correct: false })];
  const nextMorning = new Date(2026, 0, 2, 8, 0, 0); // 2026-01-02 08:00 local

  const due = Review.scheduleNext(records, nextMorning);

  assert.equal(due.length, 1, 'item should already be due the next morning, well before the 24h mark');
});

test('scheduleNext: due_at is anchored to local midnight of the last answer, not the exact answer time', () => {
  const answeredAt = new Date(2026, 5, 15, 21, 30, 0); // 2026-06-15 21:30 local, wrong answer -> 1-day interval
  const records = [makeRecord({ answered_at: answeredAt.toISOString(), correct: false })];
  const now = '2026-12-31T00:00:00.000Z'; // comfortably past due, just to read due_at back

  const due = Review.scheduleNext(records, now);

  const expectedDueAt = new Date(2026, 5, 16, 0, 0, 0).toISOString(); // local midnight of the 16th, not 21:30 on the 16th
  assert.equal(due.length, 1);
  assert.equal(due[0].due_at, expectedDueAt);
});

test('scheduleNext: empty records array returns an empty array', () => {
  assert.deepEqual(Review.scheduleNext([], '2026-01-01T00:00:00.000Z'), []);
});

test('scheduleNext: accepts `now` as either a Date object or an ISO8601 string', () => {
  const records = [makeRecord({ answered_at: '2026-01-01T00:00:00.000Z', correct: true })];
  const dueAt = isoPlusDays('2026-01-01T00:00:00.000Z', 3);

  const withString = Review.scheduleNext(records, dueAt);
  const withDate = Review.scheduleNext(records, new Date(dueAt));

  assert.deepEqual(withString, withDate);
});

// ---------------------------------------------------------------------------
// adjustLevel
// ---------------------------------------------------------------------------

test('adjustLevel: 19 records is below the minimum sample and does not adjust', () => {
  const records = [];
  for (let i = 0; i < 19; i++) {
    records.push(makeRecord({ answered_at: isoPlusDays('2026-01-01T00:00:00.000Z', i), correct: true }));
  }
  assert.equal(Review.adjustLevel(records, 'B1'), 'B1');
});

test('adjustLevel: 20 records reaches the minimum sample and adjusts', () => {
  const records = [];
  for (let i = 0; i < 20; i++) {
    // all correct -> 1.0 accuracy, well above UP_ABOVE
    records.push(makeRecord({ answered_at: isoPlusDays('2026-01-01T00:00:00.000Z', i), correct: true }));
  }
  assert.equal(Review.adjustLevel(records, 'B1'), 'B2');
});

test('adjustLevel: accuracy exactly at the UP_ABOVE threshold (0.85) does not level up', () => {
  const records = [];
  for (let i = 0; i < 20; i++) {
    // 17 correct, 3 wrong -> 0.85 exactly
    records.push(makeRecord({ answered_at: isoPlusDays('2026-01-01T00:00:00.000Z', i), correct: i < 17 }));
  }
  assert.equal(Review.adjustLevel(records, 'B1'), 'B1');
});

test('adjustLevel: accuracy exactly at the DOWN_BELOW threshold (0.60) does not level down', () => {
  const records = [];
  for (let i = 0; i < 20; i++) {
    // 12 correct, 8 wrong -> 0.60 exactly
    records.push(makeRecord({ answered_at: isoPlusDays('2026-01-01T00:00:00.000Z', i), correct: i < 12 }));
  }
  assert.equal(Review.adjustLevel(records, 'B1'), 'B1');
});

test('adjustLevel: accuracy below DOWN_BELOW (0.60) triggers a level down', () => {
  const records = [];
  for (let i = 0; i < 20; i++) {
    // 5 correct, 15 wrong -> 0.25 accuracy
    records.push(makeRecord({ answered_at: isoPlusDays('2026-01-01T00:00:00.000Z', i), correct: i < 5 }));
  }
  assert.equal(Review.adjustLevel(records, 'B1'), Contract.shiftLevel('B1', -1));
});

test('adjustLevel: uses only the most-recent WINDOW records, regardless of input order', () => {
  const records = [];
  // 5 old wrong answers that must be excluded from the rolling window
  for (let i = 0; i < 5; i++) {
    records.push(makeRecord({ answered_at: isoPlusDays('2026-01-01T00:00:00.000Z', i), correct: false }));
  }
  // 20 more recent correct answers that must be the ones evaluated
  for (let i = 5; i < 25; i++) {
    records.push(makeRecord({ answered_at: isoPlusDays('2026-01-01T00:00:00.000Z', i), correct: true }));
  }

  const shuffled = records.slice().sort(() => Math.random() - 0.5);

  // If the old wrong answers leaked into the window, accuracy would drop
  // to 20/25 = 0.80 (no change) instead of 1.0 (level up).
  assert.equal(Review.adjustLevel(records, 'B1'), 'B2');
  assert.equal(Review.adjustLevel(shuffled, 'B1'), 'B2');
});

test('adjustLevel: level up from C2 stays clamped at C2', () => {
  const records = [];
  for (let i = 0; i < 20; i++) {
    records.push(makeRecord({ answered_at: isoPlusDays('2026-01-01T00:00:00.000Z', i), correct: true }));
  }
  assert.equal(Review.adjustLevel(records, 'C2'), 'C2');
});

test('adjustLevel: an invalid CEFR currentLevel falls back to DEFAULT_LEVEL', () => {
  assert.equal(Review.adjustLevel([], 'Z9'), Contract.DEFAULT_LEVEL);
  assert.equal(Review.adjustLevel([], 'b1'), Contract.DEFAULT_LEVEL); // wrong case is still invalid
});

test('adjustLevel: empty records array does not throw and returns the current level unchanged', () => {
  assert.equal(Review.adjustLevel([], 'B1'), 'B1');
});
