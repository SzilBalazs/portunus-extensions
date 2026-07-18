// FRAGILE module: play-now / play-next / add-to-queue.
//
// play_now needs no page internals — a content script can navigate the tab,
// and YouTube Music autoplays a /watch URL. Only the queue actions reach into
// the app's internal store, which lives in the page's JS world that Firefox
// content scripts can't touch (Xray). That reverse-engineered part runs in
// page-bridge.js, injected as a web_accessible_resource <script> (exempt from
// the page CSP because it's an extension URL); this file is the content-script
// side of a postMessage RPC to it.

(() => {
  const TAG = "__ytmBridge";
  const CALL_TIMEOUT_MS = 5000;
  const READY_TIMEOUT_MS = 3000;
  const pending = new Map();
  let seq = 0;
  const LOG = (...a) => console.log("[ytm-cs]", ...a);

  // Resolves once page-bridge.js has loaded and registered its listener. We
  // inject eagerly (not on first action) and gate the first postMessage on the
  // bridge's "ready" handshake — otherwise the request races the async script
  // load and is dropped before the listener exists.
  let markReady;
  const bridgeReady = new Promise((resolve) => (markReady = resolve));

  function injectBridge() {
    LOG("injecting page-bridge.js");
    const s = document.createElement("script");
    s.src = browser.runtime.getURL("content/page-bridge.js");
    // Remove only after it has run, so the load isn't cancelled.
    s.onload = () => {
      LOG("page-bridge.js <script> loaded");
      s.remove();
    };
    s.onerror = () => LOG("page-bridge.js <script> FAILED to load (CSP?)");
    (document.head || document.documentElement).appendChild(s);
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d[TAG] === undefined) return;
    if (d[TAG] === "ready") {
      LOG("bridge ready handshake received");
      markReady();
      return;
    }
    if (d[TAG] === "reply" && typeof d.id === "number") {
      const resolve = pending.get(d.id);
      if (resolve) {
        pending.delete(d.id);
        resolve(d.result || { ok: false, error: "empty bridge reply" });
      }
    }
  });

  async function callBridge(op, videoId) {
    // Wait for the bridge, but don't hang forever if injection was blocked.
    const ready = await Promise.race([
      bridgeReady.then(() => true),
      new Promise((r) => setTimeout(() => r(false), READY_TIMEOUT_MS)),
    ]);
    if (!ready) {
      LOG("callBridge: bridge NOT ready after", READY_TIMEOUT_MS, "ms");
      return { ok: false, error: "page bridge did not load (CSP or script blocked)" };
    }

    const id = ++seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          LOG("callBridge: no reply for", op, "id", id, "→ timeout");
          resolve({ ok: false, error: "page bridge timed out" });
        }
      }, CALL_TIMEOUT_MS);
      pending.set(id, (result) => {
        clearTimeout(timer);
        LOG("callBridge: reply for", op, "id", id, result);
        resolve(result);
      });
      LOG("callBridge: posting request", op, "id", id, "videoId", videoId);
      window.postMessage({ [TAG]: "request", id, op, videoId }, location.origin);
    });
  }

  async function action(op, videoId) {
    if (!videoId) return { ok: false, error: "no videoId" };
    // All three (play_now / queue_next / queue_last) run through the page
    // bridge's store path. play_now inserts after the current track and jumps
    // to it in-tab — no navigation/reload, so the queue is preserved.
    return await callBridge(op, videoId);
  }

  injectBridge();
  window.__ytmCompanion = window.__ytmCompanion || {};
  window.__ytmCompanion.action = action;
})();
