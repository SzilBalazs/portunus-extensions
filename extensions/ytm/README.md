# YouTube Music

Search YouTube Music from Portunus and control playback — **play now**, **play
next**, **add to queue**, or open a track in the browser.

Requires **Portunus with SDK ≥ v0.4.0** (the extension message bus). Older
builds reject the extension at install with a version error.

## What works with and without the companion

Playback control drives a logged-in `music.youtube.com` tab through a small
Firefox companion (in [`companions/firefox-ytm`](../../companions/firefox-ytm)).
The extension degrades gracefully:

| | companion connected | no companion |
|---|---|---|
| Search | personalized (your library, recommendations) | public catalog (unauthenticated) |
| Play now | plays in the tab | opens the track in your browser |
| Play next / Add to queue | inserts into the tab's queue | unavailable (an error toast tells you) |
| Open in browser | always opens the watch page | same |

## Install

1. Install this extension from the marketplace (**Browse Extension
   Marketplace** → *YouTube Music* → Enter). It asks for the **companion
   channel** permission — the extension itself stays sandboxed, but it
   exchanges messages with the Firefox companion, which runs unsandboxed.

2. Load the Firefox companion (temporary add-on — see its
   [README](../../companions/firefox-ytm/README.md)):
   `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick
   `companions/firefox-ytm/manifest.json`.

3. Register the native-messaging bridge so Firefox can reach Portunus:

   ```bash
   portunus native-host install ytm --ff-ext-id ytm-portunus@example.org
   ```

   The `--ff-ext-id` must match the companion's `browser_specific_settings.gecko.id`.
   Reload the companion afterwards so it reconnects.

> Temporary add-ons are removed when Firefox restarts — reload it (steps 2–3
> stay valid) each session until a signed build is published.

## Build from source

```bash
cargo build --release            # -> target/wasm32-unknown-unknown/release/ytm.wasm
cp target/wasm32-unknown-unknown/release/ytm.wasm extension.wasm
portunus ext validate .
portunus ext dev .               # symlink + hot-reload while iterating
```

The `bus_attached` / `bus_call` API this extension uses ships in SDK v0.4.0.
Before that tag exists you can build against a local checkout:

```bash
cargo build --release --config \
  'patch."https://github.com/SzilBalazs/portunus".portunus-ext-sdk.path="../../../portunus/extension-sdk"'
```

## How search works

- **Companion path**: the companion runs the search inside your logged-in tab
  using the page's own InnerTube session, so results are personalized.
- **Fallback path**: a public, unauthenticated InnerTube search
  (`WEB_REMIX` client, Songs filter) — no API key, no quota, the same request
  `ytmusicapi` makes for anonymous search. Fallback rows are badged
  *"no companion"*.

The reverse-engineered queue/navigation logic lives entirely in the companion
(`content/actions.js`), isolated from search so a YouTube Music internals
change can't break lookup.
