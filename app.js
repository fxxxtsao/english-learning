/**
 * App orchestration and ALL DOM manipulation for the practice web app.
 *
 * Per docs/specs/2026-09-02-practice-web-app.md (硬性約束), DOM operations
 * are only allowed in this file. js/api.js and js/store.js never touch the
 * DOM; js/lesson.js, js/review.js, js/sync.js are pure functions this file
 * only calls (they are implemented by other, parallel sub-tasks).
 *
 * Behavior-to-code map (see also the task report for exact line numbers):
 *   1. open -> today's content, no menu           -> init()/boot()
 *   2. device type decides default mode            -> detectDefaultMode()
 *   3. one-handed listening controls                -> panel-listening wiring
 *   4/9/11(spec numbering). cross-device continuity  -> refreshFromNetwork() + Sync.mergeProgress
 *   5. wrong/unfamiliar items resurface later        -> buildItemQueues()/resolveDueItem()
 *   6. weekly stats                                  -> computeStats()/updateStatsUi()
 *   7. auto difficulty adjustment                    -> maybeAdjustLevel()
 *   8. offline never blocks; auto-retries             -> submitAnswer()/trySyncQueue()
 *   9. broken lesson rows are skipped + reported       -> ingestLessons()/renderLessonErrors()
 *   10. no new content today -> show review instead    -> renderCurrentScreen()
 *   11. audio failure -> transcript fallback            -> setupAudioFor()/showTranscriptFallback()
 */
