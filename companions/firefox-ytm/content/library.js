// STURDY module: library browsing — the user's playlists and their tracks.
//
// Like search.js this runs entirely in the content script: it reuses that
// module's authenticated InnerTube caller (window.__ytmCompanion.innertube) and
// its row parser, so no page-context injection is needed. Two read-only browse
// calls back the extension's "playlists" command:
//   get_playlists           → the "liked playlists" grid (your library).
//   get_playlist_tracks {browseId} → one playlist's tracks (drill-in view).
//
// Every response walk is a guarded lookup; a shape change yields an empty list
// or a clear error reply, never a throw.

(() => {
  const LOG = (...a) => console.log("[ytm-lib]", ...a);

  function api() {
    return window.__ytmCompanion || {};
  }

  // Depth-first collector: gather every value stored under `key` anywhere in the
  // response tree. YT Music moves renderers between grid / carousel / shelf /
  // single- vs two-column layouts across builds, so collecting by renderer key
  // is far more robust than pinning an exact path. Cycle-guarded via `seen`.
  function collectByKey(root, key, out, seen) {
    out = out || [];
    seen = seen || new Set();
    if (!root || typeof root !== "object" || seen.has(root)) return out;
    seen.add(root);
    if (Array.isArray(root)) {
      for (const v of root) collectByKey(v, key, out, seen);
      return out;
    }
    for (const k of Object.keys(root)) {
      if (k === key) out.push(root[k]);
      else collectByKey(root[k], key, out, seen);
    }
    return out;
  }

  function runsText(node) {
    const runs = node && node.runs;
    if (Array.isArray(runs)) return runs.map((r) => r && r.text).filter(Boolean).join("");
    return (node && node.simpleText) || "";
  }

  function largestThumb(node) {
    const t = node && node.thumbnail && node.thumbnail.thumbnails;
    if (!Array.isArray(t) || t.length === 0) return "";
    return t.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a)).url || "";
  }

  // --- Playlists (library) --------------------------------------------------

  // A playlist card is a musicTwoRowItemRenderer whose navigation goes to a
  // browse page. Cards without a browseId (the "New playlist" button) are
  // skipped. browseId looks like "VLPL…" / "VLLM" (liked); the "VL" prefix is
  // dropped for the public /playlist?list= URL by the extension.
  function parsePlaylist(r) {
    const browseId = r?.navigationEndpoint?.browseEndpoint?.browseId || "";
    if (!browseId) return null;
    const title = runsText(r.title);
    if (!title) return null;
    return {
      browseId,
      title,
      subtitle: runsText(r.subtitle),
      thumbnail: largestThumb(r?.thumbnailRenderer?.musicThumbnailRenderer),
    };
  }

  async function getPlaylists() {
    const it = api().innertube;
    if (typeof it !== "function") return { ok: false, error: "search module not loaded" };
    let json;
    try {
      json = await it("browse", { browseId: "FEmusic_liked_playlists" });
    } catch (e) {
      return { ok: false, error: "library browse failed: " + (e && e.message) };
    }
    const out = [];
    const seen = new Set();
    for (const r of collectByKey(json, "musicTwoRowItemRenderer")) {
      const p = parsePlaylist(r);
      if (p && !seen.has(p.browseId)) {
        seen.add(p.browseId);
        out.push(p);
      }
    }
    LOG("get_playlists →", out.length, "playlist(s)");
    return { ok: true, playlists: out };
  }

  // --- Playlist tracks (drill-in) -------------------------------------------

  // The playlist page title, for the drill-in header. Lives in a header
  // renderer whose exact key has changed across builds — try the known ones.
  function playlistTitle(json) {
    for (const key of ["musicResponsiveHeaderRenderer", "musicDetailHeaderRenderer", "musicEditablePlaylistDetailHeaderRenderer"]) {
      for (const h of collectByKey(json, key)) {
        const t = runsText(h && h.title);
        if (t) return t;
      }
    }
    return "";
  }

  // Cap on how many tracks we return for one playlist. YTM paginates the
  // tracklist via continuation tokens; we follow them up to this many tracks.
  const PLAYLIST_TRACK_CAP = 300;

  // The tracklist and its paging token live in the SAME container — the playlist
  // shelf (initial browse) or its continuation (paged fetch). We must read the
  // token from that container, not from anywhere in the response: other sections
  // (suggestions, header menus) carry their own unrelated continuationCommands,
  // and following one of those fetches the wrong list and stalls paging.

  // Container keys that hold a page of the tracklist. `contents` is the initial
  // shelf / old-style continuation; `continuationItems` is the new append form.
  const TRACKLIST_KEYS = ["musicPlaylistShelfRenderer", "musicPlaylistShelfContinuation", "appendContinuationItemsAction"];

  // The paging token belonging to one tracklist container. New builds append a
  // trailing continuationItemRenderer carrying a continuationCommand (endpoint
  // possibly wrapped in a commandExecutorCommand — search the small subtree so
  // wrapper shape doesn't matter); old builds hang a nextContinuationData off
  // the container. Returns "" when this container has no further page.
  function tokenFromContainer(c) {
    const items = (c && c.contents) || (c && c.continuationItems) || [];
    for (const it of items) {
      const cir = it && it.continuationItemRenderer;
      if (!cir) continue;
      for (const cc of collectByKey(cir, "continuationCommand")) {
        if (cc && cc.token) return cc.token;
      }
    }
    for (const nc of collectByKey(c && c.continuations, "nextContinuationData")) {
      if (nc && nc.continuation) return nc.continuation;
    }
    return "";
  }

  // Extract one page of the tracklist: its rows plus the token for the next page
  // (from the same container). Falls back to every list item if no known shelf
  // container is present. Returns { rows, token }.
  function tracklistPage(json) {
    let rows = [];
    let token = "";
    for (const key of TRACKLIST_KEYS) {
      for (const c of collectByKey(json, key)) {
        const items = (c && c.contents) || (c && c.continuationItems);
        if (!Array.isArray(items) || items.length === 0) continue;
        rows = rows.concat(items);
        if (!token) token = tokenFromContainer(c);
      }
    }
    if (rows.length === 0) {
      rows = collectByKey(json, "musicResponsiveListItemRenderer").map((r) => ({
        musicResponsiveListItemRenderer: r,
      }));
    }
    return { rows, token };
  }

  async function getPlaylistTracks(browseId) {
    const it = api().innertube;
    const parseRow = api().parseListItem;
    if (typeof it !== "function" || typeof parseRow !== "function") {
      return { ok: false, error: "search module not loaded" };
    }
    if (!browseId) return { ok: false, error: "no browseId" };
    let json;
    try {
      json = await it("browse", { browseId });
    } catch (e) {
      return { ok: false, error: "playlist browse failed: " + (e && e.message) };
    }

    const title = playlistTitle(json);
    const tracks = [];
    const collect = (rows) => {
      for (const row of rows) {
        const mrlir = row && row.musicResponsiveListItemRenderer;
        if (!mrlir) continue;
        const song = parseRow(mrlir);
        if (song && song.videoId) tracks.push(song);
        if (tracks.length >= PLAYLIST_TRACK_CAP) return;
      }
    };

    let page = tracklistPage(json);
    collect(page.rows);

    // Follow the tracklist's own continuation token until the playlist ends or
    // we hit the cap. `seen` guards a repeated token and the no-progress check
    // guards a page that adds nothing — either would otherwise spin forever.
    const seen = new Set();
    let token = page.token;
    while (token && !seen.has(token) && tracks.length < PLAYLIST_TRACK_CAP) {
      seen.add(token);
      const before = tracks.length;
      try {
        json = await it("browse", { continuation: token });
      } catch (e) {
        LOG("get_playlist_tracks continuation failed:", e && e.message);
        break;
      }
      page = tracklistPage(json);
      collect(page.rows);
      LOG("get_playlist_tracks page →", tracks.length, "track(s) so far");
      if (tracks.length === before) break;
      token = page.token;
    }

    LOG("get_playlist_tracks", browseId, "→", tracks.length, "track(s)");
    return { ok: true, title, tracks };
  }

  window.__ytmCompanion = window.__ytmCompanion || {};
  window.__ytmCompanion.getPlaylists = getPlaylists;
  window.__ytmCompanion.getPlaylistTracks = getPlaylistTracks;
})();
