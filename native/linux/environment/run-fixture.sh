#!/usr/bin/env bash
set -euo pipefail

source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

timeout_seconds="${VLMKIT_LINUX_TIMEOUT_SECONDS:-180}"
evidence_dir="${VLMKIT_LINUX_EVIDENCE_DIR:-test-results/native/linux}"
python="${VLMKIT_LINUX_PYTHON:-/usr/bin/python3}"

usage() {
  cat <<'EOF'
Run the Linux native-observer GTK fixture in an isolated Xvfb and D-Bus session.

Usage:
  native/linux/environment/run-fixture.sh

Configuration:
  VLMKIT_LINUX_PREFIX          bootstrap prefix (same default as bootstrap.sh)
  VLMKIT_LINUX_EVIDENCE_DIR    output directory (default: test-results/native/linux)
  VLMKIT_LINUX_PYTHON          Python 3.13 with Gtk 3 / Atk and the Cairo foreign converter (default: /usr/bin/python3)
  VLMKIT_LINUX_TIMEOUT_SECONDS bounded wall-clock timeout (default: 180)

This command launches only the repository's own GTK fixture. It never attaches
to or captures the user's desktop. Use doctor.sh for non-running preflight.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then usage; exit 0; fi
if [[ $# -ne 0 ]]; then printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2; fi
if ! [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  printf 'VLMKIT_LINUX_TIMEOUT_SECONDS must be a positive integer (got %s).\n' "$timeout_seconds" >&2
  exit 2
fi

for tool in date mktemp tee timeout git sha256sum; do vlmkit_require_command "$tool"; done
if [[ ! -x "$python" ]]; then
  printf 'Host Python not found: %s\n' "$python" >&2
  exit 1
fi

"$VLMKIT_ENV_DIR/doctor.sh"

if [[ "$evidence_dir" != /* ]]; then evidence_dir="$VLMKIT_REPO_ROOT/$evidence_dir"; fi
mkdir -p -- "$evidence_dir"
run_dir="$(mktemp -d "$evidence_dir/run-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")"
artifacts="$run_dir/artifacts"
mkdir -p -- "$artifacts"
log_file="$run_dir/run.log"
manifest="$run_dir/source-manifest.json"

started_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
"$python" - "$VLMKIT_REPO_ROOT" "$manifest" "$started_utc" "$VLMKIT_LINUX_LOCK" <<'PY'
import hashlib
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
started = sys.argv[3]
selected_lock = pathlib.Path(sys.argv[4])
paths = [
    "native/linux/observer.py",
    "native/linux/fixture.py",
    "native/linux/integration.py",
    "native/linux/with-compositor.sh",
    "native/linux/environment/lock.json",
    "native/linux/environment/metadata/trixie.InRelease",
    "native/linux/environment/metadata/debian-archive-keyring.pgp",
    "native/linux/environment/common.sh",
    "native/linux/environment/verify_provenance.py",
    "native/linux/environment/verify_packages.py",
    "native/linux/environment/overlay_manifest.py",
    "native/linux/environment/bootstrap.sh",
    "native/linux/environment/doctor.sh",
    "native/linux/environment/run-fixture.sh",
]
sources = {}
for rel in paths:
    data = (root / rel).read_bytes()
    sources[rel] = hashlib.sha256(data).hexdigest()
try:
    commit = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
except (OSError, subprocess.CalledProcessError):
    commit = "unavailable"
payload = {
    "schemaVersion": 1,
    "profile": "debian-trixie-amd64-x11-fixture",
    "startedUtc": started,
    "repositoryCommit": commit,
    "sourceSha256": sources,
    "selectedLock": "repository-default" if selected_lock.resolve() == (root / "native/linux/environment/lock.json").resolve() else "custom",
    "selectedLockSha256": hashlib.sha256(selected_lock.read_bytes()).hexdigest(),
}
out.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

export PATH="$VLMKIT_LINUX_OVERLAY/usr/bin:$PATH"
export GTK_MODULES='gail:atk-bridge'
export NO_AT_BRIDGE=0
export GDK_BACKEND=x11
export XDG_SESSION_TYPE=x11
unset WAYLAND_DISPLAY WAYLAND_SOCKET AT_SPI_BUS_ADDRESS AT_SPI_DISPLAY DBUS_STARTER_ADDRESS DBUS_STARTER_BUS_TYPE

run_fixture() {
  local rc
  printf 'started_utc=%s\n' "$started_utc"
  printf 'timeout_seconds=%s\n' "$timeout_seconds"
  printf 'source_manifest=%s\n' "${manifest#"$VLMKIT_REPO_ROOT"/}"
  printf '%s\n' 'command=dbus-run-session -- xvfb-run -a -s "-screen 0 1280x1024x24 -nolisten tcp" native/linux/with-compositor.sh <host-python> native/linux/integration.py'
  printf '%s\n' 'The isolated GTK fixture may take up to the configured timeout.'
  timeout --signal=TERM --kill-after=10s "${timeout_seconds}s" \
    dbus-run-session -- xvfb-run -a -s '-screen 0 1280x1024x24 -nolisten tcp' \
    "$VLMKIT_LINUX_DIR/with-compositor.sh" "$python" "$VLMKIT_LINUX_DIR/integration.py" --out "$artifacts"
  rc=$?
  finished_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'finished_utc=%s\n' "$finished_utc"
  printf 'exit_status=%s\n' "$rc"
  if [[ "$rc" -eq 124 || "$rc" -eq 137 ]]; then printf 'timed_out=true\n'; else printf 'timed_out=false\n'; fi
  return "$rc"
}

set +e
run_fixture 2>&1 | tee "$log_file"
exit_status=${PIPESTATUS[0]}
set -e
finished_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
manifest_sha="$(sha256sum -- "$manifest" | cut -d ' ' -f 1)"
"$python" - "$run_dir/run-summary.json" "$started_utc" "$finished_utc" "$timeout_seconds" "$exit_status" "$manifest_sha" <<'PY'
import json
import sys

out, started, finished, timeout, code, manifest_sha = sys.argv[1:]
code = int(code)
payload = {
    "startedUtc": started,
    "finishedUtc": finished,
    "timeoutSeconds": int(timeout),
    "exitStatus": code,
    "timedOut": code in (124, 137),
    "sourceManifestSha256": manifest_sha,
}
with open(out, "w", encoding="utf-8") as f:
    json.dump(payload, f, indent=2, sort_keys=True)
    f.write("\n")
PY
printf 'run_summary=%s\n' "$run_dir/run-summary.json"
printf 'run_log=%s\n' "$log_file"
printf 'evidence_dir=%s\n' "$artifacts"
exit "$exit_status"
