#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec "$root/native/macos/script/build_and_run.sh" "$@"
