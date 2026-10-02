# macOS AX collector protocol and fixture contract

Status: design / open  
Date: 2026-10-03  
Parent: `issues/open/20261003-native-ui-boundary-audit.md`

## Purpose

Specify the first implementation packet for macOS native observation.

This packet is intentionally observer-first:

- no click/type implementation;
- no generic cross-platform driver framework;
- no native `check interactions`;
- no native flow runner.

The deliverable is a reproducible macOS collector that emits:

1. a `vlmkit-a11y/1` accessibility tree;
2. a PNG of the same selected window;
3. enough metadata to prove coordinate alignment;
4. deterministic diagnostics for permissions, target selection, and AX failures.

## Runtime shape

Use a local macOS agent controlled by the Node/TypeScript CLI over stdio.

```text
vlmkit TypeScript
   |
   | NDJSON request/response
   v
VLMKitNativeAgent.app/Contents/MacOS/VLMKitNativeAgent
   |
   +-- AXUIElement / ApplicationServices
   +-- ScreenCaptureKit
   +-- CoreGraphics permission preflight
```

The agent is not a network service.

The executable may be built with SwiftPM, but the normal local artifact should be an app bundle with a stable bundle identifier so macOS privacy authorization has a stable identity.

Proposed bundle identifier:

```text
com.f4ah6o.vlmkit.native-agent
```

Do not require a particular signing identity in the protocol contract.

However `doctor` must expose signing/identity diagnostics because Screen Recording authorization can be tied to code-signing identity and repeated ad-hoc rebuilds can cause permission churn on current macOS.

Reference:

- https://developer.apple.com/forums/thread/819406

## Supported macOS APIs

### Accessibility

Use public AXUIElement APIs.

Relevant documented APIs/attributes include:

- `AXUIElementCreateApplication(pid)`;
- `AXUIElementCopyAttributeValue`;
- `AXUIElementCopyMultipleAttributeValues`;
- `AXUIElementCopyActionNames`;
- `AXUIElementCopyElementAtPosition` for later grounding;
- `AXIsProcessTrustedWithOptions` for Accessibility trust.

References:

- https://developer.apple.com/documentation/applicationservices/axuielement_h
- https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions

### Screenshot

Use ScreenCaptureKit.

For a one-frame capture, prefer `SCScreenshotManager.captureImage` when available on the deployment target.

For window enumeration use `SCShareableContent`.

Configure single-window capture with shadows excluded so the PNG coordinate origin aligns with the window bounds rather than an outer shadow extent.

References:

- https://developer.apple.com/documentation/screencapturekit/scshareablecontent
- https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager
- https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/ignoreshadowssinglewindow

The minimum supported macOS version remains an implementation decision. If the chosen minimum predates the preferred one-frame API, provide an internal ScreenCaptureKit fallback rather than changing the protocol.

## Permission checks

### Accessibility

Passive check:

```text
AXIsProcessTrustedWithOptions(nil)
```

The default `doctor` command must not prompt.

A separate explicit opt-in mode may request the system prompt using `kAXTrustedCheckOptionPrompt`.

### Screen capture

Passive preflight should use the documented Screen Recording authorization API rather than inferring permission from missing window metadata.

Use:

```text
CGPreflightScreenCaptureAccess()
```

An explicit opt-in request may use the corresponding request API.

For enumeration, use `SCShareableContent`.

Do not inspect the TCC database.

Reference:

- https://developer.apple.com/forums/thread/839069

## Agent protocol v1

Transport: newline-delimited UTF-8 JSON over stdin/stdout.

stdout is protocol-only. Human diagnostics go to stderr.

Each request has:

```ts
interface Request<T> {
  id: number;
  protocol: 1;
  method: string;
  params: T;
}
```

Each response is exactly one of:

```ts
interface Success<T> {
  id: number;
  ok: true;
  result: T;
}

interface Failure {
  id: number;
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
```

No unsolicited stdout events in protocol v1.

If live event streaming is needed later, version it explicitly.

## Protocol methods in P0B

### `hello`

Request:

```json
{"id":1,"protocol":1,"method":"hello","params":{}}
```

Response result:

```ts
interface HelloResult {
  protocol: 1;
  agentVersion: string;
  bundleId: string;
  macOSVersion: string;
  arch: "arm64" | "x86_64";
  capabilities: {
    accessibility: boolean;
    screenCapture: boolean;
    singleFrameCapture: boolean;
  };
  build: {
    signed: boolean;
    signingKind: "development" | "distribution" | "adhoc" | "unsigned" | "unknown";
  };
}
```

Do not expose certificate subject material unless required diagnostically.

### `doctor`

