#!/usr/bin/env python3
"""Match every pinned package tuple to a stanza in the verified Debian index."""

from __future__ import annotations

import json
from pathlib import Path
import sys


def verify(lock_path: Path, packages_index: Path) -> None:
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    packages = lock["packages"]
    if [package["name"] for package in packages] != ["xvfb", "xserver-common", "xauth", "x11-xkb-utils", "xcompmgr"]:
        raise ValueError("lock does not contain the expected Xvfb/X11 package set")

    expected_records = {
        (package["name"], package["version"], package["architecture"]): package
        for package in packages
    }
    records: dict[tuple[str, str, str], list[dict[str, str]]] = {}

    def keep_record(fields: dict[str, str]) -> None:
        key = (fields.get("Package", ""), fields.get("Version", ""), fields.get("Architecture", ""))
        if key in expected_records:
            records.setdefault(key, []).append(fields)

    if str(packages_index) == "-":
        source = sys.stdin.buffer
        close_source = False
    else:
        source = packages_index.open("rb")
        close_source = True
    try:
        current: dict[str, str] = {}
        for raw_line in source:
            line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
            if not line:
                keep_record(current)
                current = {}
                continue
            if line.startswith((" ", "\t")):
                continue
            field, separator, value = line.partition(": ")
            if separator:
                current[field] = value
        keep_record(current)
    finally:
        if close_source:
            source.close()

    for package in packages:
        key = (package["name"], package["version"], package["architecture"])
        matches = records.get(key, [])
        if len(matches) != 1:
            raise ValueError(f"expected one signed Packages entry for {key}, found {len(matches)}")
        record = matches[0]
        expected_fields = {
            "Filename": package["filename"],
            "Size": str(package["size"]),
            "SHA256": package["sha256"],
        }
        for field, value in expected_fields.items():
            if record.get(field) != value:
                raise ValueError(f"{key} {field} differs from the signed Packages entry")


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: verify_packages.py LOCK.json PACKAGES_INDEX|-", file=sys.stderr)
        return 2
    try:
        verify(Path(sys.argv[1]), Path(sys.argv[2]))
    except (OSError, KeyError, ValueError, json.JSONDecodeError) as exc:
        print(f"Debian package-index check failed: {exc}", file=sys.stderr)
        return 1
    print("Verified all locked package records against the Packages index.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
