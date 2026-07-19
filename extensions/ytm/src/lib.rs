//! Portunus YouTube Music extension.
//!
//! One scope command ("YouTube Music"): search songs, then Play now / Play
//! next / Add to queue / Open in browser. All search and playback control runs
//! through the Firefox companion (companions/firefox-ytm) over the extension
//! message bus - the companion drives the logged-in `music.youtube.com` tab
//! using its own session, so results are personalized and playback lands in
//! that tab. The companion is required; without it there is nothing to search
//! or play (only the album-art preview does its own HTTP fetch).
//!
//! The `search` tier returns a single "searching" placeholder so the list
//! isn't blank while the async `query` round-trip to the companion is in
//! flight.

// Bring `extism_pdk` into crate-root scope for the `#[plugin_fn]` expansion.
use portunus_ext_sdk::guest::extism_pdk;
use portunus_ext_sdk::guest::extism_pdk::{http, HttpRequest};
use portunus_ext_sdk::guest::{self, plugin_fn, FnResult, Json};
use portunus_ext_sdk::{
    Action, ActivateEffect, ActivateInput, ActivateOutput, ExtensionResult, PreviewContent,
    PreviewInput, QueryInput, QueryOutput, SearchInput, SearchOutput, ToastLevel,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const ICON_B64: &str = include_str!("../icon.b64");
/// How long to wait on the companion for a search / an action.
const SEARCH_TIMEOUT_MS: u64 = 8000;
const ACTION_TIMEOUT_MS: u64 = 5000;
/// Cap on parsed songs.
const MAX_SONGS: usize = 15;

fn icon() -> portunus_ext_sdk::ResultIcon {
    portunus_ext_sdk::ResultIcon { mime: "image/png".into(), data_base64: ICON_B64.trim().into() }
}

/// A parsed song row from the companion. `video_id` is the watch id.
struct Song {
    video_id: String,
    title: String,
    artist: String,
    album: String,
    duration: Option<String>,
    /// Album-art URL (largest available). Fetched lazily in `preview`.
    thumb_url: Option<String>,
}

/// Compact per-result payload packed into the launcher result `id` (which the
/// host passes back verbatim on activate/preview). Lets `preview` render art +
/// metadata and `activate` recover the watch id, without persisting state.
#[derive(Serialize, Deserialize, Default)]
struct SongMeta {
    /// video id
    v: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    a: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    al: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    d: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    t: Option<String>,
    /// Queue position (queue command only). Carried so activate can skip_to /
    /// remove_from_queue by index; absent on search rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    i: Option<usize>,
}

impl Song {
    fn meta(&self) -> SongMeta {
        SongMeta {
            v: self.video_id.clone(),
            a: self.artist.clone(),
            al: self.album.clone(),
            d: self.duration.clone(),
            t: self.thumb_url.clone(),
            i: None,
        }
    }
}

/// Decodes a `song:<json>` (search) or `qitem:<json>` (queue) result id back
/// into its metadata. Both pack the same `SongMeta`.
fn decode_meta(id: &str) -> Option<SongMeta> {
    let json = id.strip_prefix("song:").or_else(|| id.strip_prefix("qitem:"))?;
    serde_json::from_str(json).ok()
}

/// The action menu shown on every song row. First = default (Enter).
fn song_actions() -> Vec<Action> {
    // play_next / queue_last keep the launcher open (KeepOpen) so you can
    // queue several tracks in a row. `opens_form` is set on them not because
    // they open a form, but because it makes the host skip the optimistic hide
    // - otherwise the window flashes hidden-then-shown around the KeepOpen.
    // `shortcut` is the suggested default chord - users can override or clear
    // it in Settings → Keybinds. The default (first) action is Enter-bound.
    vec![
        Action { id: "play_now".into(), label: "Play now".into(), hint: Some("in YouTube Music".into()), opens_form: false, shortcut: None },
        Action { id: "play_next".into(), label: "Play next".into(), hint: Some("after current track".into()), opens_form: true, shortcut: Some("ctrl+n".into()) },
        Action { id: "queue_last".into(), label: "Add to queue".into(), hint: Some("end of the queue".into()), opens_form: true, shortcut: Some("ctrl+q".into()) },
        Action { id: "open".into(), label: "Open in browser".into(), hint: None, opens_form: false, shortcut: Some("ctrl+o".into()) },
    ]
}

/// Maps a parsed song to a launcher result. `row_icon` is the resolved album
/// art (cache/fetch) or the generic icon - same treatment as queue rows.
fn song_result(s: &Song, relevance: f32, row_icon: portunus_ext_sdk::ResultIcon) -> ExtensionResult {
    // Row subtitle is artist only - same as queue rows. Album still shows in
    // the preview card.
    let subtitle = if s.artist.is_empty() { None } else { Some(s.artist.clone()) };
    ExtensionResult {
        // Pack video id + metadata so activate/preview are self-contained.
        id: format!("song:{}", serde_json::to_string(&s.meta()).unwrap_or_default()),
        title: s.title.clone(),
        subtitle,
        relevance,
        actions: song_actions(),
        icon: Some(row_icon),
        badge: s.duration.clone(),
    }
}

/// Preserve YouTube's own result ordering: relevance decreases with source
/// index. The companion returns results in InnerTube's relevance order, far
/// better than any local re-scoring.
fn ranked(i: usize, n: usize) -> f32 {
    100.0 - (i as f32 / n.max(1) as f32) * 40.0
}

// ===========================================================================
// Queue command: a live view of the YouTube Music queue with skip-to / remove.
// ===========================================================================

/// One track in the current queue, as returned by the companion `get_queue`.
struct QueueRow {
    index: usize,
    video_id: String,
    title: String,
    artist: String,
    duration: Option<String>,
    thumb: Option<String>,
    current: bool,
}

/// The action menu on every queue row. First = default (Enter).
fn queue_actions() -> Vec<Action> {
    // skip_to / remove keep the launcher open (RefreshResults re-pulls the
    // queue so the "▶ Now playing" marker follows). `opens_form` is set to make
    // the host skip the optimistic hide - same trick as the search rows.
    vec![
        Action { id: "skip_to".into(), label: "Skip to".into(), hint: Some("play this track".into()), opens_form: true, shortcut: None },
        Action { id: "remove".into(), label: "Remove from queue".into(), hint: None, opens_form: true, shortcut: Some("ctrl+d".into()) },
        Action { id: "open".into(), label: "Open in browser".into(), hint: None, opens_form: false, shortcut: Some("ctrl+o".into()) },
    ]
}

/// Maps a queue row to a launcher result. The now-playing track floats to the
/// top with a badge; the rest keep queue order via descending relevance.
///
/// The id is stable (position + metadata), which the launcher needs so a
/// RefreshResults after skip/remove updates rows in place instead of stacking
/// duplicates. The queue command sets `frecency = false` in the manifest, so
/// these stable ids never accrue a usage-history bonus that would reorder the
/// list - the two go together.
fn queue_result(r: &QueueRow, n: usize, row_icon: portunus_ext_sdk::ResultIcon) -> ExtensionResult {
    let meta = SongMeta {
        v: r.video_id.clone(),
        a: r.artist.clone(),
        al: String::new(),
        d: r.duration.clone(),
        t: r.thumb.clone(),
        i: Some(r.index),
    };
    let relevance =
        if r.current { 100.0 } else { 99.0 - (r.index as f32 / n.max(1) as f32) * 90.0 };
    let badge = if r.current { Some("\u{25B6} Now playing".into()) } else { r.duration.clone() };
    ExtensionResult {
        id: format!("qitem:{}", serde_json::to_string(&meta).unwrap_or_default()),
        title: r.title.clone(),
        subtitle: if r.artist.is_empty() { None } else { Some(r.artist.clone()) },
        relevance,
        actions: queue_actions(),
        icon: Some(row_icon),
        badge,
    }
}

/// Per-query cap on *new* album-art fetches. Cache hits are unlimited; misses
/// beyond this fall back to the generic icon and warm on a later open. Keeps
/// the query snappy on a cold cache (each fetch is a blocking HTTP round-trip).
const ART_FETCH_BUDGET: usize = 16;

/// Album art from the KV cache, or None if not cached yet. No network.
fn cached_icon(video_id: &str) -> Option<portunus_ext_sdk::ResultIcon> {
    if video_id.is_empty() {
        return None;
    }
    let v = guest::kv_read(&format!("art:{video_id}")).ok()??;
    let (mime, b64) = v.split_once('\t')?;
    Some(portunus_ext_sdk::ResultIcon { mime: mime.into(), data_base64: b64.into() })
}

/// Resolves a queue row's icon: KV cache first, then a bounded live fetch of a
/// downsized thumbnail (cached for next time), else the generic YTM icon.
fn row_icon(video_id: &str, thumb: Option<&str>, budget: &mut usize) -> portunus_ext_sdk::ResultIcon {
    if let Some(ic) = cached_icon(video_id) {
        return ic;
    }
    if *budget == 0 || video_id.is_empty() {
        return icon();
    }
    if let Some(url) = thumb.filter(|s| !s.is_empty()) {
        if let Some((mime, b64)) = fetch_icon_b64(&small_thumb_url(url, 48)) {
            *budget -= 1;
            let _ = guest::kv_write(&format!("art:{video_id}"), &format!("{mime}\t{b64}"));
            return portunus_ext_sdk::ResultIcon { mime, data_base64: b64 };
        }
    }
    icon()
}

/// Rewrites an art URL to a small, fast-to-fetch variant, per host:
/// - `i.ytimg.com/vi/<id>/<q>.jpg?...` (queue thumbs) -> `.../default.jpg`
///   (120x90, no signed query params).
/// - `*.googleusercontent.com/...=w..-h..` (search art) -> a `px` square.
/// Both stay well under the 32 KB icon cap. Unknown shapes pass through.
fn small_thumb_url(url: &str, px: u32) -> String {
    if url.contains("ytimg.com") {
        // Drop the filename + query and use the small unsigned `default.jpg`.
        if let Some(slash) = url.rfind('/') {
            return format!("{}/default.jpg", &url[..slash]);
        }
        return url.to_string();
    }
    // googleusercontent carries a `=w..-h..` size suffix.
    match url.rfind('=') {
        Some(eq) => format!("{}=w{px}-h{px}-l90-rj", &url[..eq]),
        None => format!("{url}=w{px}-h{px}"),
    }
}

/// Fetches an image and returns `(mime, base64)`, or None on any failure. Skips
/// anything that would exceed the icon cap once base64-expanded.
fn fetch_icon_b64(url: &str) -> Option<(String, String)> {
    let mut req = HttpRequest::new(url.to_string());
    req.method = Some("GET".into());
    let resp = http::request::<&[u8]>(&req, None).ok()?;
    if resp.status_code() != 200 {
        return None;
    }
    let bytes = resp.body();
    // 20 KB raw -> ~27 KB base64, safely under the 32 KB cap.
    if bytes.is_empty() || bytes.len() > 20 * 1024 {
        return None;
    }
    let mime = if url.contains(".png") {
        "image/png"
    } else if url.contains(".webp") {
        "image/webp"
    } else {
        "image/jpeg"
    };
    Some((mime.to_string(), base64_encode(&bytes)))
}

/// Asks the companion for the current queue. Reply shape: `{ "ok": true,
/// "items": [{ "videoId", "title", "artist", "duration", "thumbnail",
/// "index", "current" }], "selectedIndex" }`.
fn companion_get_queue() -> Result<Vec<QueueRow>, String> {
    let reply = guest::bus_call(json!({ "op": "get_queue" }), ACTION_TIMEOUT_MS)
        .map_err(|e| e.to_string())?;
    if !reply.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let msg = reply.get("error").and_then(Value::as_str).unwrap_or("companion error");
        return Err(msg.to_string());
    }
    let items = reply.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut rows = Vec::new();
    for (i, it) in items.iter().enumerate() {
        let title = it.get("title").and_then(Value::as_str).unwrap_or("").to_string();
        if title.is_empty() {
            continue;
        }
        let index = it.get("index").and_then(Value::as_u64).map(|n| n as usize).unwrap_or(i);
        rows.push(QueueRow {
            index,
            video_id: it.get("videoId").and_then(Value::as_str).unwrap_or("").to_string(),
            title,
            artist: it.get("artist").and_then(Value::as_str).unwrap_or("").to_string(),
            duration: it.get("duration").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string),
            thumb: it.get("thumbnail").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string),
            current: it.get("current").and_then(Value::as_bool).unwrap_or(false),
        });
    }
    Ok(rows)
}

