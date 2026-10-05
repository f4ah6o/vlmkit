# Initial Linux X11 observer — 2026-10-05

Status: bounded hosted X11 fixture acceptance PASS; broader support remains gated.
Broader desktop/toolkit, real GPUI/MZed and Wayland acceptance remain pending.

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


## Verified hosted acceptance

[Run 37249754224](https://github.com/f4ah6o/vlmkit/actions/runs/37249754224)
passed both `observer` and `transport` jobs for source head
`96249baad0b7e7c499f1f797db92bcd29a3d078c`, tested as synthetic PR merge
`6f97ce0966c314ff0537451e7f4f9123e1d8cef4` into base
`4be3177a62d8a3304e1cb09958dc5deab92d7eff`. This records observed evidence;
it does not imply the draft PR has merged.

Profile: Ubuntu 24.04.5 x86-64 hosted image `20260927.320.1`, Xvfb
`2:21.1.12-1ubuntu1.8`, xcompmgr `1.1.8-1`, AT-SPI core `2.52.0-1build1`,
GTK3 introspection `3.24.41-4ubuntu1.3`, Node `24.21.0`, pnpm `10.34.6`,
MoonBit compiler/core `0.10.14+7d59c7ec9`. Isolated 1280x1024 depth-24 X11
display; selected opaque undecorated GTK fixture client is 360x260 at scale 1.

Observed results:

- 11 Python contract tests passed.
- Live Python fixture passed all nine assertions: same-PID duplicate-title
  window association, stable toolkit identifier, client geometry, semantic-rect
  pixel alignment, foreign green occluder excluded from the red target capture,
  bounded traversal, selected-window binding, denied physical input, detach-only close.
- Complete capture: seven nodes, zero truncated branches, zero attribute errors.
- Actual TypeScript `runScanA11y` on a separate live GTK fixture and the unchanged
  generic judge passed, including detection of the planted unnamed button.
  The live job passed all nine Linux tests with no skip.
- Transport job passed 21 Linux/macOS tests; its one live-only test is intentionally
  skipped because the separate observer job owns the provisioned desktop.

[Retained tree/PNG/report artifact 11319932949](https://github.com/f4ah6o/vlmkit/actions/runs/37249754224/artifacts/11319932949):
10,700 bytes, SHA-256
`a0943d43829b8e9906be5aff03d7051945b96db9efb6696862f266387303ba25`.
Artifacts expire on 2026-10-19; the provenance and checked acceptance code remain.
This artifact contains only controlled fixture windows. Pixel assertions were
executed by the retained integration runner; no manual screenshot review is claimed.

This admits the named fixture observation profile only. It does not establish
physical input safety, compositor-independent Linux support, GTK/Qt application
coverage, accessibility in GPUI/MZed, HiDPI/fractional coordinates, or Wayland.
Whole-repository base-check failures still require their separate repair.

## Occlusion setup hardening

The earlier passing fixture created an overlapping foreign window, but did not
explicitly inspect its stacking. The maintained integration test now requires
both clients to be viewable direct-root siblings with identical geometry,
different PIDs, and the foreign window above the selected window in XQueryTree's
bottom-to-top order. It rechecks these facts immediately before and after target
capture and records them in `report.occlusion`. It also retains `foreign.png`
and verifies actual green foreign pixels at the exact semantic point where the
selected window must be red. A pure regression rejects absent, reversed and
nonoverlapping setups. Final acceptance should cite the strengthened run linked
from PR #3; earlier runs prove capture/alignment but do not independently prove
that adversarial stacking precondition.


## Repaired-main integration

After the separately reviewed base fixes #4/#5, main
`0f9eed6eca6f24afbb8318f556da3fceadca253a` passed all five main-push workflows,
including [full tests and typecheck](https://github.com/f4ah6o/vlmkit/actions/runs/37252449384).
The Linux branch integrates that main non-destructively, preserving the previously
accepted Linux source and fixture oracle. Earlier base syntax/format failures above
are historical diagnostics, not current merge exemptions.

The integrated head must pass the complete repository workflows (full tests,
typecheck, format, packaging and VRT), the native observer/transport workflow and
independent review before merge. PR #3 records exact integrated-head and post-merge
main run links. A previous native-only pass does not substitute for these gates.
