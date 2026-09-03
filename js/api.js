/**
 * Thin wrapper around the Apps Script Web App API described in
 * docs/specs/2026-09-02-practice-web-app.md ("Apps Script API 契約").
 *
 * No DOM access here -- only fetch() calls (per spec 硬性約束: DOM
 * operations live only in app.js). The Apps Script URL and sync token are
 * always read from js/store.js (localStorage) at call time; they are never
 * hardcoded here.
 *
 * Note on load order: this file is loaded (per index.html) BEFORE
 * js/store.js. That is fine -- Store is only referenced inside function
 * bodies below, which run later (after every script has loaded), never at
 * parse time.
 */
(function (root) {
  'use strict';

  var Contract = root.Contract;

  function requireUrl() {
    var url = root.Store && root.Store.getApiUrl();
    if (!url) {
      throw new Error('Api: Apps Script URL is not configured yet.');
    }
    return url;
  }

  function requireToken() {
    var token = root.Store && root.Store.getSyncToken();
    if (!token) {
      throw new Error('Api: sync token is not configured yet.');
    }
    return token;
  }

  function buildUrl(params) {
    var url = requireUrl();
    var query = Object.keys(params)
      .filter(function (key) {
        var v = params[key];
        return v !== undefined && v !== null && v !== '';
      })
      .map(function (key) {
        return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
      })
      .join('&');
    return url + (url.indexOf('?') === -1 ? '?' : '&') + query;
  }

  /**
   * Apps Script web apps always respond HTTP 200 (see Code.gs top-of-file
   * comment) -- failure is signalled only through the JSON body's `ok`
   * field, with a machine-readable `error` code: forbidden, unknown_action,
   * sheet_not_found, not_found, missing_file_id, invalid_body,
   * invalid_level, lock_timeout, internal_error.
   *
   * This is the single place that checks `ok`: every Api.* method below
   * resolves with the raw success body ({ok:true, ...}) and rejects with an
   * ApiError (err.code, err.response) on {ok:false}, so callers in app.js
   * never need to re-guess the response shape.
   */
  function ApiError(action, response) {
    var code = (response && response.error) || 'unknown_error';
    var err = new Error('Api: ' + action + ' failed (' + code + ')');
    err.code = code;
    err.response = response;
    return err;
  }

  function checkOk(action, body) {
    if (!body || body.ok !== true) {
      throw ApiError(action, body);
    }
    return body;
  }

  function get(action, extraParams) {
    var params = { token: requireToken(), action: action };
    var key;
    for (key in (extraParams || {})) {
      if (Object.prototype.hasOwnProperty.call(extraParams, key)) {
        params[key] = extraParams[key];
      }
    }
    return fetch(buildUrl(params), { method: 'GET' }).then(function (res) {
      if (!res.ok) {
        throw new Error('Api: ' + action + ' request failed with status ' + res.status);
      }
      return res.json();
    }).then(function (body) {
      return checkOk(action, body);
    });
  }

  function post(action, body) {
    var params = { token: requireToken(), action: action };
    return fetch(buildUrl(params), {
      method: 'POST',
      // 'text/plain' (instead of 'application/json') avoids a CORS
      // preflight OPTIONS request, which Apps Script Web Apps do not
      // handle. The body is still a JSON string; Apps Script reads it via
      // e.postData.contents and parses it itself.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) {
        throw new Error('Api: ' + action + ' request failed with status ' + res.status);
      }
      return res.json();
    }).then(function (responseBody) {
      return checkOk(action, responseBody);
    });
  }

  /** Decodes a base64 string (as returned by action=audio) into a Blob. */
  function base64ToBlob(base64, mimeType) {
    var binary = atob(base64);
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType || 'audio/mpeg' });
  }

  var Api = {
    /** GET action=lessons. `since` (a lesson_id date) is optional. */
    fetchLessons: function (since) {
      return get(Contract.ACTIONS.LESSONS, since ? { since: since } : {});
    },

    /** GET action=progress. `since` (ISO8601) is optional. */
    fetchProgress: function (since) {
      return get(Contract.ACTIONS.PROGRESS, since ? { since: since } : {});
    },

    /** POST action=append, body = array of progress records. */
    appendProgress: function (records) {
      return post(Contract.ACTIONS.APPEND, records);
    },

    /** POST action=set_level, body = {level}. */
    setLevel: function (level) {
      return post(Contract.ACTIONS.SET_LEVEL, { level: level });
    },

    /**
     * GET action=audio. Apps Script cannot emit a binary HTTP response (see
     * Code.gs actionAudio comment), so this is NOT a URL an <audio> element
     * can use directly -- it returns {ok, file_id, mime_type, filename,
     * base64}. This method decodes that base64 payload into a Blob and
     * hands back an object URL (via URL.createObjectURL) ready to assign to
     * <audio>.src. The caller (app.js) owns that URL's lifetime and must
     * call URL.revokeObjectURL() on it once the lesson/audio changes or the
     * page is left, or the decoded audio stays pinned in memory.
     */
    fetchAudio: function (fileId) {
      return get(Contract.ACTIONS.AUDIO, { file_id: fileId }).then(function (body) {
        var blob = base64ToBlob(body.base64, body.mime_type);
        return {
          objectUrl: URL.createObjectURL(blob),
          mimeType: body.mime_type,
          filename: body.filename,
          fileId: body.file_id
        };
      });
    }
  };

  root.Api = Api;
})(typeof window !== 'undefined' ? window : this);