/// Emits queue rows. Pass 1 uses only cached art (already-cached rows show real
/// art immediately, uncached rows fall back to the generic icon) - so a warm
/// requery never flashes generic-then-art. Pass 2 runs only when some row's art
/// wasn't cached: it fetches the misses (bounded) and re-emits the same ids so
/// art fills in. Cold first open: list is instant, art streams in; warm
/// requery: a single emit, no flicker.
fn emit_queue(rows: &[QueueRow], term: &str) {
    let t = term.trim().to_lowercase();
    let n = rows.len();

    let visible: Vec<&QueueRow> = rows
        .iter()
        .filter(|r| {
            t.is_empty()
                || r.title.to_lowercase().contains(&t)
                || r.artist.to_lowercase().contains(&t)
        })
        .collect();
    if visible.is_empty() {
        emit_message("No matching tracks", "Nothing in the queue matches that");
        return;
    }

    // Pass 1: cached art only (no network). Track whether any row still needs a
    // fetch (has a thumbnail but no cache entry yet).
    let mut any_miss = false;
    let first: Vec<ExtensionResult> = visible
        .iter()
        .map(|r| {
            let ic = cached_icon(&r.video_id).unwrap_or_else(|| {
                if !r.video_id.is_empty() && r.thumb.as_deref().is_some_and(|s| !s.is_empty()) {
                    any_miss = true;
                }
                icon()
            });
            queue_result(r, n, ic)
        })
        .collect();
    let _ = guest::emit(first);

    // Warm cache (nothing to fetch): single emit, no flash.
    if !any_miss {
        return;
    }

    // Pass 2: fetch the misses (bounded) and re-emit with art. Same ids, so
    // the newly-fetched rows update in place.
    let mut budget = ART_FETCH_BUDGET;
    let with_art: Vec<ExtensionResult> = visible
        .iter()
        .map(|r| {
            let ic = row_icon(&r.video_id, r.thumb.as_deref(), &mut budget);
            queue_result(r, n, ic)
        })
        .collect();
    let _ = guest::emit(with_art);
}

