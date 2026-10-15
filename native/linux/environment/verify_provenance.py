#!/usr/bin/env python3
"""Verify the bundled signed Debian release and its pinned package-index digest."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile


ENV_DIR = Path(__file__).resolve().parent


def verify(lock_path: Path) -> None:
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    provenance = lock["provenance"]
    release = ENV_DIR / "metadata" / "trixie.InRelease"
    keyring = ENV_DIR / "metadata" / "debian-archive-keyring.pgp"

    release_bytes = release.read_bytes()
    if len(release_bytes) != provenance["inReleaseSize"]:
        raise ValueError("bundled InRelease size differs from lock.json")
    if hashlib.sha256(release_bytes).hexdigest() != provenance["inReleaseSha256"]:
        raise ValueError("bundled InRelease SHA256 differs from lock.json")

    keyring_bytes = keyring.read_bytes()
    if len(keyring_bytes) != provenance["archiveKeyringSize"]:
        raise ValueError("bundled Debian archive keyring size differs from lock.json")
    if hashlib.sha256(keyring_bytes).hexdigest() != provenance["archiveKeyringSha256"]:
        raise ValueError("bundled Debian archive keyring SHA256 differs from lock.json")

    with tempfile.TemporaryDirectory(prefix="vlmkit-debian-release-") as home:
        result = subprocess.run(
            [
                "gpg",
                "--no-options",
                "--homedir",
                home,
                "--batch",
                "--no-autostart",
                "--no-default-keyring",
                "--keyring",
                str(keyring),
                "--status-fd",
                "1",
                "--verify",
                str(release),
            ],
            text=True,
            capture_output=True,
            check=False,
        )
    if result.returncode != 0:
        raise ValueError("Debian InRelease signature verification failed: " + result.stderr.strip())

    verified_signers: set[str] = set()
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) >= 3 and fields[:2] == ["[GNUPG:]", "VALIDSIG"]:
            # For signatures made by a signing subkey, GnuPG appends its primary key fingerprint.
            verified_signers.add((fields[-1] if len(fields) >= 12 else fields[2]).upper())
    expected_signers = {fingerprint.upper() for fingerprint in provenance["verifiedSignerPrimaryFingerprints"]}
    if verified_signers != expected_signers:
        raise ValueError(
            "verified signer set differs from lock.json: "
            f"expected {sorted(expected_signers)}, got {sorted(verified_signers)}"
        )

    release_fields: dict[str, str] = {}
    checksums: dict[str, tuple[str, int]] = {}
    in_sha256 = False
    for line in release.read_text(encoding="utf-8").splitlines():
        if line.startswith("-----BEGIN PGP SIGNATURE-----"):
            break
        if ":" in line and not line.startswith((" ", "\t")):
            key, value = line.split(":", 1)
            release_fields[key] = value.strip()
        if line.strip() == "SHA256:":
            in_sha256 = True
            continue
        if in_sha256:
            if not line.startswith((" ", "\t")):
                in_sha256 = False
                continue
            fields = line.split()
            if len(fields) == 3:
                checksum, size, path = fields
                checksums[path] = (checksum, int(size))

    if release_fields.get("Codename") != lock["platform"]["codename"]:
        raise ValueError("signed InRelease codename differs from lock.json")
    if release_fields.get("Version") != provenance["inReleaseVersion"]:
        raise ValueError("signed InRelease version differs from lock.json")
    if release_fields.get("Acquire-By-Hash") != "yes":
        raise ValueError("signed InRelease does not enable by-hash index retrieval")
    index_path = provenance["packagesIndex"]
    suite_prefix = f"dists/{provenance['suite']}/"
    if not index_path.startswith(suite_prefix):
        raise ValueError("Packages index path is outside the pinned Debian suite")
    signed_index_path = index_path.removeprefix(suite_prefix)
    signed_index = checksums.get(signed_index_path)
    if signed_index != (provenance["packagesIndexSha256"], provenance["packagesIndexSize"]):
        raise ValueError("Packages index SHA256/size do not match the signed InRelease entry")
    compressed_index_path = provenance["packagesIndexCompressedPath"]
    if not compressed_index_path.startswith(suite_prefix):
        raise ValueError("compressed Packages index path is outside the pinned Debian suite")
    signed_compressed_index_path = compressed_index_path.removeprefix(suite_prefix)
    signed_compressed_index = checksums.get(signed_compressed_index_path)
    if signed_compressed_index != (
        provenance["packagesIndexCompressedSha256"],
        provenance["packagesIndexCompressedSize"],
    ):
        raise ValueError("compressed Packages index SHA256/size do not match the signed InRelease entry")


def main() -> int:
    lock_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ENV_DIR / "lock.json"
    try:
        verify(lock_path)
    except (OSError, KeyError, ValueError, json.JSONDecodeError, subprocess.SubprocessError) as exc:
        print(f"Debian provenance check failed: {exc}", file=sys.stderr)
        return 1
    print("Verified the bundled Debian trixie InRelease signatures and signed Packages index digest.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
