/**
 * Service Worker for the English Practice PWA.
 *
 * Scope: only this file (and manifest.json / icons/) belong to this
 * sub-task. index.html, app.js and js/* are owned by a parallel sub-task and
 * are only ever *read* here (importScripts of contract.js, and a fixed list
 * of app-shell URLs to precache) -- never written.
 *
 * Caching rules (see docs/specs/2026-09-02-practice-web-app.md, "離線用
 * Service Worker 快取最近 7 天的內容與音檔"):
 *   1. App shell (index.html, style.css, app.js, js/*.js, manifest.json,
 *      icons/*) -> stale-while-revalidate, precached on install. The cached
 *      copy answers instantly; a background refresh replaces it so the next
 *      open picks up whatever was last pushed.
 *   2. Apps Script JSON API requests (action=lessons, action=progress)
 *      -> network-first, falling back to cache when offline.
 *   3. Apps Script audio requests (action=audio) -> cache-first. Audio for
 *      a given file_id is immutable once generated, and this is the whole
 *      point of prefetching it -- once cached, playback should never wait
 *      on a network round trip. See report for why this one category
 *      deliberately departs from the general "API = network-first" rule.
 *   4. Everything else (cross-origin, non-GET) is left untouched -- the
 *      browser handles it natively.
 *
 * Audio prefetching (see "音檔預先抓取" in the spec): whenever a fresh
 * `action=lessons` response comes back from the network, this worker reads
 * the lesson list itself (it does not wait for the page to ask), figures
 * out which lessons fall inside the most recent Contract.OFFLINE.CACHE_DAYS
 * days, and fetches+caches any of their audio files that are not already
 * cached -- in the background, without delaying the response the page is
 * waiting on. The same pass evicts audio whose lesson has aged out of that
 * window, so the cache can't grow unbounded.
 *
 * CACHE_VERSION below is a reset switch, not a routine chore. The shell uses
 * stale-while-revalidate precisely so that an ordinary edit pushed to GitHub
 * Pages reaches the user on their next open with nothing to remember -- the
 * spec is explicit that this project must not grow steps its owner has to
 * recall six months later. Bump the version only to force every device to
 * throw its shell cache away at once (say, after a change that must not be
 * served half-old, half-new).
 */
'use strict';

importScripts('./js/contract.js');

var CACHE_VERSION = 'v1';
var SHELL_CACHE = 'el-shell-' + CACHE_VERSION;
var API_CACHE = 'el-api-' + CACHE_VERSION;
// Deliberately NOT tied to CACHE_VERSION: bumping the shell/API version on
// an unrelated UI fix should not wipe already-downloaded audio (that would
// defeat the "prefetch ahead of the commute" point of this whole file). It
// gets its own version only if the index format below ever changes shape.
var AUDIO_CACHE = 'el-audio-v1';

var AUDIO_INDEX_URL = self.location.origin + '/__sw_audio_index__';

var APP_SHELL_FILES = [
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './js/contract.js',
  './js/lesson.js',
  './js/review.js',
  './js/sync.js',
  './js/api.js',
  './js/store.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

// ---------------------------------------------------------------------
// install / activate
// ---------------------------------------------------------------------

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      // Individual puts (not cache.addAll) so one missing/failing file
      // (e.g. an icon typo) can't abort installing the whole shell --
      // same "one bad row can't sink the batch" spirit as js/lesson.js.
      return Promise.all(
        APP_SHELL_FILES.map(function (url) {
          return fetch(url, { cache: 'reload' })
            .then(function (res) {
              if (!res.ok) throw new Error('bad status ' + res.status);
              return cache.put(url, res);
            })
            .catch(function (err) {
              console.warn('sw: precache skipped for', url, err.message);
            });
        })
      );
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.map(function (name) {
          var isShellOrApi = name.indexOf('el-shell-') === 0 || name.indexOf('el-api-') === 0;
          var isCurrent = name === SHELL_CACHE || name === API_CACHE;
          if (isShellOrApi && !isCurrent) {
            return caches.delete(name);
          }
          // el-audio-* caches are left alone here on purpose (see AUDIO_CACHE
          // comment above) -- they get their own age-based eviction instead.
          return Promise.resolve();
        })
      );
    })
    .then(evictStaleAudioByIndex)
    .then(function () {
      return self.clients.claim();
    })
  );
});

