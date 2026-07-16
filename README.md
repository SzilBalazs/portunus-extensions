# Portunus Extensions

The official extension marketplace for [Portunus](https://github.com/SzilBalazs/portunus).

Every extension here is built **from source** by CI, packed into a `.portext`,
and published — together with a static [`index.json`](https://szilbalazs.github.io/portunus-extensions/index.json) —
to GitHub Pages. Portunus fetches that index and shows the catalog in the
launcher: open **Browse Extension Marketplace**, pick an extension, review its
permissions in the preview panel, and press Enter — it installs and is
searchable within seconds.

## How trust works

- Extensions are submitted as **source code** (Rust compiled to wasm). What is
  reviewed in the PR is what CI builds and what users run — there are no
  opaque binary submissions.
- Each index entry carries the extension's full permission snapshot, the
  package sha256, and its size. The launcher shows the permissions **before**
  downloading anything; the client verifies the downloaded package against the
  index (sha pinned, permission list must not exceed the entry) before it lands.
- Extensions run in the Portunus wasm sandbox: no filesystem, no processes, no
  network beyond the manifest's exact-hostname allowlist. The `spawn`
  permission (running OS commands) is sandbox-breaking and requires an extra
  confirmation at install time.
- Published packages are immutable: `packages/<name>-<version>.portext` never
  changes once out. Any content change requires a version bump (CI enforces this).

## Repository layout

```
extensions/<name>/        source: Cargo.toml, src/, manifest.toml, *.b64 icons, README
scripts/generate_index.py packs extensions + generates index.json (run by CI)
.github/workflows/        validate.yml (PRs), publish.yml (main → Pages)
```

## Submitting an extension

See [CONTRIBUTING.md](CONTRIBUTING.md). Short version: scaffold with
`portunus ext new`, develop with `portunus ext dev`, then PR your source
directory into `extensions/<name>/`. CI builds, validates, and comments the
permission summary for review.

Extension authoring docs: [EXTENSIONS.md](https://github.com/SzilBalazs/portunus/blob/master/EXTENSIONS.md).