// ===========================================================================
// search: instant tier. No cache - just a placeholder while `query` runs.
// ===========================================================================

#[plugin_fn]
pub fn search(input: Json<SearchInput>) -> FnResult<Json<SearchOutput>> {
    // The queue command (min_query_len = 0) has no instant tier - the async
    // `query` round-trip populates it. Returning nothing here avoids a stray
    // placeholder row lingering among the real queue results.
    if input.0.command == "queue" {
        return Ok(Json(SearchOutput::default()));
    }

    let term = input.0.query.trim();
    if term.is_empty() {
        return Ok(Json(SearchOutput::default()));
    }
    Ok(Json(SearchOutput {
        results: vec![ExtensionResult {
            id: format!("searching:{term}"),
            title: format!("Search YouTube Music for \u{201c}{term}\u{201d}\u{2026}"),
            subtitle: Some("Press Enter to open the web search".into()),
            relevance: 50.0,
            actions: Vec::new(),
            icon: Some(icon()),
            badge: None,
        }],
    }))
}

// ===========================================================================
// query: async tier. The companion runs the search inside the logged-in tab.
// ===========================================================================

#[plugin_fn]
pub fn query(input: Json<QueryInput>) -> FnResult<Json<QueryOutput>> {
    let term = input.0.query.trim().to_string();

    // Queue command: pull the live queue (any typed term filters it client-side).
    if input.0.command == "queue" {
        match companion_get_queue() {
            Ok(rows) if !rows.is_empty() => emit_queue(&rows, &term),
            Ok(_) => emit_message("Queue is empty", "Play something in YouTube Music"),
            Err(e) => {
                let _ = guest::debug(&format!("get_queue failed: {e}"));
                emit_message(
                    "Firefox companion not connected",
                    "Open music.youtube.com and load the companion add-on",
                );
            }
        }
        return Ok(Json(QueryOutput::default()));
    }

    if term.is_empty() {
        return Ok(Json(QueryOutput::default()));
    }

    match companion_search(&term) {
        Ok(songs) if !songs.is_empty() => emit_songs(&songs),
        Ok(_) => emit_message("No songs found", "Try a different search"),
        Err(e) => {
            let _ = guest::debug(&format!("companion search failed: {e}"));
            emit_message(
                "Firefox companion not connected",
                "Open music.youtube.com and load the companion add-on",
            );
        }
    }
    Ok(Json(QueryOutput::default()))
}