// ---------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') {
    // POSTs (append, set_level) and anything else pass straight through --
    // the page's own offline queue (js/sync.js + app.js) already handles
    // retrying those, and a cached POST response would be meaningless.
    return;
  }

  var url = new URL(request.url);
  var action = url.searchParams.get('action');

  if (action === Contract.ACTIONS.AUDIO) {
    event.respondWith(handleAudioRequest(request));
    return;
  }

  if (action === Contract.ACTIONS.LESSONS || action === Contract.ACTIONS.PROGRESS) {
    event.respondWith(handleApiRequest(request, action));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(handleShellRequest(request, event));
    return;
  }

  // Unrecognised cross-origin request -- let the browser handle it.
});

// ---------------------------------------------------------------------
// Strategy: app shell -- stale-while-revalidate, with an offline navigation
// fallback to the cached index.html (single-page app, so any navigation is
// "the app").
//
// The cached copy is served immediately, so startup stays instant and works
// offline, while a background fetch quietly refreshes it. That is what keeps
// "edit a file, push to Pages, done" true: a returning device picks up the
// new version on its next open, with no version number to bump by hand.
// ---------------------------------------------------------------------

function handleShellRequest(request, event) {
  return caches.open(SHELL_CACHE).then(function (cache) {
    return cache.match(request).then(function (cached) {
      var networked = fetch(request).then(function (res) {
        if (res && res.ok) cache.put(request, res.clone());
        return res;
      }).catch(function (err) {
        if (cached) return cached;
        if (request.mode === 'navigate') {
          return cache.match('./index.html').then(function (shell) {
            if (shell) return shell;
            throw err;
          });
        }
        throw err;
      });

      if (cached) {
        // Keep the worker alive until the refresh lands; without this the
        // browser may kill it right after respondWith() and the cache.put
        // never happens, which would silently turn this back into
        // cache-first-forever.
        if (event && typeof event.waitUntil === 'function') {
          event.waitUntil(networked);
        }
        return cached;
      }
      return networked;
    });
  });
}

// ---------------------------------------------------------------------
// Strategy: Apps Script JSON API (lessons, progress) -- network-first,
// falling back to the last cached copy when offline.
// ---------------------------------------------------------------------

function handleApiRequest(request, action) {
  return caches.open(API_CACHE).then(function (cache) {
    return fetch(request).then(function (res) {
      if (res && res.ok) {
        cache.put(request, res.clone());
        if (action === Contract.ACTIONS.LESSONS) {
          // Fire-and-forget: don't make the page wait on audio prefetching.
          res.clone().json().then(function (json) {
            syncAudioCache(json, request.url);
          }).catch(function (err) {
            console.warn('sw: could not parse lessons response for prefetch', err.message);
          });
        }
      }
      return res;
    }).catch(function (err) {
      return cache.match(request).then(function (cached) {
        if (cached) return cached;
        throw err;
      });
    });
  });
}

// ---------------------------------------------------------------------
// Strategy: audio -- cache-first. Once a file_id is cached its bytes never
// change, so there is no reason to ever ask the network again for it.
// ---------------------------------------------------------------------

function handleAudioRequest(request) {
  return caches.open(AUDIO_CACHE).then(function (cache) {
    return cache.match(request).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (res) {
        if (res && res.ok) cache.put(request, res.clone());
        return res;
      });
    });
  });
}

// ---------------------------------------------------------------------
// Audio prefetch + eviction, driven by whatever the page's own
// Api.fetchLessons() call last returned (js/api.js / app.js call it on
// every boot and on every 'online' event -- see app.js refreshFromNetwork).
// ---------------------------------------------------------------------

/**
 * @param {*} lessonsJson - parsed body of an action=lessons response.
 *   Tolerates the same shapes app.js does: {lessons|rows|data: [...]}, or
 *   a bare array; each entry may be a raw Sheets row (array), a
 *   {lesson, errors} wrapper, or an already-flat lesson object.
 * @param {string} lessonsRequestUrl - the exact request URL used, so the
 *   same base Apps Script URL + token can be reused to build audio URLs
 *   byte-for-byte identical to what js/api.js's Api.buildAudioUrl() would
 *   produce (required for the cache-first audio lookup above to ever hit).
 */
