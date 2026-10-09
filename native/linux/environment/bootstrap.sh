#!/usr/bin/env bash
set -euo pipefail

source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

usage() {
  cat <<'EOF'
Bootstrap the pinned Debian Trixie X11 tools and Python bindings into a private prefix.

Usage:
  native/linux/environment/bootstrap.sh

Configuration:
  VLMKIT_LINUX_PREFIX  install/cache prefix (default: $XDG_CACHE_HOME/vlmkit/…)

This verifies Debian's signed package index, downloads eight pinned .deb files,
and extracts them without root, apt, package maintainer scripts, or changes to
the host system.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
if [[ $# -ne 0 ]]; then
  printf 'Unknown argument: %s\n' "$1" >&2
  usage >&2
  exit 2
fi

for tool in python3 curl sha256sum stat dpkg-deb gpg xz flock; do
  vlmkit_require_command "$tool"
done

python3 "$VLMKIT_ENV_DIR/verify_provenance.py" "$VLMKIT_LINUX_LOCK"

lock_rows() {
  python3 - "$VLMKIT_LINUX_LOCK" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    lock = json.load(f)
if lock.get("profile") != "debian-trixie-amd64-x11-fixture":
    raise SystemExit("unsupported environment profile")
if lock.get("platform", {}).get("codename") != "trixie" or lock.get("platform", {}).get("architecture") != "amd64":
    raise SystemExit("lock must target Debian trixie amd64")
provenance = lock.get("provenance", {})
if provenance.get("repository") != "https://deb.debian.org/debian/":
    raise SystemExit("package repository must be the official Debian HTTPS archive")
if provenance.get("packagesIndex") != "dists/trixie/main/binary-amd64/Packages":
    raise SystemExit("unexpected Debian package index provenance")
if provenance.get("packagesIndexCompressedPath") != "dists/trixie/main/binary-amd64/Packages.xz":
    raise SystemExit("unexpected compressed Debian package index provenance")
packages = lock.get("packages", [])
expected_names = ["xvfb", "xserver-common", "xauth", "x11-xkb-utils", "xcompmgr", "python3-gi", "python3-cairo", "python3-gi-cairo"]
if [p.get("name") for p in packages] != expected_names:
    raise SystemExit("expected the pinned Xvfb/X11 and Python GI/Cairo package set")
if lock.get("pythonRuntime") != {
    "version": "3.13",
    "soabi": "cpython-313-x86_64-linux-gnu",
    "moduleDirectory": "usr/lib/python3/dist-packages",
}:
    raise SystemExit("unexpected Python ABI or module directory")
for p in packages:
    fields = [p["name"], p["version"], p["architecture"], p["filename"], str(p["size"]), p["sha256"]]
    if any("\t" in v or "\n" in v for v in fields):
        raise SystemExit("lock field contains a tab or newline")
    if not re.fullmatch(r"pool/[A-Za-z0-9+._/-]+", p["filename"]) or ".." in p["filename"].split("/"):
        raise SystemExit(f"unsafe package path: {p['filename']}")
    if not re.fullmatch(r"[0-9a-f]{64}", p["sha256"]):
        raise SystemExit(f"invalid SHA256 for {p['name']}")
    if int(p["size"]) <= 0:
        raise SystemExit(f"invalid size for {p['name']}")
    print("\t".join(fields))
PY
}

verify_archive() {
  local archive="$1" expected_size="$2" expected_sha="$3" expected_name="$4" expected_version="$5" expected_arch="$6"
  local package_metadata
  [[ -f "$archive" ]] || return 1
  [[ "$(stat -c '%s' -- "$archive")" == "$expected_size" ]] || return 1
  [[ "$(sha256sum -- "$archive" | cut -d ' ' -f 1)" == "$expected_sha" ]] || return 1
  package_metadata="$(dpkg-deb --showformat='${Package}\t${Version}\t${Architecture}' --show "$archive")"
  [[ "$package_metadata" == "${expected_name}"$'\t'"${expected_version}"$'\t'"${expected_arch}" ]]
}

download_tmp=""
index_tmp=""
stage=""
old=""
cleanup() {
  [[ -z "$download_tmp" || ! -e "$download_tmp" ]] || rm -f -- "$download_tmp"
  [[ -z "$index_tmp" || ! -e "$index_tmp" ]] || rm -f -- "$index_tmp"
  [[ -z "$stage" || ! -d "$stage" ]] || rm -rf -- "$stage"
  if [[ -n "$old" && -d "$old" && ! -e "$VLMKIT_LINUX_OVERLAY" ]]; then
    mv -T -- "$old" "$VLMKIT_LINUX_OVERLAY"
  fi
}
trap cleanup EXIT

verify_digest_file() {
  local file="$1" expected_size="$2" expected_sha="$3"
  [[ -f "$file" && ! -L "$file" ]] || return 1
  [[ "$(stat -c '%s' -- "$file")" == "$expected_size" ]] || return 1
  [[ "$(sha256sum -- "$file" | cut -d ' ' -f 1)" == "$expected_sha" ]]
}

mkdir -p -- "$VLMKIT_LINUX_PREFIX"
for child in downloads metadata; do
  path="$VLMKIT_LINUX_PREFIX/$child"
  if [[ -L "$path" || ( -e "$path" && ! -d "$path" ) ]]; then
    printf 'Refusing symlink or non-directory cache path: %s\n' "$path" >&2
    exit 1
  fi
done
lock_file="$VLMKIT_LINUX_PREFIX/.bootstrap.lock"
if [[ -L "$lock_file" || ( -e "$lock_file" && ! -f "$lock_file" ) ]]; then
  printf 'Refusing symlink or non-file bootstrap lock: %s\n' "$lock_file" >&2
  exit 1
fi
exec {bootstrap_lock_fd}>>"$lock_file"
flock "$bootstrap_lock_fd"
mkdir -p -- "$VLMKIT_LINUX_PREFIX/downloads" "$VLMKIT_LINUX_PREFIX/metadata"
packages="$(lock_rows)"
if [[ -z "$packages" ]]; then
  printf '%s\n' 'Package lock contains no installable packages.' >&2
  exit 1
fi
metadata_fields="$(python3 - "$VLMKIT_LINUX_LOCK" <<'PY'
import json, sys
provenance = json.load(open(sys.argv[1], encoding="utf-8"))["provenance"]
print("\t".join((
    provenance["repository"].rstrip("/"),
    provenance["packagesIndexCompressedPath"],
    str(provenance["packagesIndexCompressedSize"]),
    provenance["packagesIndexCompressedSha256"],
    str(provenance["packagesIndexSize"]),
    provenance["packagesIndexSha256"],
)))
PY
)"
IFS=$'\t' read -r repository compressed_index_path compressed_index_size compressed_index_sha index_size index_sha <<< "$metadata_fields"

compressed_index="$VLMKIT_LINUX_PREFIX/metadata/${compressed_index_sha}.Packages.xz"
if [[ -L "$compressed_index" || ( -e "$compressed_index" && ! -f "$compressed_index" ) ]]; then
  printf 'Refusing symlink or non-file package-index cache entry: %s\n' "$compressed_index" >&2
  exit 1
fi
if ! verify_digest_file "$compressed_index" "$compressed_index_size" "$compressed_index_sha"; then
  download_tmp="$(mktemp "$compressed_index.tmp.XXXXXX")"
  printf 'Downloading signed Debian package index by hash (%s)\n' "$compressed_index_sha"
  if ! curl --fail --location --retry 3 --retry-delay 1 --proto '=https' --tlsv1.2 \
    --silent --show-error --output "$download_tmp" \
    "$repository/${compressed_index_path%/*}/by-hash/SHA256/$compressed_index_sha"; then
    printf '%s\n' 'Signed package-index download failed; any partial file will be removed.' >&2
    exit 1
  fi
  if ! verify_digest_file "$download_tmp" "$compressed_index_size" "$compressed_index_sha"; then
    printf '%s\n' 'Downloaded package index failed its signed size/SHA256 check.' >&2
    exit 1
  fi
  mv -fT -- "$download_tmp" "$compressed_index"
  download_tmp=""
fi

index_tmp="$(mktemp "$VLMKIT_LINUX_PREFIX/metadata/Packages.XXXXXX")"
if ! xz --decompress --stdout "$compressed_index" > "$index_tmp"; then
  printf '%s\n' 'Pinned package index could not be decompressed.' >&2
  exit 1
fi
if ! verify_digest_file "$index_tmp" "$index_size" "$index_sha"; then
  printf '%s\n' 'Decompressed package index does not match the signed InRelease digest.' >&2
  exit 1
fi
python3 "$VLMKIT_ENV_DIR/verify_packages.py" "$VLMKIT_LINUX_LOCK" "$index_tmp"
rm -f -- "$index_tmp"
index_tmp=""

while IFS=$'\t' read -r name version architecture filename size sha256; do
  [[ -n "$name" ]] || continue
  archive="$VLMKIT_LINUX_PREFIX/downloads/${filename##*/}"
  if [[ -L "$archive" || ( -e "$archive" && ! -f "$archive" ) ]]; then
    printf 'Refusing symlink or non-file package cache entry: %s\n' "$archive" >&2
    exit 1
  fi
  if verify_archive "$archive" "$size" "$sha256" "$name" "$version" "$architecture"; then
    printf 'Verified cached %s %s\n' "$name" "$version"
    continue
  fi

  download_tmp="$(mktemp "$archive.tmp.XXXXXX")"
  printf 'Downloading pinned %s %s from Debian\n' "$name" "$version"
  if ! curl --fail --location --retry 3 --retry-delay 1 --proto '=https' --tlsv1.2 \
    --silent --show-error --output "$download_tmp" "$repository/$filename"; then
    printf 'Download failed for %s; any partial file will be removed.\n' "$name" >&2
    exit 1
  fi
  if ! verify_archive "$download_tmp" "$size" "$sha256" "$name" "$version" "$architecture"; then
    printf 'Downloaded package failed its locked size, SHA256, or dpkg metadata check: %s\n' "$name" >&2
    exit 1
  fi
  mv -fT -- "$download_tmp" "$archive"
  download_tmp=""
done <<< "$packages"

lock_sha="$(vlmkit_lock_sha256)"
if [[ -e "$VLMKIT_LINUX_OVERLAY" && ( -L "$VLMKIT_LINUX_OVERLAY" || ! -f "$VLMKIT_LINUX_OVERLAY/.vlmkit-managed" ) ]]; then
  printf 'Refusing to replace unmanaged path: %s\n' "$VLMKIT_LINUX_OVERLAY" >&2
  exit 1
fi
if [[ -f "$VLMKIT_LINUX_OVERLAY/.vlmkit-managed" ]] \
    && [[ "$(cat "$VLMKIT_LINUX_OVERLAY/.vlmkit-managed")" == "$lock_sha" ]]; then
  binaries_ok=true
  for binary in Xvfb xvfb-run xauth xkbcomp setxkbmap xcompmgr; do
    [[ -x "$VLMKIT_LINUX_OVERLAY/usr/bin/$binary" ]] || binaries_ok=false
  done
  if [[ "$binaries_ok" == true ]] && python3 "$VLMKIT_ENV_DIR/overlay_manifest.py" verify "$VLMKIT_LINUX_OVERLAY" >/dev/null; then
    printf 'Overlay files match lock %s; no extraction needed.\n' "$lock_sha"
    exit 0
  fi
  printf '%s\n' 'Managed overlay is incomplete or altered; rebuilding from the verified package cache.'
fi

stage="$(mktemp -d "$VLMKIT_LINUX_PREFIX/.overlay-new.XXXXXX")"

while IFS=$'\t' read -r name version architecture filename size sha256; do
  [[ -n "$name" ]] || continue
  archive="$VLMKIT_LINUX_PREFIX/downloads/${filename##*/}"
  printf 'Extracting %s %s into staged overlay\n' "$name" "$version"
  dpkg-deb --extract "$archive" "$stage"
done <<< "$packages"
python3 "$VLMKIT_ENV_DIR/overlay_manifest.py" build "$stage"
printf '%s\n' "$lock_sha" > "$stage/.vlmkit-managed"

if [[ -e "$VLMKIT_LINUX_OVERLAY" ]]; then
  old="$VLMKIT_LINUX_PREFIX/.overlay-previous.$$.$(printf '%s' "$lock_sha" | cut -c1-12)"
  if [[ -e "$old" || -L "$old" ]]; then
    printf 'Refusing to overwrite previous overlay backup: %s\n' "$old" >&2
    exit 1
  fi
  mv -T -- "$VLMKIT_LINUX_OVERLAY" "$old"
fi
mv -T -- "$stage" "$VLMKIT_LINUX_OVERLAY"
stage=""
previous="$old"
old=""
trap - EXIT

printf 'Installed the pinned X11 fixture overlay at %s\n' "$VLMKIT_LINUX_OVERLAY"
if [[ -n "$previous" ]]; then printf 'Previous managed overlay retained at %s\n' "$previous"; fi
printf 'This overlay does not include or install host GTK/AT-SPI/Python/D-Bus prerequisites.\n'
