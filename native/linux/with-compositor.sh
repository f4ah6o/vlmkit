#!/bin/sh
# Test harness only: run inside an isolated Xvfb display, never a user's desktop.
set -eu
if [ "$#" -eq 0 ]; then
  echo 'Usage: with-compositor.sh command [args...] (inside isolated Xvfb)' >&2
  exit 2
fi
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
xcompmgr -n &
COMPOSITOR_PID=$!
cleanup() {
  kill "$COMPOSITOR_PID" 2>/dev/null || true
  wait "$COMPOSITOR_PID" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Poll actual selection ownership before any fixture window is created.
PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}" /usr/bin/python3 - <<'PY'
import time
from observer import X11, Failure, I
x = X11()
try:
    deadline = time.monotonic() + 5
    while True:
        try:
            x.compositor()
            break
        except Failure:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.05)
finally:
    x.fn('XCloseDisplay', I)()
PY
"$@"