function syncAudioCache(lessonsJson, lessonsRequestUrl) {
  var list = extractList(lessonsJson);
  var cutoff = Date.now() - Contract.OFFLINE.CACHE_DAYS * 24 * 60 * 60 * 1000;
  var token = new URL(lessonsRequestUrl).searchParams.get('token');
  var base = new URL(lessonsRequestUrl).origin + new URL(lessonsRequestUrl).pathname;

  var newIndex = {};
  list.forEach(function (entry) {
    var lesson = extractLessonObject(entry);
    if (!lesson || !lesson.lesson_id || !lesson.audio_file_id) return;
    var lessonTime = Date.parse(lesson.lesson_id);
    if (isNaN(lessonTime) || lessonTime < cutoff) return;
    newIndex[lesson.audio_file_id] = {
      lessonId: lesson.lesson_id,
      url: buildAudioUrl(base, token, lesson.audio_file_id)
    };
  });

  return readIndex().then(function (oldIndex) {
    return caches.open(AUDIO_CACHE).then(function (cache) {
      var removeStale = Object.keys(oldIndex).filter(function (fileId) {
        return !newIndex[fileId];
      }).map(function (fileId) {
        return cache.delete(oldIndex[fileId].url);
      });

      return Promise.all(removeStale).then(function () {
        return writeIndex(newIndex);
      }).then(function () {
        var prefetches = Object.keys(newIndex).map(function (fileId) {
          var entry = newIndex[fileId];
          return cache.match(entry.url).then(function (already) {
            if (already) return;
            return fetch(entry.url).then(function (res) {
              if (res && res.ok) return cache.put(entry.url, res);
            }).catch(function (err) {
              // Offline or a single bad file_id -- try again next sync.
              console.warn('sw: audio prefetch failed for', entry.lessonId, err.message);
            });
          });
        });
        return Promise.all(prefetches);
      });
    });
  });
}

/** Age-based eviction driven purely by the persisted index (no network needed). */
function evictStaleAudioByIndex() {
  var cutoff = Date.now() - Contract.OFFLINE.CACHE_DAYS * 24 * 60 * 60 * 1000;
  return readIndex().then(function (index) {
    return caches.open(AUDIO_CACHE).then(function (cache) {
      var kept = {};
      var deletions = Object.keys(index).map(function (fileId) {
        var entry = index[fileId];
        var lessonTime = Date.parse(entry.lessonId);
        if (!isNaN(lessonTime) && lessonTime >= cutoff) {
          kept[fileId] = entry;
          return Promise.resolve();
        }
        return cache.delete(entry.url);
      });
      return Promise.all(deletions).then(function () {
        return writeIndex(kept);
      });
    });
  });
}

function buildAudioUrl(base, token, fileId) {
  return base + '?token=' + encodeURIComponent(token) +
    '&action=' + encodeURIComponent(Contract.ACTIONS.AUDIO) +
    '&file_id=' + encodeURIComponent(fileId);
}

function readIndex() {
  return caches.open(AUDIO_CACHE).then(function (cache) {
    return cache.match(AUDIO_INDEX_URL).then(function (res) {
      if (!res) return {};
      return res.json().catch(function () { return {}; });
    });
  });
}

function writeIndex(index) {
  return caches.open(AUDIO_CACHE).then(function (cache) {
    return cache.put(AUDIO_INDEX_URL, new Response(JSON.stringify(index), {
      headers: { 'Content-Type': 'application/json' }
    }));
  });
}

/** Same tolerant shape-handling as app.js's extractList(). */
function extractList(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    var keys = ['lessons', 'rows', 'data'];
    for (var i = 0; i < keys.length; i++) {
      if (Array.isArray(json[keys[i]])) return json[keys[i]];
    }
  }
  return [];
}

/** Same tolerant per-entry handling as app.js's normalizeLessonEntry(). */
function extractLessonObject(entry) {
  if (Array.isArray(entry)) {
    var obj = {};
    Contract.LESSON_COLUMNS.forEach(function (col, i) {
      obj[col] = entry[i];
    });
    return obj;
  }
  if (entry && typeof entry === 'object') {
    if ('lesson' in entry) return entry.lesson || null;
    return entry;
  }
  return null;
}
