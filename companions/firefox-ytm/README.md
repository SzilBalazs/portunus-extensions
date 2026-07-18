# Portunus YTM companion (Firefox)

Bridges the Portunus [`ytm`](../../extensions/ytm) extension to your logged-in
`music.youtube.com` tab. It gives the extension:

- **personalized search** — run inside your session (your library, mixes), and
- **playback control** — play now, play next, add to queue — by driving the
  tab's own YouTube Music app.

The companion is required: it runs both search and playback in your tab. Without
it the extension has nothing to query or control (it only shows a "companion not
connected" hint). The album-art preview is the sole part that fetches on its own.

## How it fits together

```
Portunus ytm ext ──bus──▶ portunus native-host ytm ──stdio──▶ this add-on ──▶ music.youtube.com tab
        (wasm, sandboxed)      (relay shim)                 (background.js)      (content scripts)
```

The add-on speaks Firefox **native messaging** to a small relay
(`portunus native-host ytm`) that Portunus ships; the relay forwards messages
to/from the extension's message bus. You register that relay once (below).

## Install (temporary add-on)

1. **Load the add-on**: open `about:debugging#/runtime/this-firefox` →
   **Load Temporary Add-on…** → select this folder's `manifest.json`.

2. **Register the native-messaging bridge** so Firefox is allowed to launch the
   relay and reach Portunus:

   ```bash
   portunus native-host install ytm --ff-ext-id ytm-portunus@example.org
   ```

   `ytm-portunus@example.org` is this add-on's id
   (`browser_specific_settings.gecko.id` in `manifest.json`). If you change the
   id, pass the new one to `--ff-ext-id`. The command writes
   `~/.mozilla/native-messaging-hosts/portunus_ytm.json` and a wrapper script.

3. **Reload the add-on** (the reload button in `about:debugging`) so it
   reconnects to the freshly-registered host.

4. Open **music.youtube.com** and stay logged in. In Portunus, type `ytm` and
   search — results should stream in, and Enter plays in the tab.

> Temporary add-ons vanish when Firefox restarts. Re-do steps 1 and 3 each
> session (the native-host registration from step 2 persists). A signed build
> for permanent install is not published yet.

## Troubleshooting

- **No results / "companion not connected"**: check the add-on's console in
  `about:debugging` → *Inspect*. A `connectNative` error usually means step 2
  didn't run, the `--ff-ext-id` doesn't match the add-on id, or Portunus isn't
  running (the relay connects to Portunus's socket).
- **Search works, playback actions fail**: the queue/play code
  (`content/actions.js` + `content/page-bridge.js`) drives YouTube Music's
  reverse-engineered internals and may need updating after a YT Music change —
  the error toast names the failing step. Search (`content/search.js`) uses a
  sturdier InnerTube path and should keep working even when playback breaks.
- **Wrong tab controlled**: the companion prefers an audible tab, then the most
  recently used `music.youtube.com` tab. Keep a single YouTube Music tab for
  predictable behaviour.

## Files

| File | Role |
|---|---|
| `background.js` | native-messaging relay ↔ content script; tab selection |
| `content/router.js` | dispatches bus ops to the handlers below |
| `content/search.js` | **sturdy** — authenticated InnerTube search |
| `content/actions.js` | content-script half of the queue/play RPC |
| `content/page-bridge.js` | **fragile** — page-context YT Music internals |