Request:

```json
{"id":2,"protocol":1,"method":"doctor","params":{"prompt":false}}
```

Result:

```ts
interface DoctorResult {
  accessibility: {
    trusted: boolean;
  };
  screenCapture: {
    authorized: boolean;
  };
  agent: {
    bundleId: string;
    signed: boolean;
    signingKind: string;
  };
  checks: Array<{
    id: string;
    status: "pass" | "fail" | "warn";
    message: string;
  }>;
}
```

Rules:

- no permission prompt when `prompt=false`;
- missing Accessibility permission is a FAIL;
- missing Screen Recording permission is a FAIL for screenshot capture;
- ad-hoc/unsigned identity is a WARN, not an automatic failure;
- do not claim a permission is granted merely because an API call happened to return data.

### `target.open`

Target union:

```ts
type MacTarget =
  | { by: "pid"; pid: number }
  | { by: "bundle-id"; bundleId: string; launchIfNeeded?: boolean }
  | { by: "app-path"; appPath: string; launchIfNeeded?: boolean };
```

Result:

```ts
interface TargetResult {
  sessionId: string;
  pid: number;
  bundleId?: string;
  appPath?: string;
  launched: boolean;
}
```

`sessionId` is opaque and valid only for the life of the agent process.

### `window.list`

Result:

```ts
interface WindowInfo {
  windowId: string;
  title?: string;
  axPath: string;
  frameGlobalPoints: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  focused: boolean;
  main: boolean;
  minimized?: boolean;
  onScreen?: boolean;
  screenCaptureWindowId?: number;
}
```

Window association must use PID plus geometry/title checks when correlating AX windows with ScreenCaptureKit windows.

Never select a window solely by title because titles may be duplicated or localized.

### `window.select`

Selector:

```ts
type WindowSelector =
  | { by: "window-id"; windowId: string }
  | { by: "main" }
  | { by: "focused" }
  | { by: "index"; index: number };
```

Default selection order when no explicit selector is supplied:

1. AX main window if valid and visible;
2. AX focused window if valid and visible;
3. only visible non-minimized application window;
4. otherwise fail with `NATIVE_WINDOW_AMBIGUOUS`.

Never silently pick the first of several ordinary windows.

### `snapshot.capture`

Request:

```ts
interface CaptureRequest {
  sessionId: string;
  windowId: string;
  outputTreePath: string;
  outputPngPath: string;
  maxDepth?: number;
  maxNodes?: number;
}
```

Result:

```ts
interface CaptureResult {
  treePath: string;
  pngPath: string;

  viewport: {
    width: number;
    height: number;
  };

  framePixels: {
    width: number;
    height: number;
  };

  scale: number;

  counts: {
    nodes: number;
    truncated: number;
    attributeErrors: number;
  };

  transform: {
    globalWindowOriginPoints: { x: number; y: number };
    logicalToPixelScale: number;
  };
}
```

The JSON tree written at `treePath` is the existing `vlmkit-a11y/1` format.

### `session.close`

Detach/terminate policy is explicit:

```ts
interface CloseRequest {
  sessionId: string;
  terminateIfLaunched?: boolean;
}
```

Default: detach only.

A collector must never terminate an already-running user application by default.

## Protocol errors

P0B error codes:

- `NATIVE_PROTOCOL_MISMATCH`
- `NATIVE_PERMISSION_ACCESSIBILITY`
- `NATIVE_PERMISSION_SCREEN_CAPTURE`
- `NATIVE_TARGET_NOT_FOUND`
- `NATIVE_TARGET_AMBIGUOUS`
- `NATIVE_TARGET_EXITED`
- `NATIVE_WINDOW_NOT_FOUND`
- `NATIVE_WINDOW_AMBIGUOUS`
- `NATIVE_AX_CANNOT_COMPLETE`
- `NATIVE_AX_TIMEOUT`
- `NATIVE_AX_TRUNCATED`
- `NATIVE_SCREENSHOT_FAILED`
- `NATIVE_COORDINATE_MISMATCH`
- `NATIVE_OUTPUT_WRITE_FAILED`

Unexpected Swift errors must be wrapped in a stable outer code plus a diagnostic detail string.

## `vlmkit-a11y/1` native extensions

Extend the TypeScript interface with optional fields:

```ts
interface A11yNode {
  // existing contract...

  /** Stable platform accessibility identifier when exposed. */
  identifier?: string;

  /** Original platform role before VLMKit normalization. */
  platformRole?: string;

  /** Original platform subrole before VLMKit normalization. */
  platformSubrole?: string;
}
```

No format bump in P0A because:

- existing required field meanings are unchanged;
- parser already ignores unknown optional fields;
- existing consumers do not need the extensions.

A future format bump is required if coordinate semantics, required fields, or node meaning changes.

## AX attribute collection

Read attributes defensively.

Core attributes:

- `kAXIdentifierAttribute`;
- `kAXRoleAttribute`;
- `kAXSubroleAttribute`;
- `kAXTitleAttribute`;
- `kAXDescriptionAttribute`;
- `kAXValueAttribute`;
- `kAXPositionAttribute`;
- `kAXSizeAttribute`;
- `kAXEnabledAttribute`;
- `kAXFocusedAttribute`;
- `kAXSelectedAttribute`;
- `kAXExpandedAttribute`;
- `kAXChildrenAttribute`.

References:

- https://developer.apple.com/documentation/applicationservices/carbon_accessibility/attributes
- https://developer.apple.com/documentation/applicationservices/kaxidentifierattribute
- https://developer.apple.com/documentation/applicationservices/kaxpositionattribute

Not every role supports every attribute.

Rules:

- unsupported attribute is not an error;
- `kAXErrorCannotComplete` is a diagnostic and may become a retryable traversal error;
- one bad optional attribute must not discard the node;
- missing role or invalid geometry on a visible actionable node is diagnostically significant;
- traversal is bounded and cycle-safe.

## Initial role normalization

Table-driven mapping:

| macOS role/subrole | VLMKit role |
| --- | --- |
| AXButton | button |
| AXLink | link |
| AXTextField | textfield |
| AXTextArea | textfield |
| AXCheckBox | checkbox |
| AXRadioButton | radio |
| AXSlider | slider |
| AXTab | tab |
| AXMenuItem | menuitem |
| AXPopUpButton | combobox |
| AXComboBox | combobox |
| AXStaticText | text |
| AXImage | image |
| AXGroup | group |
| AXList | list |
| AXRow under list-like parent | listitem |
| AXScrollArea | scrollview |
| AXWindow | window |
| AXWindow + dialog-like subrole | dialog |

Unknown roles:

- retain the native role string as `role`;
- never drop an element just because VLMKit has no normalized role;
- preserve `platformRole` / `platformSubrole`.

The table must be fixture-tested against actual AX output before being considered stable.

## Accessible name normalization

Do not use `AXValue` as a control name for editable/value controls.

Initial precedence:

1. non-empty `AXTitle`;
2. title UI element text when available;
3. non-empty `AXDescription`;
4. empty/undefined.

`AXHelp` is not the primary name.

For role-specific exceptions, add explicit table-driven rules with fixture evidence.

Do not infer a visible label from nearby OCR in the collector. Screenshot/VLM reasoning belongs downstream.

## Value normalization

Value belongs in `A11yNode.value`.

Convert only deterministic scalar forms:

- string -> string;
- number -> decimal string;
- boolean -> `"true"` / `"false"`.

Complex AX values remain absent from v0 output unless a stable serialization is designed.

## State normalization

| AX observation | VLMKit state |
| --- | --- |
| AXEnabled=false | disabled=true |
| AXFocused=true | focused=true |
| AXSelected=true | selected=true |
| AXExpanded=true | expanded=true |

Checkbox/switch checked-state mapping must be verified against fixture output before hard-coding because native controls may expose state through role-specific value semantics.

Until verified:

- preserve the raw scalar as `value`;
- only populate `checked` from a tested mapping.

## Action normalization

The generic judge currently treats `tap`, `setText`, and `longPress` as evidence of interactivity in addition to normalized interactive roles.

Initial mapping:

- AXPress -> `tap`;
- editable/settable text value -> `setText`;
- scroll-capable node -> `scroll`;
- increment/decrement actions -> `increment` / `decrement`;
- unknown AX actions -> `ax:<native-action>`.

Do not fabricate `tap` merely because a node has a button-like role if AX does not report a press action. The normalized role is already sufficient for `isInteractive`.

## Path generation

`A11yNode.path` is unique structural identity for the captured tree, not the stable automation identifier.

Generate path segments from normalized role plus sibling ordinal:

```text
window[0]>group[0]>button[2]
```

Rules:

- ordinal is derived from the complete traversed child list before filtering;
- path is unique in one snapshot;
- path may change when structure changes;
- `identifier` is the durable locator when present;
- duplicate non-empty identifiers within one selected window emit a diagnostic warning.

Do not put localized names into `path`.

## Coordinate contract

Apple documents `kAXPositionAttribute` in global screen coordinates with origin at the top-left of the menu-bar display.

Persisted VLMKit coordinates must not be global.

For the selected capture window:

```text
AX global point
  - selected window capture-frame origin
  = window-local logical point
```

