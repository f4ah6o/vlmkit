#!/usr/bin/env bash

VLMKIT_ENV_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
VLMKIT_LINUX_DIR="$(cd -- "$VLMKIT_ENV_DIR/.." && pwd -P)"
VLMKIT_REPO_ROOT="$(cd -- "$VLMKIT_ENV_DIR/../../.." && pwd -P)"
VLMKIT_LINUX_LOCK="${VLMKIT_LINUX_LOCK_FILE:-$VLMKIT_ENV_DIR/lock.json}"

if [[ -z "${VLMKIT_LINUX_PREFIX:-}" ]]; then
  _vlmkit_cache_home="${XDG_CACHE_HOME:-${HOME:-}/.cache}"
  if [[ -z "$_vlmkit_cache_home" || "$_vlmkit_cache_home" == "/.cache" ]]; then
    printf '%s\n' 'Set HOME or VLMKIT_LINUX_PREFIX before using the Linux environment scripts.' >&2
    return 2
  fi
  VLMKIT_LINUX_PREFIX="$_vlmkit_cache_home/vlmkit/linux-native-observer/debian-trixie-amd64"
fi
VLMKIT_LINUX_PREFIX="${VLMKIT_LINUX_PREFIX%/}"
if [[ -z "$VLMKIT_LINUX_PREFIX" ]]; then VLMKIT_LINUX_PREFIX="/"; fi
if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' 'Python 3 is required to normalize the environment prefix safely.' >&2
  return 2
fi
VLMKIT_LINUX_PREFIX="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$VLMKIT_LINUX_PREFIX")"
case "$VLMKIT_LINUX_PREFIX" in
  /|/bin|/bin/*|/boot|/boot/*|/dev|/dev/*|/etc|/etc/*|/lib|/lib/*|/lib64|/lib64/*|/opt|/opt/*|/proc|/proc/*|/run|/run/*|/sbin|/sbin/*|/sys|/sys/*|/usr|/usr/*|/var|/var/*)
    printf 'Refusing a system-directory prefix: %s\n' "$VLMKIT_LINUX_PREFIX" >&2
    return 2
    ;;
esac
VLMKIT_LINUX_OVERLAY="$VLMKIT_LINUX_PREFIX/overlay"
VLMKIT_LINUX_PYTHONPATH="$VLMKIT_LINUX_OVERLAY/usr/lib/python3/dist-packages"

if [[ ! -f "$VLMKIT_LINUX_LOCK" ]]; then
  printf 'Missing package lock: %s\n' "$VLMKIT_LINUX_LOCK" >&2
  return 2
fi

vlmkit_lock_sha256() {
  sha256sum "$VLMKIT_LINUX_LOCK" | cut -d ' ' -f 1
}
vlmkit_require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    printf 'Missing host command: %s\n' "$name" >&2
    return 1
  fi
}
