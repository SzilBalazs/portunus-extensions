// Content-script router: receives a payload from the background relay and
// dispatches by `op`. search.js and actions.js (loaded before this file)
// register their handlers on `window.__ytmCompanion`.
//
// Returns a Promise from the listener (Firefox honours this and keeps the
// message channel open), so the background script's `sendMessage(...).then`
// resolves with the handler's reply object.

(() => {
  const api = window.__ytmCompanion || {};

  browser.runtime.onMessage.addListener((payload) => {
    if (!payload || typeof payload.op !== "string") {
      return Promise.resolve({ ok: false, error: "bad request" });
    }
    switch (payload.op) {
      case "search":
        return api.search
          ? api.search(String(payload.q || ""))
          : Promise.resolve({ ok: false, error: "search unavailable" });
      case "play_now":
      case "queue_next":
      case "queue_last":
        return api.action
          ? api.action(payload.op, String(payload.videoId || ""))
          : Promise.resolve({ ok: false, error: "actions unavailable" });
      default:
        return Promise.resolve({ ok: false, error: "unknown op: " + payload.op });
    }
  });
})();
