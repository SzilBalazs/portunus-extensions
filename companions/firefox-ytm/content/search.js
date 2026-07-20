// STURDY module: personalized YouTube Music search.
//
// Runs entirely in the content script — no page-context injection needed.
// The content script shares the tab's cookie jar, and host_permissions make
// the fetch same-origin, so we can call InnerTube with the user's own auth:
// an Authorization: SAPISIDHASH header computed from the SAPISID cookie is
// exactly what music.youtube.com sends itself. This is the well-worn,
// stable path (the fragile queue/navigation code lives in actions.js).

(() => {
  const ORIGIN = "https://music.youtube.com";
  const SONGS_FILTER = "EgWKAQIIAWoKEAoQAxAEEAkQBQ%3D%3D";
  const CLIENT_VERSION_FALLBACK = "1.20240101.00.00";
  const MAX_SONGS = 15;

  // The InnerTube client version, read from the page's ytcfg if the DOM
  // exposed it, else a safe recent fallback. ytcfg lives on the page window
  // (Xray-hidden), so we can't read it directly; a stale version still works
  // for search, so the fallback is fine.
  function clientVersion() {
    const el = document.querySelector('meta[itemprop="clientVersion"]');
    return (el && el.content) || CLIENT_VERSION_FALLBACK;
  }

  function readCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function sha1Hex(str) {
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // Authorization: SAPISIDHASH <ts>_<sha1(`${ts} ${SAPISID} ${ORIGIN}`)>.
  async function sapisidHash() {
    const sapisid =
      readCookie("SAPISID") ||
      readCookie("__Secure-3PAPISID") ||
      readCookie("__Secure-1PAPISID");
    if (!sapisid) return null; // not logged in — caller degrades to no auth
    const ts = Math.floor(Date.now() / 1000);
    const hash = await sha1Hex(`${ts} ${sapisid} ${ORIGIN}`);
    return `SAPISIDHASH ${ts}_${hash}`;
  }

  // Generic authenticated InnerTube POST. Shares the tab's cookie jar +
  // SAPISIDHASH auth — exactly what music.youtube.com sends itself — so it works
  // with the user's own session. `path` is the endpoint name ("search",
  // "browse", …); `body` is merged onto the standard client context. Returns the
  // parsed JSON, or throws on network / non-200 / parse failure. Shared by the
  // sturdy read paths (search + library browse); the fragile store code stays in
  // actions.js/page-bridge.js.
  async function innertube(path, body) {
    const headers = {
      "Content-Type": "application/json",
      "X-Goog-AuthUser": "0",
      "X-Origin": ORIGIN,
    };
    const auth = await sapisidHash();
    if (auth) headers["Authorization"] = auth;

    const full = {
      context: { client: { clientName: "WEB_REMIX", clientVersion: clientVersion() } },
      ...body,
    };
    const url = ORIGIN + "/youtubei/v1/" + path + "?prettyPrint=false";
    const resp = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify(full),
    });
    if (!resp.ok) throw new Error("innertube status " + resp.status);
    return await resp.json();
  }

  async function search(query) {
    if (!query) return { ok: true, results: [] };
    let json;
    try {
      json = await innertube("search", { query, params: SONGS_FILTER });
    } catch (e) {
      return { ok: false, error: "search failed: " + (e && e.message) };
    }
    return { ok: true, results: parseSongs(json) };
  }

  // Walk the (undocumented) search response for song rows. Every step is a
  // guarded lookup; a malformed row is skipped, never fatal.
  function parseSongs(root) {
    const out = [];
    const tabs = root?.contents?.tabbedSearchResultsRenderer?.tabs;
    if (!Array.isArray(tabs)) return out;

    for (const tab of tabs) {
      const sections = tab?.tabRenderer?.content?.sectionListRenderer?.contents;
      if (!Array.isArray(sections)) continue;
      for (const section of sections) {
        const rows = section?.musicShelfRenderer?.contents;
        if (!Array.isArray(rows)) continue;
        for (const row of rows) {
          const mrlir = row?.musicResponsiveListItemRenderer;
          if (!mrlir) continue;
          const song = parseRow(mrlir);
          if (song) {
            out.push(song);
            if (out.length >= MAX_SONGS) return out;
          }
        }
      }
    }
    return out;
  }

  function flexRuns(col) {
    const runs = col?.musicResponsiveListItemFlexColumnRenderer?.text?.runs;
    return Array.isArray(runs) ? runs : [];
  }

  function parseRow(mrlir) {
    const flex = mrlir?.flexColumns;
    if (!Array.isArray(flex) || flex.length === 0) return null;

    const titleRuns = flexRuns(flex[0]);
    const title = titleRuns[0]?.text || "";
    if (!title) return null;

    const videoId =
      mrlir?.playlistItemData?.videoId ||
      titleRuns[0]?.navigationEndpoint?.watchEndpoint?.videoId ||
      "";
    if (!videoId) return null;

    // Column 1 → "Song • Artist • Album • 3:45"-ish runs.
    const metaRuns = flexRuns(flex[1]).map(r => r.text).filter(Boolean);
    const isDuration = t => /^\d{1,2}(:\d{2})+$/.test(t.trim());
    // Playlist rows carry the duration in a fixed column, not the flex meta;
    // fall back to it so playlist tracks still get a duration badge.
    const fixedRuns =
      mrlir?.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs;
    const fixedDuration = Array.isArray(fixedRuns)
      ? (fixedRuns.map(r => r.text).find(t => t && isDuration(t)) || "")
      : "";
    const duration = metaRuns.find(isDuration) || fixedDuration;
    const parts = metaRuns.filter(t => t.trim() && t !== " • " && !isDuration(t));
    // A leading content-type token ("Song"/"Video"/…) appears on the top-result
    // card but not on song rows — drop it only when it really is a type word,
    // so a bare artist isn't mistaken for it and dropped (showing the album).
    const TYPES = ["song", "video", "single", "album", "ep", "playlist", "artist", "episode"];
    const meaningful = parts.length && TYPES.includes(parts[0].trim().toLowerCase()) ? parts.slice(1) : parts;
    const artist = meaningful[0] || "";
    const album = meaningful[1] || "";
    const thumbnail = biggestThumb(mrlir);

    return { videoId, title, artist, album, duration, thumbnail };
  }

  // Largest album-art URL on the row renderer, for the extension's preview.
  function biggestThumb(mrlir) {
    const thumbs =
      mrlir?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
    if (!Array.isArray(thumbs) || thumbs.length === 0) return "";
    return thumbs.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a)).url || "";
  }

  window.__ytmCompanion = window.__ytmCompanion || {};
  window.__ytmCompanion.search = search;
  // Shared by library.js: the authenticated InnerTube caller and the row parser
  // for musicResponsiveListItemRenderer (playlist tracks use the same renderer
  // as search rows), so browse code reuses this module's auth + parsing.
  window.__ytmCompanion.innertube = innertube;
  window.__ytmCompanion.parseListItem = parseRow;
})();
