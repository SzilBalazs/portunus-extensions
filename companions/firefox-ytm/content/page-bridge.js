// PAGE-CONTEXT half of the fragile action module. Runs in music.youtube.com's
// own JS world (injected by actions.js), so it can reach the YouTube Music app
// element and its internal store — which content scripts can't (Xray).
//
// Only the queue actions come here; play_now is handled in the content script.
//
// ⚠ Everything here is reverse-engineered from YouTube Music's internals and is
// the single most breakage-prone part of the companion. Each entry point is
// wrapped so a failed internal call becomes a clear error reply, never an
// exception. When YT Music changes, this is the file to fix.

(() => {
  const TAG = "__ytmBridge";
  const LOG = (...a) => console.log("[ytm-bridge]", ...a);

  // Single-instance guard. Re-injection (add-on reload without a page refresh)
  // would otherwise stack another message listener in the same page context,
  // so each request would run N times (N duplicate queue entries). Runs in the
  // page's real window, so the flag is shared across injected instances. Still
  // re-post "ready" so a freshly re-injected content script re-syncs.
  if (window.__ytmBridgeInstalled) {
    window.postMessage({ [TAG]: "ready" }, location.origin);
    return;
  }
  window.__ytmBridgeInstalled = true;
  LOG("page-bridge script executing in page context");

  function reply(id, result) {
    window.postMessage({ [TAG]: "reply", id, result }, location.origin);
  }

  function getApp() {
    // The top-level custom element; present on every music.youtube.com page.
    return document.querySelector("ytmusic-app");
  }

  // One-shot introspection of the internals the queue path depends on, so a
  // failing enqueue shows WHAT is missing rather than just hanging.
  function probe() {
    const app = getApp();
    const nm = app && app.networkManager;
    // Any own-property of the app that looks like a Redux store.
    const storeKeys = [];
    if (app) {
      for (const k in app) {
        try {
          const v = app[k];
          if (v && typeof v.dispatch === "function" && typeof v.getState === "function") {
            storeKeys.push(k);
          }
        } catch (_) {
          /* getters can throw; ignore */
        }
      }
    }
    const info = {
      app: !!app,
      networkManager: nm ? typeof nm : "absent",
      "networkManager.fetch": nm && typeof nm.fetch,
      resolvedStore: !!resolveStore(app),
      storeLikeKeys: storeKeys,
      queueEls: [...document.querySelectorAll("ytmusic-app *")]
        .map((e) => e.tagName.toLowerCase())
        .filter((t) => t.includes("queue"))
        .filter((v, i, a) => a.indexOf(v) === i),
    };
    LOG("internals probe:", info);
    return info;
  }

  const isStore = (v) =>
    v && typeof v.dispatch === "function" && typeof v.getState === "function";

  // Deep scan: the store may now live on any element under the app (e.g. the
  // player-queue element), not the app itself. Returns {tag, key, store}.
  function findStoreDeep() {
    const root = getApp();
    if (!root) return null;
    for (const el of [root, ...root.querySelectorAll("*")]) {
      // Redux now mixes onto components directly (el.dispatch/getState), not a
      // `.store` property — check the element itself first.
      if (isStore(el)) return { tag: el.tagName.toLowerCase(), key: "<self>", store: el };
      for (const k in el) {
        try {
          if (isStore(el[k])) return { tag: el.tagName.toLowerCase(), key: k, store: el[k] };
        } catch (_) {
          /* getters can throw; ignore */
        }
      }
    }
    return null;
  }

  // The Redux-style store has moved across YT Music builds. Try the known
  // locations first (cheap), then fall back to a deep scan.
  function resolveStore(app) {
    const cands = [
      app && app.store,
      app && app.store_,
      app && app._store,
      app && app.$ && app.$.store,
      app && app.provider_ && app.provider_.store,
    ];
    return cands.find(isStore) || (findStoreDeep() || {}).store;
  }

  // Enqueue via YT Music's own store, mirroring th-ch/youtube-music's queue
  // code (the maintained reference). The store lives at
  // `#queue.queue.store.store`; items are fetched with the same `/music/get_queue`
  // call the app uses, then added with an `ADD_ITEMS` dispatch through the queue
  // element. `atNext` inserts after the currently-playing track; otherwise the
  // item is appended.
  async function enqueueViaStore(videoId, atNext) {
    const app = getApp();
    if (!app || !app.networkManager || typeof app.networkManager.fetch !== "function") {
      throw new Error("ytmusic-app / networkManager.fetch missing");
    }
    const queueEl = document.querySelector("#queue");
    const store = queueEl && queueEl.queue && queueEl.queue.store && queueEl.queue.store.store;
    if (!store || typeof store.getState !== "function" || typeof queueEl.dispatch !== "function") {
      throw new Error("queue store not found at #queue.queue.store.store");
    }

    // Fetch the full queue item(s) for the videoId (same call the app makes).
    const resp = await app.networkManager.fetch("/music/get_queue", {
      queueContextParams: store.getState().queue.queueContextParams,
      videoIds: [videoId],
    });
    const items = ((resp && resp.queueDatas) || []).map((d) => d && d.content).filter(Boolean);
    if (items.length === 0) throw new Error("get_queue returned no items");

    const q = store.getState().queue;
    const index = atNext
      ? (typeof q.selectedItemIndex === "number" ? q.selectedItemIndex + 1 : q.items.length)
      : q.items.length;

    queueEl.dispatch({
      type: "ADD_ITEMS",
      payload: {
        nextQueueItemId: q.nextQueueItemId,
        index,
        items,
        shuffleEnabled: false,
        shouldAssignIds: true,
      },
    });
    return index;
  }

  // In-tab "play now": insert right after the current track, jump to it, and
  // start playback. No navigation/reload, so the rest of the queue is kept
  // (unlike opening the watch URL, which resets the queue).
  async function playNowViaStore(videoId) {
    const index = await enqueueViaStore(videoId, true);
    const queueEl = document.querySelector("#queue");
    if (queueEl && typeof queueEl.dispatch === "function") {
      queueEl.dispatch({ type: "SET_INDEX", payload: index });
    }
    const player = document.querySelector("#movie_player");
    if (player && typeof player.playVideo === "function") player.playVideo();
  }

  // DEBUG SPY: locate the store, wrap its dispatch to log every action, and
  // listen for yt-action events. Arm it, then do "Add to queue" / "Play next"
  // from the UI to capture the exact action shape to replicate. Idempotent.
  // Remove (and the auto-arm call below) before shipping.
  let spyArmed = false;
  function spy() {
    if (spyArmed) return { ok: true, note: "spy already armed" };
    const found = findStoreDeep();
    if (found) {
      LOG(`spy: store at <${found.tag}>.${found.key}`);
      const s = found.store;
      const orig = s.dispatch.bind(s);
      s.dispatch = (a) => {
        try {
          LOG("DISPATCH", a && a.type, a);
        } catch (_) {}
        return orig(a);
      };
    } else {
      LOG("spy: no store found on any element under ytmusic-app");
    }
    window.addEventListener(
      "yt-action",
      (e) => {
        try {
          const name = e.detail && e.detail.actionName;
          if (name !== "yt-service-request") return; // quiet the noise
          const args = (e.detail && e.detail.args) || [];
          // The endpoint is a PLAIN data object (not the source element) that
          // carries commandMetadata or a *Endpoint key.
          const isEl = (a) => a && (a.nodeType || a.tagName || "__CE_shadowRoot" in a);
          const ep = args.find(
            (a) =>
              a &&
              typeof a === "object" &&
              !isEl(a) &&
              Object.keys(a).some((k) => /Endpoint$/.test(k) || k === "commandMetadata"),
          );
          if (!ep) {
            LOG("SERVICE-REQ: no endpoint object in args", args.length, "arg(s)");
            return;
          }
          const epKey = Object.keys(ep).find((k) => /Endpoint$/.test(k));
          LOG("SERVICE-REQ endpoint keys:", Object.keys(ep), "endpointType:", epKey);
          if (epKey) LOG("SERVICE-REQ", epKey, "=", JSON.stringify(ep[epKey]));
        } catch (err) {
          LOG("yt-action log error", err);
        }
      },
      true,
    );
    spyArmed = true;
    return { ok: true, store: found ? { tag: found.tag, key: found.key } : null };
  }

  // Collapse duplicate enqueues (same op+track within a short window) that
  // stacked content-script instances can produce after add-on reloads. Each
  // caller still gets an ok reply; the endpoint only actually runs once.
  const recentOps = new Map();
  function isDuplicate(key) {
    const now = Date.now();
    const last = recentOps.get(key) || 0;
    recentOps.set(key, now);
    return now - last < 1500;
  }

  // op: "play_now" | "queue_next" | "queue_last".
  async function runQueueOp(id, op, videoId) {
    const dedupeKey = op + ":" + videoId;
    try {
      if (isDuplicate(dedupeKey)) {
        LOG("op: duplicate suppressed", op, videoId);
        reply(id, { ok: true, deduped: true });
        return;
      }
      if (op === "play_now") {
        await playNowViaStore(videoId);
      } else {
        await enqueueViaStore(videoId, op === "queue_next");
      }
      LOG("op: done", op, videoId);
      reply(id, { ok: true });
    } catch (e) {
      LOG("op: FAILED", op, e);
      reply(id, {
        ok: false,
        error: "queue action failed — YT Music internals may have changed: " + (e && e.message),
      });
    }
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d[TAG] !== "request" || typeof d.id !== "number") return;
    LOG("request received:", d.op, "id", d.id);
    switch (d.op) {
      case "ping":
        // Channel test: no YT internals touched. Reports what it can see.
        reply(d.id, { ok: true, probe: probe() });
        break;
      case "spy":
        // Arm the dispatch/action logger (see spy()).
        reply(d.id, spy());
        break;
      case "play_now":
      case "queue_next":
      case "queue_last":
        runQueueOp(d.id, d.op, d.videoId);
        break;
      default:
        reply(d.id, { ok: false, error: "unknown op: " + d.op });
    }
  });

  // Handshake: tell the content script the listener is live, so its first
  // queue request isn't posted before we can receive it.
  LOG("posting ready handshake");
  window.postMessage({ [TAG]: "ready" }, location.origin);

  // DEBUG: auto-arm the spy on every load so "Add to queue" in the UI reveals
  // the real action shape without any manual trigger. Remove before shipping.
  spy();
})();
