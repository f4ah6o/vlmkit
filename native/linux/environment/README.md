# Linux native-observer fixture environment

These scripts make the repository's Linux X11/GTK fixture repeatable on a
Debian 13 (trixie), x86_64 test host. The lock covers the Xvfb display tools;
it does not install packages into the host.

## One-time setup and checks

```sh
native/linux/environment/bootstrap.sh
native/linux/environment/doctor.sh
```

The bootstrap verifies the bundled Debian signature, downloads the compressed
`Packages` index from Debian's signed by-hash URL, checks its signed SHA-256 and
size, and confirms every locked package record against that index. It then
downloads five exact `.deb` files from Debian's official pool, checks each
archive's size, SHA-256, package name, version and architecture, and extracts
them into a user-writable overlay. It is safe to repeat. It does not use
`sudo`, apt, package maintainer scripts, or system directories.
The default prefix is under `$XDG_CACHE_HOME` (or `$HOME/.cache`); set
`VLMKIT_LINUX_PREFIX` to choose another location. The `overlay/` child is owned
by this script. It refuses to replace an existing unmanaged `overlay/` path.
Choose a prefix private to the current user; bootstrap serializes runs with a
prefix-local lock file and refuses symlinked cache directories.
If a reviewed lock changes, the previous managed overlay is retained beside
the new one instead of being deleted. Extracted files have a local hash/mode
manifest; reruns verify it and repair an incomplete overlay from the pinned
cache while preserving the previous state.
For isolated tests only, `VLMKIT_LINUX_LOCK_FILE` can point at an alternate
lock; audit that file before using it with a real prefix.

`lock.json` records the Debian trixie `InRelease` digest, the `Packages` index
digest and size, the archive-keyring digest and the primary fingerprints of
the good Debian signatures, plus each archive's exact version, path, size and
digest. The signed `InRelease` and Debian archive keyring are included as small
public metadata files. Both bootstrap and doctor verify the signatures, the
keyring and `InRelease` digests, and the compressed and uncompressed `Packages`
index digest/size from the signed release file. Bootstrap also matches each
locked name/version/architecture/filename/size/SHA256 tuple to that index
before downloading archives. No private worktree, home, or evidence path is
part of the lock.

## Host prerequisites

This is deliberately a small user-space overlay, not a full Linux image. The
host must provide:

- Debian 13 (trixie), x86_64, with the runtime shared libraries needed by the
  pinned Xvfb/X11 tools
- Debian 13's Python 3.13 with PyGObject, Pycairo, the ABI-matched
  `python3-gi-cairo` foreign converter, and Gtk 3 / Atk typelibs. The doctor
  checks `gi.require_foreign("cairo")` before checking the Gtk / Atk
  typelibs; it does not initialize Gtk or open a display.
- `at-spi2-core`, including its registry / bus launcher, plus the GTK
  accessibility bridge (`libatk-adaptor`)
- XKB data at `/usr/share/X11/xkb` and `/usr/bin/xkbcomp` (this Debian Xvfb
  build has that helper path compiled in; the private overlay cannot replace it)
- `gpg`, `curl`, `xz`, `sha256sum`, `stat`, `dpkg-deb`, and `flock` for locked bootstrap
- `dbus-run-session`, `timeout`, and standard shell utilities

`doctor.sh` checks those prerequisites without starting a D-Bus session or a
GUI. It reports D-Bus capability only when explicitly invoked as
`doctor.sh --probe-dbus`; that option creates a short-lived private session
bus. The bootstrap does not obtain GTK, AT-SPI, Python, D-Bus, XKB data, or
their shared-library dependency closure, and it never changes host package
state. Missing host packages must be provisioned by the host owner using the
host distribution's normal process.

## Run the isolated fixture

```sh
native/linux/environment/run-fixture.sh
```

This performs the read-only doctor checks, then runs only
`native/linux/integration.py` and its repository-local GTK fixture inside a
private D-Bus session and Xvfb display with the repository's compositor helper.
The wrapper clears inherited Wayland and AT-SPI bus selectors so the fixture
cannot reuse the user's desktop display or accessibility bus. It does not
attach to the user's desktop. Each run gets a timestamped directory
under `test-results/native/linux/` by default, containing the integration
artifacts, a captured log, a bounded-timeout/exit summary, and hashes for the
exact observer, fixture, integration, compositor helper and environment lock
and runner scripts, plus the selected lock's digest. Set
`VLMKIT_LINUX_EVIDENCE_DIR` to move the output or
`VLMKIT_LINUX_TIMEOUT_SECONDS` to change the positive-integer timeout (default
180 seconds).

Pure observer/static tests remain separate from this live fixture:

```sh
python3 -m unittest discover -s native/linux -p 'test_*.py' -v
```

Passing those tests or the doctor is not evidence that the live D-Bus/Xvfb
fixture passed. Review the saved fixture report and exit status separately.
