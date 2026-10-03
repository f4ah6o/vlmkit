# macOS accessibility observer

Requires macOS 14+, the Swift toolchain, and Accessibility and Screen Recording
permissions for `VLMKitNativeAgent`. The helper is a local stdio process, with no
network listener. It implements protocol 1 in
[the collector design](../../issues/open/20261003-macos-ax-collector-protocol.md).

Build the agent and deterministic AppKit fixture as app bundles:

```sh
./script/build_and_run.sh --build-only
# Build and launch the fixture (also the Codex Run action):
./script/build_and_run.sh
export VLMKIT_NATIVE_AGENT="$PWD/native/macos/dist/VLMKitNativeAgent.app/Contents/MacOS/VLMKitNativeAgent"
```

The build uses ad-hoc signing by default. Set `VLMKIT_NATIVE_SIGN_IDENTITY` to a
local signing identity for stable development signing. The bundle id is
`com.f4ah6o.vlmkit.native-agent`; rebuilding ad-hoc code can cause macOS privacy
permission churn. `doctor` reports the signing kind without certificate subjects.

Check permissions without prompting:

```sh
printf '%s\n' '{"id":1,"protocol":1,"method":"doctor","params":{"prompt":false}}' | "$VLMKIT_NATIVE_AGENT"
```

Set `prompt:true` in this explicit request to ask the OS for permission. Granting
permission may require restarting the helper. Neither a scan nor passive doctor
requests permission automatically.

```sh
pnpm build
node dist/vlmkit.mjs scan a11y macos:com.f4ah6o.vlmkit.ax-fixture --out .vlmkit/native.json
node dist/vlmkit.mjs scan a11y macos:/absolute/path/App.app --launch --window main --out .vlmkit/native.json
node dist/vlmkit.mjs scan a11y macos:pid=123 --window index=0 --out .vlmkit/native.json
node dist/vlmkit.mjs check a11y tree .vlmkit/native.json
```

`--launch` is explicit and applies only to bundle ids and app paths. A scan
always detaches, including from an app it launched. Protocol `session.close`
can terminate only an app that that session launched, and only when
`terminateIfLaunched:true` is explicitly supplied.

Default window selection uses a visible main window, then a visible focused
window, then a sole visible ordinary window. Multiple ordinary windows without
one main/focused window return `NATIVE_WINDOW_AMBIGUOUS`. AX/ScreenCaptureKit
association requires the target PID and matching geometry; title alone never
selects a window. Window ids belong to the current agent session, not future runs.

Coordinates use the **full selected window**, including title bar, without a
shadow. AX global top-left points minus the capture frame origin become
window-local logical points. PNG pixels equal logical points times `scale`.
The helper preserves native resolution, excludes the cursor and checks both
image dimensions within one pixel. A moved/resized window fails capture.
The CLI also checks the decoded PNG dimensions against the tree and result.

`--max-depth` (default 64) and `--max-nodes` (default 10000) bound a cycle-safe
traversal; each AX call has a two-second timeout. Unsupported optional attributes
are absent, other errors are counted. Native roles/subroles and stable identifiers
are preserved. Unknown actions are `ax:<action>`; only reported AXPress maps to
tap. Values never name editable controls; AXStaticText's scalar value is its
announced content. Verified AppKit checkbox values 0/1 map to checked false/true;
mixed values remain raw. Duplicate identifiers produce diagnostics, while
structural paths remain unique.

A partial capture still writes valid artifacts, and `scan a11y` reports
`native-incomplete` with truncation/error counts. Check this scan result before
using the generic tree gate: the generic format does not assert completeness.
Native scan does not accept `--click` or browser/dump-specific options.

Protocol v1 also exposes native interaction methods without opening a network listener:

- `hitTest`: maps window-local screenshot pixels through the capture scale/origin and resolves the
  exact AX element plus ancestors and a stable locator when available.
- `perform`: executes explicit semantic or physical actions. Semantic mode supports press, focus,
  and text-field value setting. Physical mode supports click, Unicode text/key input, and pixel
  scrolling through CoreGraphics events.
- stable-id, role/name, path and screenshot-point locators are explicit. Ambiguous role/name
  locators fail with `NATIVE_LOCATOR_AMBIGUOUS`; they are never acted on implicitly.
- optional `evidencePath` is JSONL. Typed text is redacted to `textLength`; action mode,
  resolved target, coordinates and locator are retained.

The TypeScript API `openNativeInteractionSession()` owns one target/window session and exposes
`hitTest()`, `perform()`, and idempotent `close()`. Physical and semantic action modes remain
distinct in both results and evidence.

Validation:

```sh
swift test --package-path native/macos
pnpm exec vp test run packages/vlmkit-markup/src/a11y-tree/native-agent.test.ts
# Explicitly opens only local fixture apps and captures only their windows:
node native/macos/script/integration.mjs
# Refresh live recordings after inspecting the fixture PNG:
node native/macos/script/integration.mjs --record
```

The integration runner checks passive doctor, attaching, window selection,
actual AX names/values/actions, checked and disabled state, duplicate identifiers,
PNG scale and Save pixel alignment, existing a11y judges, truncation, target
exit, and ambiguous windows. Permission denial is tested with injected passive
checks in Swift; the runner never revokes host permissions.

`fixtures/native/macos/{basic,retina-2x,duplicate-labels,truncated}` are explicitly
hand-written contract fixtures with synthetic calibration PNGs, not live AX
recordings. `recorded-2x` is actual fixture-only AX/ScreenCaptureKit output.
Native system chrome is included: AppKit's unnamed scrollbar and window controls
can produce generic name/target findings. Those findings are retained, not
silently filtered in a platform-specific judge.

Fixture options passed through `./script/build_and_run.sh`: `--two-windows`,
`--ambiguous` (two borderless ordinary windows), `--unchecked`, and
`--duplicate-identifiers`. The fixture has no network or animation.