Persist:

- `viewport.width/height`: captured single-window bounds in logical points;
- `node.rect`: window-local logical points;
- origin: top-left;
- `scale`: PNG pixels per logical point.

ScreenCaptureKit single-window capture uses the window's full bounds. Configure capture to ignore shadows.

This gives the invariant:

```text
pngX = round(node.rect.left * scale)
pngY = round(node.rect.top  * scale)
```

subject only to explicit rounding rules.

References:

- https://developer.apple.com/documentation/applicationservices/kaxpositionattribute
- https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/sourcerect
- https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/ignoreshadowssinglewindow

## Coordinate self-check

Every capture runs a cheap consistency check:

```text
expectedPixelWidth  ~= viewport.width  * scale
expectedPixelHeight ~= viewport.height * scale
```

Tolerance: at most 1 pixel per edge due to integer rounding.

If the invariant fails beyond tolerance:

- still write diagnostic metadata if safe;
- fail the capture with `NATIVE_COORDINATE_MISMATCH`;
- do not feed the artifacts to semantic/visual gates as if they were aligned.

## Screenshot settings

P0B deterministic defaults:

- single selected window only;
- cursor hidden;
- shadow excluded;
- no arbitrary resizing/downscaling in the native agent;
- preserve native capture resolution;
- PNG output.

Any later model-resolution downscale remains a VLMKit post-process, as in browser grounding.

## Traversal bounds

Defaults:

```text
maxDepth = 64
maxNodes = 10000
perAXCallTimeout = bounded
```

Exact timeout value remains implementation-tuned.

When truncated:

- tree remains syntactically valid;
- capture result reports `truncated > 0`;
- CLI must not describe the tree as complete;
- a gate that depends on completeness may fail or explicitly degrade.

## Fixture application

Create one tiny deterministic AppKit fixture before GPUI.

Reason: the first test must distinguish VLMKit/AX bugs from GPUI accessibility exposure issues.

Fixture controls:

- named button with identifier `fixture.save`;
- unnamed button;
- editable text field with identifier `fixture.name`;
- checkbox;
- disabled button;
- scroll view with one offscreen control;
- duplicate-label buttons with distinct identifiers;
- modal/dialog trigger;
- optional second window for ambiguity tests.

Fixture requirements:

- fixed window size;
- deterministic positions;
- no animation;
- local-only data;
- no network;
- no font downloads.

## Recorded fixture artifacts

Commit normalized recorded fixtures for pure tests:

```text
fixtures/native/macos/
  basic/
    a11y.json
    frame.png
    expected.json
  retina-2x/
    a11y.json
    frame.png
    expected.json
  duplicate-labels/
    a11y.json
    expected.json
  truncated/
    a11y.json
    expected.json
```

Do not commit screenshots containing user or developer desktop content.

## P0A tests

Pure TypeScript tests:

- parser accepts native optional metadata;
- parser still rejects duplicate paths;
- unknown AX role survives as a string role;
- native action normalization influences `isInteractive` only as specified;
- node rect -> PNG crop math passes at 1x and 2x;
- existing `check a11y tree` findings remain unchanged for existing Flutter/Android fixtures;
- native fixture produces expected unlabelled/offscreen/touch findings.

## P0B integration tests

On a provisioned macOS host:

1. `hello` returns protocol 1;
2. `doctor(prompt=false)` never triggers a permission request;
3. attach by bundle id;
4. list windows;
5. default window selection works for one-window fixture;
6. two ordinary windows produce ambiguity;
7. capture writes a valid tree and PNG;
8. `frame width / viewport width == scale` within tolerance;
9. known `fixture.save` rect overlays its pixels;
10. terminated target yields `NATIVE_TARGET_EXITED`;
11. missing Accessibility permission produces the dedicated error;
12. missing Screen Recording permission produces the dedicated error.

## GPUI follow-up acceptance

After the AppKit fixture is green, run the same observer path against GPUI.

The GPUI acceptance question is narrow:

```text
Does GPUI expose enough AX semantics, including stable identifier,
role/name/bounds/actions, for the generic macOS collector?
```

If yes, VLMKit remains GPUI-agnostic.

If no, fix the GPUI/gpui.mbt accessibility exposure rather than adding GPUI-specific private hooks to VLMKit.

## Implementation packet after this design

The first code packet should stop after:

- A11yNode optional native metadata;
- Swift agent hello/doctor/open/window/capture;
- AppKit fixture;
- CLI native scan;
- existing `check a11y tree` against generated artifacts;
- coordinate overlay acceptance.

Do not include native click, typing, grounding replay, interactions, or flow in that same packet.