/// Emits a single informational row (no actions).
fn emit_message(title: &str, subtitle: &str) {
    let _ = guest::emit(vec![ExtensionResult {
        id: "msg".into(),
        title: title.into(),
        subtitle: Some(subtitle.into()),
        relevance: 50.0,
        actions: Vec::new(),
        icon: Some(icon()),
        badge: None,
    }]);
}

/// Default search-row cap when the setting is unset.
const DEFAULT_MAX_RESULTS: usize = 5;

/// Max search rows to show, from the "Search results per query" range setting
/// (clamped to 1..=MAX_SONGS). Fewer rows = fewer album-art fetches, so this
/// doubles as the performance knob.
fn max_results() -> usize {
    guest::setting_num("max_results")
        .ok()
        .flatten()
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, MAX_SONGS)
}

/// Emits search rows with album-art thumbnails, mirroring [`emit_queue`]: pass 1
/// uses only cached art (no network, no flicker on a warm requery); pass 2 runs
/// only if some row's art wasn't cached, fetching the misses (bounded) and
/// re-emitting the same ids so art fills in.
fn emit_songs(songs: &[Song]) {
    let songs = &songs[..songs.len().min(max_results())];
    let n = songs.len();

    // Pass 1: cached art only.
    let mut any_miss = false;
    let first: Vec<ExtensionResult> = songs
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let ic = cached_icon(&s.video_id).unwrap_or_else(|| {
                if !s.video_id.is_empty() && s.thumb_url.as_deref().is_some_and(|u| !u.is_empty()) {
                    any_miss = true;
                }
                icon()
            });
            song_result(s, ranked(i, n), ic)
        })
        .collect();
    let _ = guest::emit(first);

    // Warm cache: single emit, no flash.
    if !any_miss {
        return;
    }

    // Pass 2: fetch the misses (bounded), re-emit with art (same ids).
    let mut budget = ART_FETCH_BUDGET;
    let with_art: Vec<ExtensionResult> = songs
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let ic = row_icon(&s.video_id, s.thumb_url.as_deref(), &mut budget);
            song_result(s, ranked(i, n), ic)
        })
        .collect();
    let _ = guest::emit(with_art);
}

