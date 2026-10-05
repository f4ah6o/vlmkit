# Initial Linux X11 observer — 2026-10-05

Status: implementation in review; native live acceptance pending.

This slice introduces an external, read-only PID-attached composited X11/AT-SPI observer.
It does not implement physical or semantic actions, Wayland, XWayland admission,
Windows, process launch/termination, or private GPUI instrumentation. macOS source
routing and tests are retained. The separate macOS actions PR #2 is unchanged.

## Verification so far

- Linux admission plus existing macOS contract/transport tests: 21 passed; one
  opt-in live Linux client-to-judge test skipped locally.
- Focused TypeScript checking: passed (native transport, Linux tests, scan and gate).
- Native Python contract tests: 10 passed.
- Judge and core artifact-consumer builds: passed.
- Local native session smoke: blocked. The cloud workspace has no DISPLAY,
  WAYLAND_DISPLAY or desktop session bus; launching the installed Xorg dummy server
  failed to establish local listening sockets, including through the approved
  execution route. No live capture is claimed from that environment.
- `.github/workflows/linux-native-observer.yml` provisions an isolated Xvfb/D-Bus/xcompmgr
  GTK fixture lane and retains its actual selected-window tree/PNG/report. Its
  passing result must be recorded before claiming that profile's acceptance.
- Whole repository build and format check: blocked by an unchanged base error in
  `packages/vlmkit-ai/src/provenance.ts:102` (`readonly Array` is invalid TypeScript).
  The same bytes are present at base `4be3177a62d8a3304e1cb09958dc5deab92d7eff`.
  Therefore the complete package/CLI build, full suite and whole typecheck are not
  reported as passed. This PR does not silently repair or exempt the unrelated file.

The synthetic TypeScript capture test deliberately reuses a labelled synthetic
calibration PNG from the native contract fixtures. It proves metadata plumbing,
not Linux desktop observation. Only the hosted live fixture lane can supply the
initial X11 evidence; broader desktop/toolkit/scaling and real GPUI/MZed acceptance
remain separate gates in the [Linux packet](../../issues/open/20261005-linux-native-observer.md).

Independent review identified newly allocated Composite backing as potentially
containing occluder pixels. The implementation therefore requires an existing
compositor and named backing, refuses unavailable/changed compositor identity,
and never creates or removes window redirection. CI starts the compositor before
the fixture and retains the strict red-target/green-occluder pixel assertion.

## First hosted run

[Run 37249475873](https://github.com/f4ah6o/vlmkit/actions/runs/37249475873)
tested PR head `bbd61e933f1a6f298caade8e77ff2c8a940fa485` as synthetic merge
`fb8c035286729ac4f3c50faa62812fee31ed6c36`.

- Python contract tests passed; actual GTK/AT-SPI window enumeration/selection
  reached capture. Capture rejected the pixmap's color-mask metadata rather than
  guessing a pixel format. This is not a passing native observation.
- The transport job's Linux cases passed; five existing generic-judge cases failed
  because this new focused lane omitted the MoonBit CLI. The lane now installs
  the same pinned toolchain used locally before running those tests.
- [Format job](https://github.com/f4ah6o/vlmkit/actions/runs/37249475830/job/111573962564)
  independently confirmed the unchanged main provenance syntax/format failures.

Subsequent evidence must identify the repaired exact head; the first run is kept
as failure provenance, not relabelled as a successful fixture run.