(function () {
  'use strict';

  // js/contract.js, js/lesson.js, js/review.js and js/sync.js each expose a
  // namespaced global (Contract, Lesson, Review, Sync).
  var LessonMod = Lesson;
  var ReviewMod = Review;
  var SyncMod = Sync;

  var dom = {};

  var state = {
    lessonsById: {},
    corrupted: [],
    progress: [],   // merged (confirmed + queued) answer records
    queue: [],      // unconfirmed local queue
    level: Contract.DEFAULT_LEVEL,
    mode: 'reading',
    todayLesson: null,
    queues: { reading: [], listening: [], vocab: [] },
    queueIndex: { reading: 0, listening: 0, vocab: 0 },
    audioFailed: false,
    currentAudioObjectUrl: null
  };

  var syncInFlight = false;
  var retryTimer = null;
  var RETRY_DELAY_MS = 5000;

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    cacheDom();
    bindEvents();

    if (!Store.hasConfig()) {
      showScreen('setup');
      return;
    }
    boot();
  }

  function boot() {
    var settings = Store.getSettings();
    state.level = settings.level || Contract.DEFAULT_LEVEL;
    state.mode = settings.mode || detectDefaultMode();
    updateModeLabel();

    hydrateFromCache();

    var firstEverLoad = Object.keys(state.lessonsById).length === 0 && state.progress.length === 0;
    if (firstEverLoad && navigator.onLine) {
      showScreen('loading');
    } else {
      renderCurrentScreen();
      updateStatsUi();
    }

    refreshFromNetwork();

    window.addEventListener('online', function () {
      hideOfflineBanner();
      refreshFromNetwork();
    });
    window.addEventListener('offline', showOfflineBanner);

    if (!navigator.onLine) {
      showOfflineBanner();
    }
  }

  /** Builds in-memory state from whatever is already cached locally, synchronously. */
  function hydrateFromCache() {
    var ingested = ingestLessons(Store.getLessons());
    state.lessonsById = ingested.byId;
    // Server-side parse failures (Code.gs `errors`) aren't cached locally --
    // only lessons that already passed parseLessonRow are. Re-running
    // validateLesson against the cache still surfaces non-fatal quality
    // warnings; the fuller list (incl. server errors) comes back on the
    // next refreshFromNetwork().
    state.corrupted = ingested.qualityWarnings;

    state.queue = Store.getQueue();
    var merged = safeMergeProgress(state.queue, Store.getProgress());
    state.progress = merged.merged;

    buildItemQueues();
    renderLessonErrors();
  }

  /** Pulls fresh lessons + progress from Apps Script. Never blocks the UI; failures fall back to cache. */
  function refreshFromNetwork() {
    if (!navigator.onLine) return;

    // Lessons are low-volume (about one row/day), and a review item can
    // point back at a lesson from weeks ago, so the simplest correct thing
    // is to fetch the full list every time rather than build incremental
    // "did we cache the right lesson" logic. See report for this tradeoff.
    Api.fetchLessons()
      .then(function (lessonsResponse) {
        var rawLessons = lessonsResponse.lessons || [];
        Store.setLessons(rawLessons);
        var ingested = ingestLessons(rawLessons);
        state.lessonsById = ingested.byId;
        // Rows Code.gs's parseLessonRow rejected outright (structurally
        // broken -- never dropped silently, story 9) plus any non-fatal
        // validateLesson warnings on the rows that DID come through.
        state.corrupted = (lessonsResponse.errors || []).concat(ingested.qualityWarnings);
        renderLessonErrors();

        var settings = Store.getSettings();
        return Api.fetchProgress(settings.lastSyncAt).then(function (progressResponse) {
          var newRemote = progressResponse.records || [];
          var cachedRemote = dedupeById(Store.getProgress().concat(newRemote));
          Store.setProgress(cachedRemote);

          // Anchor the next `since` on the latest answered_at actually
          // received from the server, never on this device's own clock -- a
          // device whose clock runs fast would push lastSyncAt ahead of the
          // server and silently skip records another device uploaded in
          // that gap (spec promises no record is ever dropped). If nothing
          // came back this round, leave lastSyncAt where it was rather than
          // advancing it.
          var latestAnsweredAt = latestAnsweredAtOf(newRemote);
          if (latestAnsweredAt) {
            Store.setSettings({ lastSyncAt: latestAnsweredAt });
          }

          var merged = safeMergeProgress(state.queue, cachedRemote);
          state.progress = merged.merged;

          buildItemQueues();
          renderCurrentScreen();
          updateStatsUi();
          maybeAdjustLevel();

          if (merged.toUpload.length) {
            trySyncQueue();
          }
          hideOfflineBanner();
        });
      })
      .catch(function (err) {
        handleApiFailure(err, 'refresh');
        renderCurrentScreen();
      });
  }

  /**
   * Central error handling for every Api.* rejection (network failure, or
   * an {ok:false, error:<code>} response -- js/api.js normalizes both into
   * a rejected promise, the latter carrying err.code). Per code:
   *   - forbidden: the saved URL/token is wrong -- sync can never succeed
   *     until the user fixes it, so send them back to the setup screen.
   *   - lock_timeout: only ever comes from action=append (LockService);
   *     transient, so just retry automatically after a short delay.
   *   - everything else (unknown_action, sheet_not_found, not_found,
   *     missing_file_id, invalid_body, invalid_level, internal_error, or a
   *     plain network error): log it and fall back to offline/cached
   *     practice -- never block the UI on it.
   */
  function handleApiFailure(err, context) {
    console.warn('Api call failed (' + context + '):', err);
    var code = err && err.code;

    if (code === 'forbidden') {
      hideOfflineBanner(); // its "will sync automatically" message is wrong here -- sync is blocked, not just offline
      dom.setupError.hidden = false;
      dom.setupError.textContent = 'The saved URL or sync token looks wrong. Please re-enter them and save again.';
      showScreen('setup');
      return;
    }

    if (code === 'lock_timeout') {
      scheduleRetry();
    }

    showOfflineBanner();
  }

  /** Retries the offline queue upload once, after a short delay. Coalesces overlapping requests. */
  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      trySyncQueue();
    }, RETRY_DELAY_MS);
  }

  // ---------------------------------------------------------------------
  // Lesson ingestion (story 9: corrupted rows are skipped, not fatal)
  // ---------------------------------------------------------------------

  /**
   * `action=lessons` already returns pre-parsed lesson objects -- Code.gs
   * runs parseLessonRow() itself and only puts rows that passed it in
   * `lessons` (anything that failed comes back separately in the response's
   * top-level `errors`, handled by the caller). So there is no row-shape
   * guessing left to do here.
   *
   * validateLesson() is still run per lesson: per js/lesson.js's own
   * contract this NEVER rejects the lesson (only parseLessonRow-level
   * problems do that, and those are already filtered out server-side) --
   * it only flags non-fatal quality issues (e.g. an audio segment outside
   * the expected length, a vocab term not found in the source text). Those
   * lessons stay fully usable; the issues are only surfaced as warnings.
   */
  function ingestLessons(lessonList) {
    var byId = {};
    var qualityWarnings = [];
    (lessonList || []).forEach(function (lesson) {
      if (!lesson || !lesson.lesson_id) return;
      byId[lesson.lesson_id] = lesson;

      var issues;
      try {
        issues = LessonMod.validateLesson(lesson) || [];
      } catch (e) {
        issues = [Contract.makeError(Contract.ERRORS.MISSING_FIELD, null, 'validateLesson threw: ' + e.message)];
      }
      if (issues.length) {
        qualityWarnings.push({ lesson_id: lesson.lesson_id, errors: issues });
      }
    });
    return { byId: byId, qualityWarnings: qualityWarnings };
  }

  // ---------------------------------------------------------------------
  // Item queues: today's new content + due review items (stories 1, 5, 10)
  // ---------------------------------------------------------------------

  function buildItemQueues() {
    var todayId = todayDateStr();
    state.todayLesson = state.lessonsById[todayId] || null;

    var due = safeScheduleNext(state.progress, new Date());

    var newReading = [], newListening = [], newVocab = [];
    if (state.todayLesson) {
      var lesson = state.todayLesson;
      (lesson.reading_questions || []).forEach(function (q, idx) {
        newReading.push({ source: 'new', kind: 'reading_q', lesson: lesson, question: q, item_id: Contract.itemId(lesson.lesson_id, 'reading_q', idx) });
      });
      (lesson.listening_questions || []).forEach(function (q, idx) {
        newListening.push({ source: 'new', kind: 'listening_q', lesson: lesson, question: q, item_id: Contract.itemId(lesson.lesson_id, 'listening_q', idx) });
      });
      (lesson.vocab || []).forEach(function (v, idx) {
        newVocab.push({ source: 'new', kind: 'vocab', lesson: lesson, vocab: v, item_id: Contract.itemId(lesson.lesson_id, 'vocab', idx) });
      });
    }

    var reviewReading = [], reviewListening = [], reviewVocab = [];
    due.forEach(function (dueItem) {
      var resolved = resolveDueItem(dueItem);
      if (!resolved) return; // source lesson not available locally -- skip quietly
      if (resolved.kind === 'reading_q') reviewReading.push(resolved);
      else if (resolved.kind === 'listening_q') reviewListening.push(resolved);
      else if (resolved.kind === 'vocab') reviewVocab.push(resolved);
    });

    state.queues = {
      reading: newReading.concat(reviewReading),
      listening: newListening.concat(reviewListening),
      vocab: newVocab.concat(reviewVocab)
    };
    state.queueIndex = { reading: 0, listening: 0, vocab: 0 };
  }

  /** Turns one scheduleNext() due-item into a renderable item with real content, or null if unresolvable. */
  function resolveDueItem(due) {
    due = due || {};
    var itemId = due.item_id || (due.item && due.item.item_id);
    var lessonId = due.lesson_id;
    var itemType = due.item_type;
    var index = due.index;

    if (itemId && (!lessonId || !itemType || index === undefined || index === null)) {
      var parts = String(itemId).split(':');
      if (parts.length === 3) {
        lessonId = lessonId || parts[0];
        itemType = itemType || parts[1];
        if (index === undefined || index === null) index = parseInt(parts[2], 10);
      }
    }

    var lesson = state.lessonsById[lessonId];
    if (!lesson) return null;

    if (itemType === 'reading_q') {
      var q = lesson.reading_questions && lesson.reading_questions[index];
      if (!q) return null;
      return { source: 'review', kind: 'reading_q', lesson: lesson, question: q, item_id: itemId || Contract.itemId(lessonId, itemType, index) };
    }
    if (itemType === 'listening_q') {
      var lq = lesson.listening_questions && lesson.listening_questions[index];
      if (!lq) return null;
      return { source: 'review', kind: 'listening_q', lesson: lesson, question: lq, item_id: itemId || Contract.itemId(lessonId, itemType, index) };
    }
    if (itemType === 'vocab') {
      var v = lesson.vocab && lesson.vocab[index];
      if (!v) return null;
      return { source: 'review', kind: 'vocab', lesson: lesson, vocab: v, item_id: itemId || Contract.itemId(lessonId, itemType, index) };
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Answering + sync (stories 7, 8)
  // ---------------------------------------------------------------------

  function submitAnswer(item, correct) {
    var record = SyncMod.makeRecord({
      item_id: item.item_id,
      item_type: item.kind,
      lesson_id: item.lesson.lesson_id,
      answered_at: new Date().toISOString(),
      correct: !!correct,
      device: Store.getSettings().deviceId
    });

    // Write to the local queue FIRST, always -- offline never blocks answering.
    state.queue = SyncMod.enqueue(state.queue, record);
    Store.setQueue(state.queue);
    state.progress = state.progress.concat([record]);

    updateStatsUi();
    maybeAdjustLevel();
    trySyncQueue();
  }

  /**
   * action=append's response is {ok:true, written:[record_id...],
   * skipped:[{record_id, reason}]}. `written` records are safe to drop from
   * the local queue -- the server has them.
   *
   * `skipped` records must NOT be dropped in general: dropping a skipped
   * record silently throws away that answer forever. The one exception is
   * reason === 'duplicate' (Code.gs's actionAppend: the record_id already
   * existed on the sheet, or appeared twice in this same batch) -- that
   * means the server already has this record under this id, so it is just
   * as safe to clear as a `written` one. Any other skip reason (a shape
   * validation failure -- missing_record_id, bad_item_type, bad_correct,
   * ...) means the server will never accept this record as-is, but it stays
   * queued anyway per the no-silent-data-loss rule above; it is logged so a
   * developer can notice a client bug is producing malformed records.
   */
  function trySyncQueue() {
    if (syncInFlight || !state.queue.length || !navigator.onLine) return;
    syncInFlight = true;
    var toUpload = state.queue;

    Api.appendProgress(toUpload)
      .then(function (response) {
        var written = response.written || [];
        var skipped = response.skipped || [];

        var confirmedIds = written.slice();
        var rejected = [];
        skipped.forEach(function (s) {
          if (s.reason === 'duplicate') {
            confirmedIds.push(s.record_id);
          } else {
            rejected.push(s);
          }
        });

        state.queue = SyncMod.dequeueConfirmed(state.queue, confirmedIds);
        Store.setQueue(state.queue);

        var confirmedSet = {};
        confirmedIds.forEach(function (id) { confirmedSet[id] = true; });
        var newlyConfirmed = toUpload.filter(function (r) { return confirmedSet[r.record_id]; });
        if (newlyConfirmed.length) {
          Store.setProgress(dedupeById(Store.getProgress().concat(newlyConfirmed)));
        }

        if (rejected.length) {
          console.warn('Sync: server rejected ' + rejected.length + ' record(s); kept in local queue so nothing is lost.', rejected);
        }
        hideOfflineBanner();
      })
      .catch(function (err) {
        handleApiFailure(err, 'append');
      })
      .then(function () {
        syncInFlight = false;
      });
  }

  /** Only calls set_level when the rolling accuracy actually pushes the level up/down. */
  function maybeAdjustLevel() {
    var newLevel = safeAdjustLevel(state.progress, state.level);
    if (newLevel && newLevel !== state.level) {
      Api.setLevel(newLevel)
        .then(function (response) {
          state.level = response.level;
          Store.setSettings({ level: response.level });
        })
        .catch(function (err) {
          handleApiFailure(err, 'set_level');
        });
    }
  }

  // ---------------------------------------------------------------------
  // Defensive wrappers around the other sub-tasks' pure functions
  // ---------------------------------------------------------------------

  function safeScheduleNext(records, now) {
    try {
      return ReviewMod.scheduleNext(records, now) || [];
    } catch (e) {
      console.warn('scheduleNext failed, showing no review items this load.', e);
      return [];
    }
  }

  function safeAdjustLevel(records, currentLevel) {
    try {
      return ReviewMod.adjustLevel(records, currentLevel) || currentLevel;
    } catch (e) {
      console.warn('adjustLevel failed, keeping current level.', e);
      return currentLevel;
    }
  }

  function safeMergeProgress(queue, remote) {
    try {
      return SyncMod.mergeProgress(queue, remote);
    } catch (e) {
      console.warn('mergeProgress failed, falling back to a naive concat.', e);
      return { toUpload: queue || [], merged: (remote || []).concat(queue || []) };
    }
  }

  // ---------------------------------------------------------------------
  // Stats (story 6)
  // ---------------------------------------------------------------------

  function computeStats(records) {
    var now = new Date();
    var weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    var days = {};
    var total = 0, correct = 0;
    (records || []).forEach(function (r) {
      var t = new Date(r.answered_at);
      if (isNaN(t.getTime()) || t < weekAgo || t > now) return;
      days[t.toISOString().slice(0, 10)] = true;
      total++;
      if (r.correct) correct++;
    });
    return { days: Object.keys(days).length, accuracy: total ? correct / total : null };
  }

  function updateStatsUi() {
    var stats = computeStats(state.progress);
    dom.statDays.textContent = String(stats.days);
    dom.statAccuracy.textContent = stats.accuracy === null ? '—' : Math.round(stats.accuracy * 100) + '%';
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  function renderCurrentScreen() {
    var hasToday = !!state.todayLesson;
    var hasDue = state.queues.reading.length + state.queues.listening.length + state.queues.vocab.length > 0;

    if (!hasToday && !hasDue) {
      showScreen('empty');
      return;
    }

    showScreen('practice');
    dom.practiceBanner.textContent = hasToday ? "Today's lesson" : 'Review';
    renderMode(state.mode);
  }

  function renderMode(mode) {
    if (mode === 'reading') {
      dom.panelReading.hidden = false;
      dom.panelListening.hidden = true;
      renderReadingQueue();
    } else {
      dom.panelReading.hidden = true;
      dom.panelListening.hidden = false;
      renderListeningQueue();
    }
    renderVocabQueue();
  }

  function renderReadingQueue() {
    var queue = state.queues.reading;
    var idx = state.queueIndex.reading;
    if (idx >= queue.length) {
      dom.readingContext.textContent = '';
      dom.readingQuestionArea.innerHTML = '<p class="done-msg">No more reading items right now. Nice work.</p>';
      return;
    }
    var item = queue[idx];
    dom.readingContext.textContent = item.lesson.title + (item.source === 'review' ? ' (review)' : '');

    dom.readingQuestionArea.innerHTML = '';
    var passage = document.createElement('p');
    passage.className = 'passage';
    passage.textContent = item.lesson.reading_text || '';
    dom.readingQuestionArea.appendChild(passage);

    var qArea = document.createElement('div');
    dom.readingQuestionArea.appendChild(qArea);
    renderMCQuestion(qArea, item.question, function (isCorrect) {
      submitAnswer(item, isCorrect);
      state.queueIndex.reading++;
      renderReadingQueue();
    });
  }

  function renderListeningQueue() {
    var queue = state.queues.listening;
    var idx = state.queueIndex.listening;
    if (idx >= queue.length) {
      dom.listeningContext.textContent = '';
      dom.listeningQuestionArea.innerHTML = '<p class="done-msg">No more listening items right now. Nice work.</p>';
      resetAudioUi();
      return;
    }
    var item = queue[idx];
    dom.listeningContext.textContent = item.lesson.title + (item.source === 'review' ? ' (review)' : '');
    setupAudioFor(item.lesson);

    dom.listeningQuestionArea.innerHTML = '';
    var qArea = document.createElement('div');
    dom.listeningQuestionArea.appendChild(qArea);
    renderMCQuestion(qArea, item.question, function (isCorrect) {
      submitAnswer(item, isCorrect);
      state.queueIndex.listening++;
      renderListeningQueue();
    });
  }

  function renderVocabQueue() {
    var queue = state.queues.vocab;
    var idx = state.queueIndex.vocab;
    dom.vocabPanel.innerHTML = '';
    if (idx >= queue.length) {
      dom.vocabPanel.innerHTML = '<p class="done-msg">No vocab to review right now.</p>';
      return;
    }
    var item = queue[idx];
    var label = document.createElement('p');
    label.className = 'vocab-source';
    label.textContent = item.lesson.title + (item.source === 'review' ? ' (review)' : '');
    dom.vocabPanel.appendChild(label);

    var area = document.createElement('div');
    dom.vocabPanel.appendChild(area);
    renderVocabItem(area, item.vocab, function (knewIt) {
      submitAnswer(item, knewIt);
      state.queueIndex.vocab++;
      renderVocabQueue();
    });
  }

  /**
   * Renders a 4-option multiple-choice question with immediate feedback:
   * picking an option highlights the correct/incorrect answer, shows the
   * explanation, and reveals a "Next" button. This immediate-feedback
   * pattern is not specified in the spec -- it's this task's own UX choice.
   */
  function renderMCQuestion(container, question, onAnswer) {
    container.innerHTML = '';

    var prompt = document.createElement('p');
    prompt.className = 'question-prompt';
    prompt.textContent = question.prompt;
    container.appendChild(prompt);

    var optionsEl = document.createElement('div');
    optionsEl.className = 'options';
    (question.options || []).forEach(function (optionText, idx) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'option-btn';
      btn.textContent = optionText;
      btn.addEventListener('click', function () {
        var isCorrect = idx === question.answer_index;
        Array.prototype.forEach.call(optionsEl.children, function (b, i) {
          b.disabled = true;
          if (i === question.answer_index) b.classList.add('correct');
          else if (i === idx) b.classList.add('incorrect');
        });

        var explanation = document.createElement('p');
        explanation.className = 'explanation';
        explanation.textContent = question.explanation || '';
        container.appendChild(explanation);

        var nextBtn = document.createElement('button');
        nextBtn.type = 'button';
        nextBtn.className = 'big-btn primary';
        nextBtn.textContent = 'Next';
        nextBtn.addEventListener('click', function () { onAnswer(isCorrect); });
        container.appendChild(nextBtn);
      });
      optionsEl.appendChild(btn);
    });
    container.appendChild(optionsEl);
  }

  /**
   * Renders one vocab entry as a reveal card: term first, then "Show
   * meaning", then a self-assessed "I knew it" / "Forgot" pair (vocab has
   * no multiple-choice structure in the content schema, so self-report is
   * this task's own UX choice for how a vocab item gets marked correct/wrong).
   */
  function renderVocabItem(container, vocab, onAnswer) {
    var term = document.createElement('p');
    term.className = 'vocab-term';
    term.textContent = vocab.term + (vocab.pos ? ' (' + vocab.pos + ')' : '');
    container.appendChild(term);

    var revealBtn = document.createElement('button');
    revealBtn.type = 'button';
    revealBtn.className = 'big-btn';
    revealBtn.textContent = 'Show meaning';
    container.appendChild(revealBtn);

    var detail = document.createElement('div');
    detail.className = 'vocab-detail';
    detail.hidden = true;
    var def = document.createElement('p');
    def.textContent = (vocab.definition_en || '') + (vocab.definition_zh ? ' — ' + vocab.definition_zh : '');
    detail.appendChild(def);
    if (vocab.example) {
      var example = document.createElement('p');
      example.className = 'vocab-example';
      example.textContent = vocab.example;
      detail.appendChild(example);
    }
    container.appendChild(detail);

    var actions = document.createElement('div');
    actions.className = 'vocab-actions';
    actions.hidden = true;
    var knewBtn = document.createElement('button');
    knewBtn.type = 'button';
    knewBtn.className = 'big-btn';
    knewBtn.textContent = 'I knew it';
    knewBtn.addEventListener('click', function () { onAnswer(true); });
    var forgotBtn = document.createElement('button');
    forgotBtn.type = 'button';
    forgotBtn.className = 'big-btn';
    forgotBtn.textContent = 'Forgot';
    forgotBtn.addEventListener('click', function () { onAnswer(false); });
    actions.appendChild(knewBtn);
    actions.appendChild(forgotBtn);
    container.appendChild(actions);

    revealBtn.addEventListener('click', function () {
      detail.hidden = false;
      actions.hidden = false;
      revealBtn.hidden = true;
    });
  }

  /**
   * `state.corrupted` mixes two sources, both surfaced here so neither is
   * ever silently dropped: rows Code.gs's parseLessonRow rejected outright
   * (shape { row, lesson_id, errors }, lesson_id may be null) and lessons
   * that loaded fine but tripped a non-fatal validateLesson warning (shape
   * { lesson_id, errors }).
   */
  function renderLessonErrors() {
    if (!state.corrupted.length) {
      dom.lessonErrors.hidden = true;
      dom.lessonErrors.textContent = '';
      return;
    }
    dom.lessonErrors.hidden = false;
    dom.lessonErrors.textContent = 'Issues in ' + state.corrupted.length + ' lesson row(s): ' +
      state.corrupted.map(function (c) {
        var label = c.lesson_id || (c.row ? ('row ' + c.row) : 'unknown');
        var codes = (c.errors || []).map(function (e) { return e.code; }).join(',');
        return label + (codes ? ' (' + codes + ')' : '');
      }).join('; ');
  }

  // ---------------------------------------------------------------------
  // Audio (stories 3, 11)
  // ---------------------------------------------------------------------

  /**
   * action=audio returns base64 (see js/api.js Api.fetchAudio), never a
   * directly-playable URL. Each call here decodes a fresh Blob and gets its
   * own object URL; the previous one is revoked first (releaseAudioObjectUrl)
   * so switching lessons/items never leaves a decoded MP3 pinned in memory.
   */
  function setupAudioFor(lesson) {
    state.audioFailed = false;
    releaseAudioObjectUrl();
    dom.audioPlayer.pause();
    dom.audioPlayer.removeAttribute('src');
    dom.audioPlayer.onerror = null;
    dom.audioPlayer.onloadedmetadata = null;
    dom.audioPlayer.ontimeupdate = null;
    dom.audioPlayer.onplay = null;
    dom.audioPlayer.onpause = null;
    dom.listeningTranscriptFallback.hidden = true;
    dom.listeningControls.hidden = false;
    dom.btnPlayPause.textContent = '▶';
    dom.listeningTime.textContent = '0:00';

    if (!lesson.audio_file_id) {
      // Empty audio_file_id is a normal transient state (not fetched yet by
      // the AudioFetcher job) -- fall back to transcript the same way a
      // playback error would.
      showTranscriptFallback(lesson);
      return;
    }

    if (!navigator.onLine) {
      // action=audio is a network fetch (base64 payload) -- nothing cached
      // to decode offline, so go straight to the transcript.
      showTranscriptFallback(lesson);
      return;
    }

    var requestedFileId = lesson.audio_file_id;
    Api.fetchAudio(requestedFileId)
      .then(function (audio) {
        // The user may have moved to a different item while this was in
        // flight -- discard a stale response instead of stomping the UI.
        var stillCurrent = currentListeningLesson();
        if (!stillCurrent || stillCurrent.audio_file_id !== requestedFileId) {
          URL.revokeObjectURL(audio.objectUrl);
          return;
        }

        state.currentAudioObjectUrl = audio.objectUrl;
        dom.audioPlayer.src = audio.objectUrl;
        dom.audioPlayer.load();

        dom.audioPlayer.onloadedmetadata = function () {
          dom.audioPlayer.currentTime = lesson.audio_start_sec || 0;
        };
        dom.audioPlayer.ontimeupdate = function () {
          if (lesson.audio_end_sec && dom.audioPlayer.currentTime >= lesson.audio_end_sec) {
            dom.audioPlayer.pause();
            dom.audioPlayer.currentTime = lesson.audio_start_sec || 0;
          }
          dom.listeningTime.textContent = formatTime(dom.audioPlayer.currentTime);
        };
        dom.audioPlayer.onerror = function () {
          showTranscriptFallback(lesson);
        };
        dom.audioPlayer.onplay = function () { dom.btnPlayPause.textContent = '⏸'; };
        dom.audioPlayer.onpause = function () { dom.btnPlayPause.textContent = '▶'; };

        wireMediaSession(lesson);
      })
      .catch(function (err) {
        console.warn('Audio fetch failed (' + (err && err.code || err) + '), falling back to transcript.', err);
        showTranscriptFallback(lesson);
      });
  }

  function wireMediaSession(lesson) {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: lesson.title || 'English Practice' });
      navigator.mediaSession.setActionHandler('play', function () { dom.audioPlayer.play().catch(function () { showTranscriptFallback(lesson); }); });
      navigator.mediaSession.setActionHandler('pause', function () { dom.audioPlayer.pause(); });
      navigator.mediaSession.setActionHandler('seekbackward', function () { rewind15(lesson); });
    }
  }

  function showTranscriptFallback(lesson) {
    state.audioFailed = true;
    dom.listeningControls.hidden = true;
    dom.listeningTranscriptFallback.hidden = false;
    dom.listeningTranscriptFallback.textContent = lesson.transcript || '(no transcript available)';
  }

  function rewind15(lesson) {
    dom.audioPlayer.currentTime = Math.max(lesson.audio_start_sec || 0, dom.audioPlayer.currentTime - 15);
  }

  function resetAudioUi() {
    releaseAudioObjectUrl();
    dom.audioPlayer.pause();
    dom.audioPlayer.removeAttribute('src');
    dom.listeningControls.hidden = true;
    dom.listeningTranscriptFallback.hidden = true;
  }

  /** Frees the decoded-audio Blob backing the current object URL, if any. */
  function releaseAudioObjectUrl() {
    if (state.currentAudioObjectUrl) {
      URL.revokeObjectURL(state.currentAudioObjectUrl);
      state.currentAudioObjectUrl = null;
    }
  }

  function currentListeningLesson() {
    var item = state.queues.listening[state.queueIndex.listening];
    return item ? item.lesson : null;
  }

  function formatTime(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ---------------------------------------------------------------------
  // Mode detection (story 2)
  // ---------------------------------------------------------------------

  function detectDefaultMode() {
    var coarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    var narrowScreen = window.matchMedia && window.matchMedia('(max-width: 700px)').matches;
    return (coarsePointer || narrowScreen) ? 'listening' : 'reading';
  }

  function updateModeLabel() {
    dom.modeLabel.textContent = state.mode === 'reading' ? 'Reading mode' : 'Listening mode';
  }

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  function todayDateStr() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1);
    var day = String(d.getDate());
    if (m.length < 2) m = '0' + m;
    if (day.length < 2) day = '0' + day;
    return y + '-' + m + '-' + day;
  }

  function dedupeById(records) {
    var byId = {};
    (records || []).forEach(function (r) {
      if (r && r.record_id) byId[r.record_id] = r;
    });
    return Object.keys(byId).map(function (id) { return byId[id]; });
  }

  /** Latest answered_at among records, or null if there are none. Used to anchor lastSyncAt on server data instead of the device clock. */
  function latestAnsweredAtOf(records) {
    var latest = null;
    (records || []).forEach(function (r) {
      if (!r || !r.answered_at) return;
      if (latest === null || new Date(r.answered_at).getTime() > new Date(latest).getTime()) {
        latest = r.answered_at;
      }
    });
    return latest;
  }

  function showOfflineBanner() {
    dom.offlineBanner.hidden = false;
  }

  function hideOfflineBanner() {
    dom.offlineBanner.hidden = true;
  }

  function showScreen(name) {
    Object.keys(dom.screens).forEach(function (key) {
      dom.screens[key].hidden = key !== name;
    });
  }

  // ---------------------------------------------------------------------
  // DOM wiring
  // ---------------------------------------------------------------------

  function cacheDom() {
    dom.screens = {
      setup: document.getElementById('screen-setup'),
      loading: document.getElementById('screen-loading'),
      empty: document.getElementById('screen-empty'),
      practice: document.getElementById('screen-practice'),
      stats: document.getElementById('screen-stats')
    };

    dom.btnModeToggle = document.getElementById('btn-mode-toggle');
    dom.modeLabel = document.getElementById('mode-label');
    dom.btnStats = document.getElementById('btn-stats');
    dom.offlineBanner = document.getElementById('offline-banner');
    dom.lessonErrors = document.getElementById('lesson-errors');

    dom.inputUrl = document.getElementById('input-url');
    dom.inputToken = document.getElementById('input-token');
    dom.btnSaveConfig = document.getElementById('btn-save-config');
    dom.setupError = document.getElementById('setup-error');

    dom.practiceBanner = document.getElementById('practice-banner');
    dom.panelReading = document.getElementById('panel-reading');
    dom.readingContext = document.getElementById('reading-context');
    dom.readingQuestionArea = document.getElementById('reading-question-area');

    dom.panelListening = document.getElementById('panel-listening');
    dom.listeningContext = document.getElementById('listening-context');
    dom.audioPlayer = document.getElementById('audio-player');
    dom.listeningTranscriptFallback = document.getElementById('listening-transcript-fallback');
    dom.listeningTime = document.getElementById('listening-time');
    dom.listeningControls = document.getElementById('listening-controls');
    dom.btnRewind15 = document.getElementById('btn-rewind15');
    dom.btnPlayPause = document.getElementById('btn-play-pause');
    dom.listeningQuestionArea = document.getElementById('listening-question-area');

    dom.vocabPanel = document.getElementById('vocab-panel');

    dom.statDays = document.getElementById('stat-days');
    dom.statAccuracy = document.getElementById('stat-accuracy');
    dom.btnBackFromStats = document.getElementById('btn-back-from-stats');
  }

  function bindEvents() {
    dom.btnSaveConfig.addEventListener('click', function () {
      var url = dom.inputUrl.value.trim();
      var token = dom.inputToken.value.trim();
      if (!url || !token) {
        dom.setupError.hidden = false;
        dom.setupError.textContent = 'Please fill in both the URL and the token.';
        return;
      }
      dom.setupError.hidden = true;
      Store.setApiUrl(url);
      Store.setSyncToken(token);
      boot();
    });

    dom.btnModeToggle.addEventListener('click', function () {
      state.mode = state.mode === 'reading' ? 'listening' : 'reading';
      Store.setSettings({ mode: state.mode });
      updateModeLabel();
      renderMode(state.mode);
    });

    dom.btnStats.addEventListener('click', function () {
      updateStatsUi();
      showScreen('stats');
    });

    dom.btnBackFromStats.addEventListener('click', function () {
      renderCurrentScreen();
    });

    dom.btnRewind15.addEventListener('click', function () {
      var lesson = currentListeningLesson();
      if (lesson) rewind15(lesson);
    });

    dom.btnPlayPause.addEventListener('click', function () {
      var lesson = currentListeningLesson();
      if (dom.audioPlayer.paused) {
        dom.audioPlayer.play().catch(function () {
          if (lesson) showTranscriptFallback(lesson);
        });
      } else {
        dom.audioPlayer.pause();
      }
    });

    // Leaving the page shouldn't leak the currently-decoded audio Blob.
    window.addEventListener('beforeunload', releaseAudioObjectUrl);
  }

  // ---------------------------------------------------------------------
  // Service worker registration (best-effort; sw.js is delivered by a
  // separate sub-task, so a missing file here is not an error).
  // ---------------------------------------------------------------------

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (err) {
        console.warn('Service worker registration skipped:', err.message);
      });
    });
  }
})();