/// Ask the companion to search. Reply shape: `{ "ok": true, "results": [
/// { "videoId", "title", "artist", "album", "duration", "thumbnail" } ] }`.
fn companion_search(term: &str) -> Result<Vec<Song>, String> {
    let reply = guest::bus_call(json!({ "op": "search", "q": term }), SEARCH_TIMEOUT_MS)
        .map_err(|e| e.to_string())?;
    if !reply.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let msg = reply.get("error").and_then(Value::as_str).unwrap_or("companion error");
        return Err(msg.to_string());
    }
    let items = reply.get("results").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut songs = Vec::new();
    for it in items.iter().take(MAX_SONGS) {
        let Some(video_id) = it.get("videoId").and_then(Value::as_str).filter(|s| !s.is_empty())
        else {
            continue;
        };
        let title = it.get("title").and_then(Value::as_str).unwrap_or("").to_string();
        if title.is_empty() {
            continue;
        }
        let artist = it.get("artist").and_then(Value::as_str).unwrap_or("").to_string();
        let album = it.get("album").and_then(Value::as_str).unwrap_or("").to_string();
        let duration =
            it.get("duration").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
        let thumb_url =
            it.get("thumbnail").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
        songs.push(Song { video_id: video_id.to_string(), title, artist, album, duration, thumb_url });
    }
    Ok(songs)
}

