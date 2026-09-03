/**
 * localStorage-backed storage for the practice web app.
 *
 * No DOM access here -- per docs/specs/2026-09-02-practice-web-app.md, DOM
 * operations live only in app.js. This file only reads/writes
 * window.localStorage.
 *
 * Two keys are owned directly by this file: the Apps Script Web App URL and
 * the sync token. They are read here and only here, so neither one is ever
 * hardcoded anywhere else in the codebase (see spec 硬性約束). Everything
 * else reuses the storage keys already defined in Contract.OFFLINE, so
 * js/contract.js stays the single source of truth for key names.
 */
(function (root) {
  'use strict';

  var Contract = root.Contract;

  var KEY_API_URL = 'el.config.apiUrl';
  var KEY_SYNC_TOKEN = 'el.config.syncToken';

  function readString(key) {
    try {
      return root.localStorage.getItem(key) || '';
    } catch (e) {
      // localStorage unavailable (private browsing, disabled, ...) -- treat
      // as "not configured" rather than throwing.
      return '';
    }
  }

  function writeString(key, value) {
    try {
      root.localStorage.setItem(key, value);
    } catch (e) {
      // Storage full or unavailable -- the app keeps working in-memory for
      // this session, it just won't persist across reloads.
    }
  }

  function readJson(key, fallback) {
    var raw = readString(key);
    if (!raw) return fallback;
    try {
      var parsed = JSON.parse(raw);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      writeString(key, JSON.stringify(value));
    } catch (e) {
      // Value not serializable -- should not happen for the plain
      // objects/arrays this module stores, but never let it throw.
    }
  }

  /** Not a formal UUID -- just needs to be unique enough to tell two devices apart. */
  function generateDeviceId() {
    return 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  var Store = {
    // --- Apps Script connection config (never hardcoded elsewhere) ---
    getApiUrl: function () {
      return readString(KEY_API_URL);
    },
    setApiUrl: function (url) {
      writeString(KEY_API_URL, url || '');
    },
    getSyncToken: function () {
      return readString(KEY_SYNC_TOKEN);
    },
    setSyncToken: function (token) {
      writeString(KEY_SYNC_TOKEN, token || '');
    },
    hasConfig: function () {
      return !!(this.getApiUrl() && this.getSyncToken());
    },

    // --- offline answer queue (unconfirmed records) ---
    getQueue: function () {
      return readJson(Contract.OFFLINE.QUEUE_STORAGE_KEY, []);
    },
    setQueue: function (queue) {
      writeJson(Contract.OFFLINE.QUEUE_STORAGE_KEY, queue || []);
    },

    // --- cached lesson content, for offline use and review-item lookups ---
    getLessons: function () {
      return readJson(Contract.OFFLINE.LESSON_STORAGE_KEY, []);
    },
    setLessons: function (lessons) {
      writeJson(Contract.OFFLINE.LESSON_STORAGE_KEY, lessons || []);
    },

    // --- cached copy of remote-confirmed progress records ---
    getProgress: function () {
      return readJson(Contract.OFFLINE.PROGRESS_STORAGE_KEY, []);
    },
    setProgress: function (records) {
      writeJson(Contract.OFFLINE.PROGRESS_STORAGE_KEY, records || []);
    },

    // --- misc settings: current level, device id, mode override, last sync ---
    getSettings: function () {
      var settings = readJson(Contract.OFFLINE.SETTINGS_STORAGE_KEY, {});
      var changed = false;
      if (!settings.deviceId) {
        settings.deviceId = generateDeviceId();
        changed = true;
      }
      if (!settings.level) {
        settings.level = Contract.DEFAULT_LEVEL;
        changed = true;
      }
      if (changed) {
        writeJson(Contract.OFFLINE.SETTINGS_STORAGE_KEY, settings);
      }
      return settings;
    },
    setSettings: function (partial) {
      var current = readJson(Contract.OFFLINE.SETTINGS_STORAGE_KEY, {});
      var next = {};
      var k;
      for (k in current) if (Object.prototype.hasOwnProperty.call(current, k)) next[k] = current[k];
      for (k in (partial || {})) if (Object.prototype.hasOwnProperty.call(partial, k)) next[k] = partial[k];
      writeJson(Contract.OFFLINE.SETTINGS_STORAGE_KEY, next);
      return next;
    }
  };

  root.Store = Store;
})(typeof window !== 'undefined' ? window : this);
