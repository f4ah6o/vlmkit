#!/usr/bin/env bash
set -euo pipefail

source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

probe_dbus=false
usage() {
  cat <<'EOF'
Read-only preflight for the pinned Linux native-observer fixture profile.

Usage:
  native/linux/environment/doctor.sh [--probe-dbus]

By default, this checks files, commands, host libraries and Python imports only.
It does not connect to or start D-Bus and does not launch a GUI. --probe-dbus
explicitly starts a short-lived private D-Bus session and verifies a bus method.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --probe-dbus) probe_dbus=true ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

failure_count=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failure_count=$((failure_count + 1)); }
blocked() { printf 'BLOCKED  %s\n' "$1"; failure_count=$((failure_count + 1)); }

printf 'VLMKit Linux observer test profile (read-only preflight)\n'
printf 'Prefix: %s\n' "$VLMKIT_LINUX_PREFIX"
printf 'Lock SHA256: %s\n' "$(vlmkit_lock_sha256)"

if [[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]]; then
  pass 'Linux x86_64 host'
else
  blocked "Linux x86_64 host required (found $(uname -s) / $(uname -m))"
fi

os_id='unknown'
os_codename='unknown'
if [[ -r /etc/os-release ]]; then
  # os-release is a root-owned shell assignment file on supported Linux systems.
  . /etc/os-release
  os_id="${ID:-unknown}"
  os_codename="${VERSION_CODENAME:-unknown}"
fi
if [[ "$os_id" == "debian" && "$os_codename" == "trixie" ]]; then
  pass 'Debian 13 (trixie) host matches the locked package profile'
else
  blocked "Debian 13 (trixie) is required for this package lock (found $os_id / $os_codename)"
fi

lock_sha="$(vlmkit_lock_sha256)"
if [[ -f "$VLMKIT_LINUX_OVERLAY/.vlmkit-managed" ]] \
    && [[ "$(cat "$VLMKIT_LINUX_OVERLAY/.vlmkit-managed")" == "$lock_sha" ]]; then
  pass 'Pinned tool overlay matches lock.json'
else
  fail 'Pinned tool overlay is missing or was built from a different lock; run bootstrap.sh'
fi

for binary in Xvfb xvfb-run xauth xkbcomp setxkbmap xcompmgr; do
  if [[ -x "$VLMKIT_LINUX_OVERLAY/usr/bin/$binary" ]]; then
    pass "overlay command $binary"
  else
    fail "overlay command missing: $VLMKIT_LINUX_OVERLAY/usr/bin/$binary"
  fi
done
if python3 "$VLMKIT_ENV_DIR/overlay_manifest.py" verify "$VLMKIT_LINUX_OVERLAY" >/dev/null 2>&1; then
  pass 'extracted overlay file integrity manifest'
else
  fail 'extracted overlay file integrity manifest is missing or does not match'
fi

for tool in dbus-run-session dbus-daemon timeout ldd ldconfig find grep gpg python3 xz stat sha256sum; do
  if command -v "$tool" >/dev/null 2>&1; then pass "host command $tool"; else blocked "host command missing: $tool"; fi
done

python="${VLMKIT_LINUX_PYTHON:-/usr/bin/python3}"
if [[ -x "$python" ]]; then
  if "$python" - <<'PY' >/dev/null 2>&1
import gi
gi.require_foreign("cairo")
PY
  then
    pass "Python PyGObject Cairo foreign converter ($python)"
  else
    blocked "Python PyGObject Cairo foreign converter unavailable to $python; host must provide python3-gi-cairo and python3-cairo built for this Python ABI"
  fi
  if "$python" - <<'PY' >/dev/null 2>&1
import gi
repository = gi.Repository.get_default()
repository.require("Gtk", "3.0", 0)
repository.require("Atk", "1.0", 0)
PY
  then
    pass "Python Gtk 3 / Atk typelibs ($python)"
  else
    blocked "Python Gtk 3 / Atk typelibs unavailable to $python; host must provide PyGObject, GTK 3 and Atk"
  fi
else
  blocked "Host Python not found: $python (set VLMKIT_LINUX_PYTHON to a system Python with Gtk 3 / Atk)"
fi

if command -v gpg >/dev/null 2>&1 && python3 "$VLMKIT_ENV_DIR/verify_provenance.py" "$VLMKIT_LINUX_LOCK"; then
  pass 'signed Debian release and package-index digest provenance'
else
  fail 'signed Debian release/package-index provenance could not be verified'
fi

