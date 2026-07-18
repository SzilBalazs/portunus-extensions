// Portunus YTM companion — background relay.
//
// Bridges two channels:
//   Portunus  ←native messaging→  this script  ←tabs.sendMessage→  content script
//
// Portunus (via the `portunus native-host ytm` shim) sends request objects
// `{id, payload}`; we must answer each with `{id, payload: <reply>}` echoing
// the id. `payload` is `{op, ...}`; we forward it to the music.youtube.com
// content script and relay its response straight back.

const HOST = "portunus_ytm";
const CONTENT_TIMEOUT_MS = 6000;
const BACKOFF_MS = [5000, 15000, 60000]; // reconnect schedule, last value repeats

let port = null;
let backoffIdx = 0;

function connect() {
  try {
    port = browser.runtime.connectNative(HOST);
  } catch (e) {
    console.error("[ytm] connectNative threw:", e);
    scheduleReconnect();
    return;
  }
  port.onMessage.addListener(onRequest);
  port.onDisconnect.addListener(() => {
    const err = browser.runtime.lastError || (port && port.error);
    console.warn("[ytm] native host disconnected:", err && err.message);
    port = null;
    scheduleReconnect();
  });
  // A successful message resets the backoff (see onRequest).
  console.info("[ytm] connected to native host");
}

function scheduleReconnect() {
  const delay = BACKOFF_MS[Math.min(backoffIdx, BACKOFF_MS.length - 1)];
  backoffIdx++;
  setTimeout(connect, delay);
}

async function onRequest(msg) {
  backoffIdx = 0; // we're clearly alive
  if (!msg || typeof msg.id !== "number") {
    return; // not a request envelope
  }
  const reply = payload => {
    if (port) port.postMessage({ id: msg.id, payload });
  };
  try {
    reply(await handle(msg.payload || {}));
  } catch (e) {
    reply({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}

// Routes one op to a YouTube Music tab, opening one if needed for play_now.
async function handle(payload) {
  const op = payload.op;
  const tab = await findMusicTab();

  if (!tab) {
    if (op === "play_now" && payload.videoId) {
      // No tab yet: open the track directly — it autoplays on load.
      await browser.tabs.create({ url: watchUrl(payload.videoId) });
      return { ok: true };
    }
    return { ok: false, error: "no YouTube Music tab — open music.youtube.com" };
  }

  return await sendToContent(tab.id, payload);
}

// Prefers an audible tab, then the most recently active one.
async function findMusicTab() {
  const tabs = await browser.tabs.query({ url: "https://music.youtube.com/*" });
  if (tabs.length === 0) return null;
  const audible = tabs.find(t => t.audible);
  if (audible) return audible;
  return tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

// Sends a payload to the tab's router content script, with a timeout so a
// wedged content script can't hang the Portunus request forever.
function sendToContent(tabId, payload) {
  return new Promise(resolve => {
    let settled = false;
    const done = v => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const timer = setTimeout(
      () => done({ ok: false, error: "content script timed out" }),
      CONTENT_TIMEOUT_MS,
    );
    browser.tabs
      .sendMessage(tabId, payload)
      .then(resp => {
        clearTimeout(timer);
        done(resp && typeof resp === "object" ? resp : { ok: false, error: "empty content response" });
      })
      .catch(e => {
        clearTimeout(timer);
        done({ ok: false, error: "content script unreachable: " + (e && e.message) });
      });
  });
}

function watchUrl(videoId) {
  return "https://music.youtube.com/watch?v=" + encodeURIComponent(videoId);
}

connect();
