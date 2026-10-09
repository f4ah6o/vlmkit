#!/usr/bin/env python3
"""Build and verify hashes for the files extracted into the private overlay."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys


MANIFEST = ".vlmkit-files.json"
MARKER = ".vlmkit-managed"


def scan(root: Path) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    for current, directories, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        for name in list(directories):
            path = current_path / name
            if path.is_symlink():
                directories.remove(name)
                entries.append({"path": path.relative_to(root).as_posix(), "type": "symlink", "target": os.readlink(path)})
        for name in files:
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            if relative in {MANIFEST, MARKER}:
                continue
            if path.is_symlink():
                entries.append({"path": relative, "type": "symlink", "target": os.readlink(path)})
            elif path.is_file():
                entries.append(
                    {
                        "path": relative,
                        "type": "file",
                        "mode": stat.S_IMODE(path.lstat().st_mode),
                        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    }
                )
            else:
                raise ValueError(f"unsupported extracted filesystem object: {relative}")
    return sorted(entries, key=lambda entry: str(entry["path"]))


def build(root: Path) -> None:
    if root.is_symlink() or not root.is_dir():
        raise ValueError("overlay root is not a real directory")
    payload = {"schemaVersion": 1, "files": scan(root)}
    (root / MANIFEST).write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def verify(root: Path) -> None:
    if root.is_symlink() or not root.is_dir():
        raise ValueError("overlay root is not a real directory")
    manifest_path = root / MANIFEST
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError("overlay file manifest is missing or is not a regular file")
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    if payload.get("schemaVersion") != 1 or not isinstance(payload.get("files"), list):
        raise ValueError("unsupported overlay file manifest")
    expected = payload["files"]
    seen: set[str] = set()
    for entry in expected:
        relative = entry.get("path")
        if not isinstance(relative, str):
            raise ValueError("invalid path in overlay file manifest")
        pure = PurePosixPath(relative)
        if pure.is_absolute() or not pure.parts or ".." in pure.parts or relative in {MANIFEST, MARKER}:
            raise ValueError(f"unsafe path in overlay file manifest: {relative}")
        if relative in seen:
            raise ValueError(f"duplicate path in overlay file manifest: {relative}")
        seen.add(relative)
        path = root.joinpath(*pure.parts)
        if entry.get("type") == "symlink":
            if not path.is_symlink() or os.readlink(path) != entry.get("target"):
                raise ValueError(f"overlay symlink differs from manifest: {relative}")
        elif entry.get("type") == "file":
            if path.is_symlink() or not path.is_file():
                raise ValueError(f"overlay file is missing or changed type: {relative}")
            if stat.S_IMODE(path.lstat().st_mode) != entry.get("mode"):
                raise ValueError(f"overlay file mode differs from manifest: {relative}")
            if hashlib.sha256(path.read_bytes()).hexdigest() != entry.get("sha256"):
                raise ValueError(f"overlay file SHA256 differs from manifest: {relative}")
        else:
            raise ValueError(f"unsupported manifest entry type for {relative}")
    actual = {str(entry["path"]) for entry in scan(root)}
    if actual != seen:
        raise ValueError("overlay file set differs from manifest")


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in {"build", "verify"}:
        print("Usage: overlay_manifest.py build|verify OVERLAY_DIR", file=sys.stderr)
        return 2
    try:
        root = Path(sys.argv[2])
        if sys.argv[1] == "build":
            build(root)
        else:
            verify(root)
    except (OSError, KeyError, ValueError, json.JSONDecodeError) as exc:
        print(f"Overlay integrity check failed: {exc}", file=sys.stderr)
        return 1
    if sys.argv[1] == "verify":
        print("Verified extracted overlay files against their local manifest.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
