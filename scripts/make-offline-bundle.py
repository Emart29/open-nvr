#!/usr/bin/env python3
# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Make an offline update bundle for an air-gapped OpenNVR site (UPD-501).

Run on any machine with internet, git and Docker, from an OpenNVR checkout:

    python3 scripts/make-offline-bundle.py --version 0.2.1 \\
        --platform linux/arm64 --site-images site-images.txt \\
        --out opennvr-0.2.1-arm64-offline.tar

Carry the file to the site and run ``./start.sh update --bundle <file>``
(Windows: ``.\\start.ps1 update --bundle <file>``). The site verifies every
part again before anything changes.

The bundle holds: the release's signed manifest and the signed list of
withdrawn releases; the signed manifests of the releases before it (a site
with no record of what it runs is checked against them); a git bundle of
the release tag; and the images, pulled by digest for the site's platform.

``--site-images`` is the site's own image list, so the bundle holds only
what that site runs; make it on the site with ``./start.sh update
--list-images > site-images.txt``. Without it, every image of the release
goes in (tens of GB). Images the site builds itself (the catalog apps,
``opennvr/*:local-build``) are not in any release: build them here and add
them with ``--extra-image``, or the site keeps the ones it has.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "server"))

from updater import manifest, revocations, source  # noqa: E402
from updater.check import accepted_ids, repository  # noqa: E402

GIT_URL = "https://github.com/open-nvr/open-nvr.git"
API_RELEASES = "https://api.github.com/repos/open-nvr/open-nvr/releases?per_page=100"


def run(*cmd: str, cwd: Path | None = None) -> str:
    return subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def say(msg: str) -> None:
    print(msg, file=sys.stderr)


def earlier_versions(target: str) -> list[str]:
    """Releases before *target* that publish a manifest (GitHub only)."""
    try:
        with urllib.request.urlopen(API_RELEASES, timeout=30) as r:
            releases = json.load(r)
    except Exception as exc:  # the history is a help, not a must
        say(f"  ! could not list earlier releases ({exc}); the bundle has no history")
        return []
    out = []
    for rel in releases:
        tag = rel.get("tag_name", "")
        names = {a.get("name") for a in rel.get("assets", [])}
        try:
            older = manifest.parse_version(tag) < manifest.parse_version(target)
        except manifest.ManifestError:
            continue
        if older and not rel.get("draft") and manifest.MANIFEST_NAME in names:
            out.append(tag.removeprefix("v"))
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--version", help="the release (default: the latest)")
    ap.add_argument("--platform", help="the site's Docker platform, e.g. linux/arm64 (default: this machine's)")
    ap.add_argument("--site-images", type=Path, help="the site's image list (./start.sh update --list-images)")
    ap.add_argument("--extra-image", action="append", default=[], help="a local image to add (repeatable)")
    ap.add_argument("--source-url", help="a mirror instead of GitHub releases")
    ap.add_argument("--git-url", default=GIT_URL)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)

    platform = a.platform or run("docker", "version", "--format", "{{.Server.Os}}/{{.Server.Arch}}")
    raw, sig = source.fetch(a.version, a.source_url)
    try:
        release = manifest.verify(raw, sig)
        say(f"OpenNVR {release.version}: signature checked")
    except manifest.ManifestError as exc:
        if "trusts no release key" not in str(exc):
            raise SystemExit(f"Refusing to bundle: {exc}") from None
        release = manifest.parse(json.loads(raw))
        say(f"OpenNVR {release.version}: this checkout trusts no release key, so the signature is checked only at the site")

    with tempfile.TemporaryDirectory(prefix="opennvr-bundle-") as tmp:
        out = Path(tmp)
        source.save(out, raw, sig)
        for name in (revocations.NAME, revocations.SIGNATURE_NAME):
            root = (f"{source.GITHUB_RELEASES}/latest/download" if not a.source_url
                    else f"{a.source_url.rstrip('/')}/latest")
            try:
                with urllib.request.urlopen(f"{root}/{name}", timeout=30) as r:
                    (out / name).write_bytes(r.read())
            except Exception:
                break  # none published: nothing withdrawn
        history = earlier_versions(release.version) if not a.source_url else []
        for v in history:
            try:
                source.save(out / "history" / f"v{v}", *source.fetch(v, a.source_url))
            except manifest.ManifestError as exc:
                say(f"  ! no manifest for {v}: {exc}")
        say(f"  history: {', '.join(sorted(history, key=manifest.parse_version)) or 'none'}")

        say(f"  git: {release.git_tag} from {a.git_url}")
        run("git", "clone", "--quiet", "--bare", "--single-branch", "--branch", release.git_tag, a.git_url, str(out / "git"))
        got = run("git", "rev-parse", f"{release.git_tag}^{{commit}}", cwd=out / "git")
        if got != release.git_commit:
            raise SystemExit(f"{release.git_tag} is {got}, but the manifest says {release.git_commit}")
        run("git", "bundle", "create", str(out / "repo.bundle"), release.git_tag, cwd=out / "git")
        shutil.rmtree(out / "git", ignore_errors=True)

        wanted = None
        if a.site_images:
            wanted = {repository(line.strip()) for line in a.site_images.read_text().splitlines() if line.strip()}
        refs = []
        for img in release.images:
            if wanted is not None and img.repository not in wanted:
                continue
            accept = accepted_ids(img, platform)
            if not accept:
                say(f"  ! {img.ref}: not built for {platform}, left out")
                continue
            say(f"  pull {img.ref} ({platform})")
            run("docker", "pull", "--quiet", "--platform", platform, f"{img.repository}@{img.digest}")
            run("docker", "tag", f"{img.repository}@{img.digest}", img.ref)
            local = run("docker", "image", "inspect", "--format", "{{.Id}}", img.ref)
            if local not in accept:
                raise SystemExit(f"{img.ref} pulled as {local}, which the manifest does not name")
            refs.append(img.ref)
        if wanted is not None:
            missing = sorted(w for w in wanted if not release.image_for(w))
            if missing:
                say("  ! not in the release (built on the site; add with --extra-image if they change): "
                    + ", ".join(missing))
        refs += a.extra_image
        say(f"  saving {len(refs)} images ...")
        try:
            # Only the site's platform: a containerd image store pulled only
            # that one, and a plain save would ask for the whole index.
            run("docker", "save", "--platform", platform, "-o", str(out / "images.tar"), *refs)
        except subprocess.CalledProcessError as exc:
            if "unknown flag" not in (exc.stderr or ""):
                raise
            run("docker", "save", "-o", str(out / "images.tar"), *refs)  # older Docker: no --platform

        a.out.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(a.out, "w") as t:
            for p in sorted(out.rglob("*")):
                if p.is_file():
                    t.add(p, arcname=p.relative_to(out).as_posix())
    say(f"Wrote {a.out} ({a.out.stat().st_size / 1e9:.2f} GB). On the site: ./start.sh update --bundle {a.out.name}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except manifest.ManifestError as exc:
        raise SystemExit(f"Cannot make the bundle: {exc}") from None
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"Cannot make the bundle: {' '.join(exc.cmd)} failed:\n{(exc.stderr or '').strip()}") from None