// ===========================================================================
// activate: companion action, or a browser open for "Open in browser".
// ===========================================================================

#[plugin_fn]
pub fn activate(input: Json<ActivateInput>) -> FnResult<Json<ActivateOutput>> {
    let id = input.0.result.id.as_str();
    let action = input.0.action.as_deref().unwrap_or("play_now");

    // The "searching…" placeholder: open the web search.
    if let Some(term) = id.strip_prefix("searching:") {
        return Ok(Json(ActivateOutput::open(format!(
            "https://music.youtube.com/search?q={}",
            urlencode(term)
        ))));
    }

    // Queue rows: skip_to / remove by index, or open in browser.
    if id.starts_with("qitem:") {
        return Ok(Json(activate_queue(id, action)));
    }

    let Some(video_id) = decode_meta(id).map(|m| m.v).filter(|v| !v.is_empty()) else {
        return Ok(Json(ActivateOutput::default()));
    };

    // "Open in browser" is a plain open (an explicit choice, not a fallback).
    if action == "open" {
        return Ok(Json(ActivateOutput::open(format!(
            "https://music.youtube.com/watch?v={video_id}"
        ))));
    }

    // play_now / play_next / queue_last → the companion.
    let op = match action {
        "play_next" => "queue_next",
        "queue_last" => "queue_last",
        _ => "play_now",
    };
    match guest::bus_call(json!({ "op": op, "videoId": video_id }), ACTION_TIMEOUT_MS) {
        Ok(reply) if reply.get("ok").and_then(Value::as_bool).unwrap_or(false) => {
            let (msg, keep_open) = match op {
                "queue_next" => ("Queued next", true),
                "queue_last" => ("Added to queue", true),
                _ => ("Playing", false),
            };
            let effect =
                if keep_open { ActivateEffect::KeepOpen {} } else { ActivateEffect::Hide {} };
            Ok(Json(ActivateOutput::toast(msg, ToastLevel::Success).and(effect)))
        }
        Ok(reply) => {
            let err =
                reply.get("error").and_then(Value::as_str).unwrap_or("companion refused the action");
            let _ = guest::debug(&format!("{op} failed: {err}"));
            Ok(Json(ActivateOutput::toast(
                format!("Couldn't {}: {err}", human_op(op)),
                ToastLevel::Error,
            )))
        }
        Err(e) => {
            let _ = guest::debug(&format!("{op} bus error: {e}"));
            Ok(Json(ActivateOutput::toast("Firefox companion not connected", ToastLevel::Error)))
        }
    }
}

fn human_op(op: &str) -> &'static str {
    match op {
        "queue_next" => "play next",
        "queue_last" => "add to queue",
        _ => "play",
    }
}

