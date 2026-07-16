#!/usr/bin/env python3
"""Build the marketplace site: pack every extension and generate index.json.

For each extensions/<name>/ directory (which must contain a built
extension.wasm), packs a deterministic .portext zip into
<site>/packages/<name>-<version>.portext and emits an index entry whose
`permissions` block mirrors Portunus's ConsentPermissions shape exactly - the
index entry is the user's consent surface, so it must match what the host
snapshots from the manifest at install time.

Immutability: a published (name, version) is frozen. When --live-url is given,
any entry whose (name, version) already exists in the live index reuses the
*published* package bytes and sha256 instead of the fresh build (wasm builds
are not guaranteed bit-reproducible across toolchain updates). Changing an
extension's content therefore requires a version bump - validate.yml enforces
that on PRs.

Usage:
  generate_index.py --site site --base-url https://<org>.github.io/portunus-extensions \
                    [--live-url https://<org>.github.io/portunus-extensions/index.json]
"""

import argparse
import hashlib
import json
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11
    sys.exit("generate_index.py needs Python 3.11+ (tomllib)")

SCHEMA = 1
MAX_ICON_BYTES = 8 * 1024  # data-URI length cap enforced by the host
# Mirrors install.rs is_junk(): development files that never belong in a
# runtime archive. manifest.toml is explicitly kept.
JUNK = {"target", "src", ".cargo", ".git", ".gitignore", "Cargo.toml", "Cargo.lock"}
# Fixed timestamp so packing the same bytes yields the same archive sha256.
EPOCH = (2020, 1, 1, 0, 0, 0)


def pack(ext_dir: Path, out_path: Path) -> None:
    """Deterministic equivalent of `portunus ext pack`: manifest + wasm entry +
    top-level assets, sorted names, fixed timestamps, Deflate."""
    files = sorted(
        p for p in ext_dir.iterdir()
        if p.is_file()
        and not (p.name in JUNK and p.name != "manifest.toml")
        and not p.name.endswith(".portext")
        and not p.name.startswith(".")
    )
    if not any(p.name == "manifest.toml" for p in files):
        raise RuntimeError(f"{ext_dir}: manifest.toml missing")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        for p in files:
            info = zipfile.ZipInfo(p.name, date_time=EPOCH)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, p.read_bytes())


def consent_permissions(manifest: dict) -> dict:
    """Exactly the shape of install.rs ConsentPermissions (sorted lists,
    has_secrets derived from secret-type settings)."""
    perms = manifest.get("permissions", {})
    return {
        "network": sorted(perms.get("network", [])),
        "kv": bool(perms.get("kv", False)),
        "clipboard": bool(perms.get("clipboard", False)),
        "open_url": bool(perms.get("open_url", False)),
        "paste": bool(perms.get("paste", False)),
        "spawn": sorted(perms.get("spawn", [])),
        "has_secrets": any(s.get("type") == "secret" for s in manifest.get("settings", [])),
    }


def icon_data_uri(ext_dir: Path, manifest: dict) -> str | None:
    """First command icon (a .b64 asset holding raw base64 PNG), falling back
    to a root icon.b64. Skipped entirely when over the host's size cap."""
    candidates = [c["icon"] for c in manifest.get("commands", []) if c.get("icon")]
    candidates.append("icon.b64")
    for name in candidates:
        p = ext_dir / name
        if not p.is_file():
            continue
        b64 = p.read_text().strip()
        uri = f"data:image/png;base64,{b64}"
        if len(uri) > MAX_ICON_BYTES:
            print(f"  {ext_dir.name}: icon {name} over {MAX_ICON_BYTES}B cap - skipped")
            return None
        return uri
    return None


def fetch_live_index(url: str) -> dict | None:
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            return json.load(resp)
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError) as e:
        print(f"live index unavailable ({e}) - publishing fresh")
        return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True, help="output dir (deployed to Pages)")
    ap.add_argument("--base-url", required=True, help="public URL the site is served from")
    ap.add_argument("--live-url", help="currently published index.json, for immutability reuse")
    args = ap.parse_args()

    root = Path(__file__).resolve().parent.parent
    site = Path(args.site)
    base = args.base_url.rstrip("/")
    live = fetch_live_index(args.live_url) if args.live_url else None
    live_entries = {(e["name"], e["version"]): e for e in (live or {}).get("extensions", [])}

    entries = []
    for ext_dir in sorted((root / "extensions").iterdir()):
        if not ext_dir.is_dir():
            continue
        manifest = tomllib.loads((ext_dir / "manifest.toml").read_text())
        name, version = manifest["name"], manifest["version"]
        if name != ext_dir.name:
            raise RuntimeError(f"{ext_dir.name}: manifest name is {name!r}")
        pkg_name = f"{name}-{version}.portext"
        pkg_path = site / "packages" / pkg_name

        published = live_entries.get((name, version))
        if published:
            # Frozen version: reuse the exact published bytes so the sha in the
            # index always matches the package users download.
            pkg_path.parent.mkdir(parents=True, exist_ok=True)
            with urllib.request.urlopen(published["download_url"], timeout=60) as resp:
                pkg_path.write_bytes(resp.read())
            sha = hashlib.sha256(pkg_path.read_bytes()).hexdigest()
            if sha != published["sha256"]:
                raise RuntimeError(f"{name}: published package sha mismatch - refusing to publish")
            print(f"  {name} v{version}: reused published package")
        else:
            entry_wasm = ext_dir / manifest.get("entry", "extension.wasm")
            if not entry_wasm.is_file():
                raise RuntimeError(f"{name}: {entry_wasm.name} missing - build it first")
            pack(ext_dir, pkg_path)
            sha = hashlib.sha256(pkg_path.read_bytes()).hexdigest()
            print(f"  {name} v{version}: packed ({pkg_path.stat().st_size} B)")

        entries.append({
            "name": name,
            "version": version,
            "api": manifest["api"],
            "description": manifest.get("description", ""),
            "author": manifest.get("author", ""),
            "homepage": manifest.get("homepage", ""),
            "keywords": sorted({k for c in manifest.get("commands", []) for k in c.get("keywords", [])}),
            "permissions": consent_permissions(manifest),
            "download_url": f"{base}/packages/{pkg_name}",
            "sha256": sha,
            "size_bytes": pkg_path.stat().st_size,
            **({"icon_data_uri": uri} if (uri := icon_data_uri(ext_dir, manifest)) else {}),
        })

    index = {"schema": SCHEMA, "extensions": entries}
    site.mkdir(parents=True, exist_ok=True)
    (site / "index.json").write_text(json.dumps(index, indent=2) + "\n")
    print(f"wrote {site / 'index.json'} ({len(entries)} extensions)")


if __name__ == "__main__":
    main()
