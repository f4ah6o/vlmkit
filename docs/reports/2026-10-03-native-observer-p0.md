# Native observer P0A/P0B acceptance — 2026-10-03

Implemented the optional native `A11yNode` metadata, a protocol-1 Swift observer,
deterministic AppKit fixture, and `scan a11y macos:` vertical slice. The observer
has no action execution or network service. Existing generic tree judges consume
its output unchanged.

## Environment and coordinate decision

Host: arm64, macOS 26.5.2 (25F84), Swift 6.3.3. Deployment minimum: macOS 14.
The ad-hoc-signed bundled observer's passive doctor reports Accessibility trust
and Screen Recording authorization granted, with an identity warning. No
permission prompt was requested in the live run.

The collector uses the **full window including title bar**, excluding shadows,
with top-left window-local logical points. This follows the detailed collector
protocol and refines the audit's earlier content-only wording. ScreenCaptureKit
returns a 1280×1024 PNG for a 640×512 logical-point window at scale 2.
The Save AX rect overlaps the actual Save fill/text pixels; an adjacent point
outside the control is white. `test-results/native/acceptance/overlay.svg` draws
the Save rectangle over the unmodified PNG.

## Validation

- `./script/build_and_run.sh --build-only`: both app bundles built and signed.
- `swift test --package-path native/macos`: 5 tests passed. Covers role preservation,
  coordinates with positive/negative global origins, scalar values, verified
  checkbox mapping, passive doctor without prompts, and dedicated permission
  denial errors using injected checks (host permissions were not revoked).
- `pnpm build`: passed.
- `pnpm typecheck`: passed.
- `pnpm fmt:check` and `git diff --check`: passed.
- Judge package, native contract/transport, gate registry and page-load suites:
  16 files, 194 tests passed. The native suite alone has 13 tests.
- Existing `flutterWebNodes` and `importUiautomatorDump` tests: 4 passed; includes
  the Android scan-to-generic-judge regression.
- `node native/macos/script/integration.mjs --record`: live fixture capture,
  generic judges, 2× geometry/pixels, bounded traversal, target termination,
  unchecked checkbox, duplicate identifier warning, and ambiguous ordinary
  windows passed. The final maintained-runner acceptance passed all six checks, including launch
  ownership when no fixture was already running; an independent live lifecycle run also verified
  app-path launch, PID attachment, that an attached session cannot terminate the
  app, and explicit termination by the session that launched it.
- Built `dist/vlmkit.mjs scan a11y` passed with bundle-id and app-path/`--launch`
  sources. A three-node CLI scan wrote valid artifacts, reported 12 truncated
  branches and zero attribute errors, emitted `native-incomplete`, and exited 1.
- Built `check a11y tree` reads the native output and returns the expected
  accessibility findings rather than a format or browser error.

The helper must keep the AppKit run loop active while stdio waits on a background
thread. A blocking main-thread `readLine` left NSRunningApplication exit state
stale in the live target-exit test. Initializing NSApplication also establishes
the WindowServer connection ScreenCaptureKit requires. Both are implemented. The integration runner waits for the actual fixture window
to become visible and associated with ScreenCaptureKit before attachment scans,
rather than treating the first AX window entry as capture readiness.

## Fixture provenance and limits

`fixtures/native/macos/recorded-2x/` contains actual AX and single-window
ScreenCaptureKit output of **only the local fixture**, inspected visually.
The other four fixture directories are labelled hand-written contract trees and
synthetic calibration PNGs. The exact pixel region is tested at 1× and 2×;
a physical live 1× display was not available in this run.

Native OS chrome remains in the tree: unnamed scrollbar/window controls can be
reported by generic naming and target-size judges. Expected recorded findings
retain these alongside the planted unnamed control. No platform-specific judge
exemptions were introduced. AXStaticText names are taken from its scalar content;
editable values stay values. AppKit checkbox values 0 and 1 were observed in live
on/off fixture captures before normalizing `checked`; mixed values remain raw.

Four live browser Flutter regressions were not verified: Playwright 1.63.0's
required Chromium binary was absent, and both full Chromium and headless-shell
installation attempts timed out at the download server. Pure Flutter mapping and
Android import regressions passed. No browser executable/version was substituted.

Completeness is reported by native scan, not asserted by the generic tree
format: callers must check `native-incomplete` before consuming partial files.
A transient ScreenCaptureKit -3811 capture failure was surfaced as
`NATIVE_SCREENSHOT_FAILED`; a subsequent serial capture passed. The helper
retains the dedicated error rather than pretending that a screenshot succeeded.

Later GPUI acceptance, native actions/grounding, VRT, interactions, and flow
remain in the parent design's later phases.