/// Handles activation of a queue row: skip_to / remove_from_queue by index, or
/// "Open in browser". Both mutations refresh the list so the marker follows.
fn activate_queue(id: &str, action: &str) -> ActivateOutput {
    let Some(meta) = decode_meta(id) else {
        return ActivateOutput::default();
    };

    if action == "open" {
        if meta.v.is_empty() {
            return ActivateOutput::default();
        }
        return ActivateOutput::open(format!("https://music.youtube.com/watch?v={}", meta.v));
    }

    let Some(index) = meta.i else {
        return ActivateOutput::toast("Missing queue position", ToastLevel::Error);
    };
    let (op, verb) = match action {
        "remove" => ("remove_from_queue", "remove"),
        _ => ("skip_to", "skip"),
    };
    match guest::bus_call(json!({ "op": op, "index": index }), ACTION_TIMEOUT_MS) {
        Ok(reply) if reply.get("ok").and_then(Value::as_bool).unwrap_or(false) => {
            let msg = if op == "remove_from_queue" { "Removed from queue" } else { "Skipping" };
            // KeepOpen so the launcher stays up (browse/skip several in a row);
            // RefreshResults re-pulls the queue so the marker/membership updates.
            ActivateOutput::toast(msg, ToastLevel::Success)
                .and(ActivateEffect::RefreshResults {})
                .and(ActivateEffect::KeepOpen {})
        }
        Ok(reply) => {
            let err =
                reply.get("error").and_then(Value::as_str).unwrap_or("companion refused the action");
            let _ = guest::debug(&format!("{op} failed: {err}"));
            ActivateOutput::toast(format!("Couldn't {verb}: {err}"), ToastLevel::Error)
        }
        Err(e) => {
            let _ = guest::debug(&format!("{op} bus error: {e}"));
            ActivateOutput::toast("Firefox companion not connected", ToastLevel::Error)
        }
    }
}

// ===========================================================================
// preview: album-art + metadata card, built from the packed result id. The
// cover is fetched once on selection (not per keystroke); any failure degrades
// to a metadata-only card, never an error.
// ===========================================================================

#[plugin_fn]
pub fn preview(input: Json<PreviewInput>) -> FnResult<Json<PreviewContent>> {
    let result = input.0.result;
    let Some(meta) = decode_meta(&result.id) else {
        return Ok(Json(PreviewContent::Metadata { items: vec![] }));
    };

    let art = meta.t.as_deref().and_then(fetch_thumb_data_uri);

    let mut html = String::from(r#"<div class="col" style="gap:14px;padding:16px;align-items:center">"#);
    if let Some(uri) = &art {
        html.push_str(&format!(
            r#"<img src="{uri}" alt="" style="width:200px;height:200px;border-radius:8px;object-fit:cover">"#,
        ));
    }
    html.push_str(r#"<div class="col" style="gap:4px;width:100%">"#);
    html.push_str(&format!(
        r#"<div style="font-size:15px;font-weight:600;text-align:center;margin-bottom:6px">{}</div>"#,
        html_escape(&result.title),
    ));
    meta_row(&mut html, "Artist", &meta.a);
    meta_row(&mut html, "Album", &meta.al);
    if let Some(d) = &meta.d {
        meta_row(&mut html, "Duration", d);
    }
    html.push_str("</div></div>");

    Ok(Json(PreviewContent::Html { content: html }))
}

/// One label/value line in the preview card. Skips empty values.
fn meta_row(out: &mut String, label: &str, value: &str) {
    if value.trim().is_empty() {
        return;
    }
    out.push_str(&format!(
        r#"<div class="row" style="gap:0;align-items:baseline;padding:2px 0"><span class="text-label" style="width:72px;flex-shrink:0">{}</span><span style="font-size:13px">{}</span></div>"#,
        html_escape(label),
        html_escape(value),
    ));
}

/// Fetches album art and returns a `data:` URI, or None on any failure. Skips
/// oversized images to stay well under the 128 KB Html-preview cap.
fn fetch_thumb_data_uri(url: &str) -> Option<String> {
    let mut req = HttpRequest::new(url.to_string());
    req.method = Some("GET".into());
    let resp = http::request::<&[u8]>(&req, None).ok()?;
    if resp.status_code() != 200 {
        return None;
    }
    let bytes = resp.body();
    if bytes.is_empty() || bytes.len() > 96 * 1024 {
        return None;
    }
    let mime = if url.contains(".png") {
        "image/png"
    } else if url.contains(".webp") {
        "image/webp"
    } else {
        "image/jpeg"
    };
    Some(format!("data:{};base64,{}", mime, base64_encode(&bytes)))
}

/// Minimal standard base64 (no dependency) for embedding art as a `data:` URI.
fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// Escapes text for safe interpolation into the preview HTML.
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Percent-encode for a `?q=` query string.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
