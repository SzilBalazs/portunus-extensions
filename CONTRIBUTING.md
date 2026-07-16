# Submitting an extension

## Checklist

- [ ] Directory is `extensions/<name>/` and `name` in `manifest.toml` matches it.
- [ ] Source only: `Cargo.toml`, `src/`, `manifest.toml`, icon `.b64` assets,
      `README.md`. No `extension.wasm`, no `target/`, no `.portext` — CI builds
      from source; binaries in PRs are rejected.
- [ ] `portunus-ext-sdk` is pinned to a **released tag** of the Portunus repo
      (`git = "https://github.com/SzilBalazs/portunus", tag = "vX.Y.Z"`), not a
      branch or path.
- [ ] `.cargo/config.toml` sets `target = "wasm32-unknown-unknown"` so a plain
      `cargo build --release` produces the wasm.
- [ ] `portunus ext validate .` passes locally (after copying the built wasm to
      `extension.wasm`).
- [ ] Permissions are **minimal and justified**: every network host, every
      `spawn` command, and every secret setting must be explained in the PR
      description. Reviewers approve the grants, not just the code — the
      permission list becomes the consent surface users see in the launcher.
- [ ] Updating an existing extension: bump `version` in `manifest.toml`.
      Published packages are immutable; CI fails a PR that changes a published
      version's content without a bump.

## What CI does with your PR

1. Builds your extension from source (`wasm32-unknown-unknown`, pinned stable
   toolchain).
2. Runs `portunus ext validate` — the same manifest parser and wasm export
   scan the host uses at load time.
3. Packs a `.portext` to prove the archive is well-formed.
4. Checks the version-bump rule against the live index.
5. Comments a summary (name, version, api, permissions) for the reviewer.

On merge to `master`, `publish.yml` rebuilds everything, regenerates
`index.json`, and deploys the site atomically to GitHub Pages. Installed
copies pick the update up through the launcher's marketplace scope and the
Settings badge — no user action needed beyond one Enter.

## Review policy

- Network hosts must be exact FQDNs the extension actually needs (no wildcard
  hosts exist in the manifest format; don't ask for more hosts than used).
- `spawn` is sandbox-breaking and reviewed strictly: each command must be a
  specific tool (interpreters like `sh`/`python` are rejected by the host),
  and the PR must explain why a host effect (`copy_text`, `open_url`, `paste`)
  can't do the job.
- Secrets (`type = "secret"` settings) go to the system keyring, never to
  config files; pair them with the narrowest possible `network` list.
- Keep `search` fast (the host clamps it to ≤ 500 ms; the default budget is
  150 ms). Anything slow belongs in the async `query` export or a
  `[background]` refresh.

## Local testing against your own index

Point Portunus at a local index to test the full install flow before PRing:

```toml
# ~/.config/portunus/config.toml
[marketplace]
index_url = "file:///path/to/site/index.json"
```

Build the site locally (needs your extension's `extension.wasm` built):

```bash
python3 scripts/generate_index.py --site /tmp/mp-site --base-url file:///tmp/mp-site
```

Custom (non-default) index URLs may use `file://` for both the index and the
package `download_url`s — the official https-only rule is relaxed exactly for
this case.