index_fields="$(python3 - "$VLMKIT_LINUX_LOCK" <<'PY'
import json, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))["provenance"]
print("\t".join((str(p["packagesIndexCompressedSize"]), p["packagesIndexCompressedSha256"])))
PY
)"
IFS=$'\t' read -r index_compressed_size index_compressed_sha <<< "$index_fields"
cached_index="$VLMKIT_LINUX_PREFIX/metadata/${index_compressed_sha}.Packages.xz"
if [[ -f "$cached_index" && ! -L "$cached_index" ]] \
    && [[ "$(stat -c '%s' -- "$cached_index")" == "$index_compressed_size" ]] \
    && [[ "$(sha256sum -- "$cached_index" | cut -d ' ' -f 1)" == "$index_compressed_sha" ]] \
    && xz --decompress --stdout "$cached_index" | python3 "$VLMKIT_ENV_DIR/verify_packages.py" "$VLMKIT_LINUX_LOCK" - >/dev/null; then
  pass 'pinned package records match the signed Debian Packages index'
else
  fail 'signed Debian Packages index cache is missing, corrupt, or does not match package lock records'
fi

if [[ -d /usr/share/X11/xkb ]]; then pass 'host XKB data (/usr/share/X11/xkb)'; else blocked 'host XKB data missing (/usr/share/X11/xkb; provide xkb-data)'; fi
if [[ -x /usr/bin/xkbcomp ]]; then pass 'host XKB helper (/usr/bin/xkbcomp)'; else blocked 'host XKB helper missing (/usr/bin/xkbcomp; this Xvfb build does not use the private overlay path)'; fi

ldconfig_output=''
if command -v ldconfig >/dev/null 2>&1; then ldconfig_output="$(ldconfig -p 2>/dev/null || true)"; fi
for library in libatspi.so.0 libatk-1.0.so.0 libgtk-3.so.0 libglib-2.0.so.0 libgobject-2.0.so.0 libX11.so.6 libXcomposite.so.1; do
  if [[ "$ldconfig_output" == *"$library"* ]]; then
    pass "host shared library $library"
  else
    blocked "host shared library missing: $library"
  fi
done

if [[ -n "$(find /usr/lib /usr/libexec -type f \( -name at-spi2-registryd -o -name at-spi-bus-launcher \) -print -quit 2>/dev/null || true)" ]]; then
  pass 'host AT-SPI registry / bus launcher'
else
  blocked 'host AT-SPI registry / bus launcher missing (provide at-spi2-core)'
fi
if [[ -n "$(find /usr/lib -type f -path '*/gtk-3.0/modules/libatk-bridge.so' -print -quit 2>/dev/null || true)" ]]; then
  pass 'host GTK AT-SPI bridge module'
else
  blocked 'host GTK AT-SPI bridge module missing (provide libatk-adaptor)'
fi

ldd_failed=false
for binary in \
  "$VLMKIT_LINUX_OVERLAY/usr/bin/Xvfb" \
  "$VLMKIT_LINUX_OVERLAY/usr/bin/xcompmgr" \
  "$VLMKIT_LINUX_OVERLAY/usr/bin/xauth" \
  "$VLMKIT_LINUX_OVERLAY/usr/bin/xkbcomp" \
  "$VLMKIT_LINUX_OVERLAY/usr/bin/setxkbmap" \
  /usr/bin/xkbcomp; do
  if [[ -x "$binary" ]]; then
    missing="$(LC_ALL=C ldd "$binary" 2>&1 | grep 'not found' || true)"
    if [[ -z "$missing" ]]; then
      pass "runtime shared-library resolution for ${binary##*/}"
    else
      blocked "unresolved host shared libraries for ${binary##*/}: ${missing//$'\n'/; }"
      ldd_failed=true
    fi
  fi
done
if [[ "$ldd_failed" == true ]]; then
  printf '%s\n' 'The bootstrap overlay does not vendor shared libraries; satisfy them with the host distribution.'
fi

if [[ "$probe_dbus" == true ]]; then
  if command -v dbus-send >/dev/null 2>&1; then
    if timeout 10s dbus-run-session -- sh -c \
      'dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.ListNames >/dev/null'; then
      pass 'explicit private D-Bus session probe'
    else
      fail 'explicit private D-Bus session probe failed or timed out'
    fi
  else
    fail 'dbus-send is required for --probe-dbus'
  fi
else
  printf '%s\n' 'INFO  D-Bus session not probed (default is read-only; opt in with --probe-dbus)'
fi

if [[ "$failure_count" -gt 0 ]]; then
  printf 'Preflight found %d issue(s). Host prerequisites are not installed by these scripts.\n' "$failure_count" >&2
  exit 1
fi
printf '%s\n' 'Preflight passed; live fixture execution has not been run.'
