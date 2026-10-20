# Native UI black-box driver for VLMKit

Status: design / open  
Date: 2026-10-03  
Scope: this fork only; no upstream contribution or upstream API compatibility requirement

## Goal

Extend this VLMKit fork from browser-first verification to black-box verification of native desktop UI, starting with macOS and GPUI applications.

The native path must validate a built application from outside the process. It must not require MoonBit support in VLMKit, GPUI-specific test hooks, DOM emulation, or application source instrumentation.

The target end state is:

- launch or attach to a native macOS application;
- discover its windows;
- capture a selected application window as PNG;
- obtain its accessibility/semantic tree;
- locate elements by stable accessibility identity when available;
- hit-test screenshot coordinates against native UI elements;
- perform semantic and physical interactions;
- feed the resulting PNG, semantic tree, bounds, and interaction evidence into existing VLMKit gates;
- run deterministic snapshot/diff/a11y/grounding/interaction checks against GPUI applications;
- keep all runtime components in this fork, with no required Appium server.

## Non-goals

For the first production-ready native path:

- no upstreaming to `mizchi/vlmkit`;
- no requirement to preserve a generic public API suitable for upstream;
- no MoonBit implementation of VLMKit;
- no application-internal GPUI test API;
- no browser DOM compatibility layer for native UI;
- no iOS/Android support;
- the original macOS milestone remains bounded; Linux now has its own first-class
  [observer and admission packet](20261005-linux-native-observer.md);
- no required Appium dependency;
- no remote-control daemon listening on a network socket;
- no NPM publication requirement for new fork-only packages.

Linux AT-SPI is a first-class implementation target with separately admitted X11 and
Wayland profiles. Windows UI Automation remains deferred until higher-priority
macOS/Linux work is exhausted and the user supplies a Windows work environment.
The common protocol must preserve honest platform capability boundaries.

## Current repository constraints

The existing repository already separates reusable verification logic from capture infrastructure:

- `@mizchi/vlmkit-core` contains image diff, a11y semantic types, VRT types, and related deterministic primitives.
- `@mizchi/vlmkit-capture` owns browser capture and currently exposes a `CaptureBackend` that launches a Playwright `Browser`.
- `CaptureBackend` selects between local Chromium and Cloudflare CDP. It is intentionally browser-shaped and should not be stretched into a native driver.
- `A11yNode` / `A11ySnapshot` in core are already close to a transport-neutral semantic representation, but do not carry the full native geometry/action/locator information required for interaction and grounding.
- several lower-level modules still load Playwright directly, so native support should enter above those browser-specific implementations rather than pretending that a native application is a `Page`.

This suggests introducing a new surface/session abstraction next to browser capture, not replacing `CaptureBackend`.

## Architecture decision

Use a two-layer native implementation:

```text
VLMKit CLI / gates
        |
        v
SurfaceDriver / SurfaceSession
        |
        +---------------- browser adapter ---------------- Playwright
        |
        +---------------- macOS native adapter ----------- stdio JSON-RPC
                                                            |
                                                            v
                                                   vlmkit-native-macos
                                                   Swift executable
                                                   - AXUIElement
                                                   - ScreenCaptureKit
                                                   - CGEvent
```

The Swift process is a local sidecar shipped and built from this repository.

Appium Mac2 may be used as a development/reference oracle while implementing the driver, but is not part of the production runtime dependency graph. Mac2 is useful because it is an existing black-box macOS automation implementation built on XCTest/WebDriverAgentMac, and therefore gives us an independent behavior reference.

References:

- Apple AXUIElement: https://developer.apple.com/documentation/applicationservices/axuielement_h
- Apple ScreenCaptureKit: https://developer.apple.com/documentation/screencapturekit
- Appium Mac2 overview: https://appium.github.io/appium-mac2-driver/latest/overview/

## Repository layout

Proposed fork-only layout:

```text
packages/
  vlmkit-native/
    src/
      protocol.ts
      driver.ts
      session.ts
      target.ts
      normalize.ts
      locator.ts
      coordinate-space.ts
      artifacts.ts

native/
  macos-agent/
    Package.swift
    Sources/
      VLMKitNativeAgent/
        Main.swift
        Protocol.swift
        ApplicationTarget.swift
        Accessibility.swift
        AccessibilitySnapshot.swift
        Screenshot.swift
        Input.swift
        HitTest.swift
        Permissions.swift
        WindowRegistry.swift
```

`packages/vlmkit-native` is the TypeScript client and shared native protocol model.

`native/macos-agent` is intentionally outside the pnpm package tree. It is a SwiftPM executable invoked locally over stdio.

Do not initially rename the existing `@mizchi/*` workspace packages. This fork is a validation repository, not a republishing exercise. Fork-only package naming can be revisited only if publication becomes a requirement.

## Surface abstraction

Do not expose Playwright `Page`, `Locator`, or native AX objects above the driver boundary.

Suggested TypeScript shape:

```ts
export type SurfaceTarget =
  | { kind: "web"; url: string }
  | {
      kind: "native";
      platform: "macos";
      appPath?: string;
      bundleId?: string;
      pid?: number;
    };

export interface SurfaceDriver {
  readonly kind: "playwright" | "macos";
  open(target: SurfaceTarget): Promise<SurfaceSession>;
}

export interface SurfaceSession {
  capabilities(): Promise<SurfaceCapabilities>;
  windows(): Promise<SurfaceWindow[]>;
  selectWindow(target: WindowTarget): Promise<void>;

  screenshot(options?: ScreenshotOptions): Promise<SurfaceScreenshot>;
  snapshot(): Promise<SurfaceSnapshot>;
  hitTest(point: ScreenshotPoint): Promise<SurfaceHit>;

  perform(action: SurfaceAction): Promise<ActionResult>;
  close(): Promise<void>;
}
```

The common abstraction should model observable UI behavior, not browser concepts.

## Semantic model

Do not immediately overload `A11yNode` with platform-only fields.

Introduce a richer `SurfaceNode` and provide a deterministic projection into the existing `A11yNode` so current a11y gates remain reusable.

```ts
export interface SurfaceNode {
  nodeId: string;             // ephemeral for one snapshot
  stableId?: string;          // AXIdentifier when available

  role?: string;
  subrole?: string;
  name?: string;
  description?: string;
  value?: string;

  bounds?: SurfaceRect;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  expanded?: boolean;
  checked?: boolean | "mixed";

  actions: string[];
  attributes: Record<string, string | number | boolean | null>;

  children: SurfaceNode[];
}
```

Rules:

- `nodeId` is never persisted across snapshots.
- `stableId` is preferred for durable locators.
- role/name/path locators are fallback mechanisms, not stable identity.
- raw AX attribute names may be preserved in diagnostic metadata, but normalized fields drive gates.
- a snapshot must include application/window identity and coordinate metadata.

## GPUI contract

GPUI applications should be treated as ordinary native applications from VLMKit's point of view.

The preferred testability contract is:

```text
GPUI element identity
        |
        v
AccessKit/native accessibility identity
        |
        v
macOS AXIdentifier
        |
        v
SurfaceNode.stableId
```

For gpui.mbt, stable accessibility identifiers should therefore be a first-class requirement even if the underlying GPUI API needs adaptation.

Example desired application-side semantics:

```text
button
  id: "save"
  accessibility-id: "toolbar.save"
  role: button
  label: "Save"
```

VLMKit must still work when no stable identifier exists, but reports should explicitly downgrade locator confidence.

## macOS sidecar responsibilities

### Application lifecycle

Support:

- launch by `.app` path;
- attach by bundle identifier;
- attach by PID;
- detect process exit;
- list windows belonging to the selected application;
- select a deterministic primary window or require explicit selection when ambiguous.

The sidecar must not execute arbitrary shell commands supplied by the client.

### Accessibility observation

Use macOS Accessibility APIs through `AXUIElement`.

Minimum observations:

- role and subrole;
- title/name/description;
- identifier when exposed;
- value;
- enabled/focused/selected/expanded/checked-like state when available;
- position and size;
- children;
- supported actions;
- owning PID.

Traversal requirements:

- bounded node count;
- bounded depth;
- cycle detection;
- per-call timeout;
- deterministic child ordering;
- explicit representation of unsupported/timed-out attributes rather than silent omission when diagnostically important.

### Screenshot capture

Use ScreenCaptureKit for window capture.

The capture result must contain:

```ts
interface SurfaceScreenshot {
  path: string;
  widthPx: number;
  heightPx: number;
  scaleFactor: number;
  windowId: string;
  capturedAt: string;
  transform: CoordinateTransform;
}
```

PNG bytes should not be base64-encoded in JSON for the normal path. The local sidecar writes an artifact file and returns metadata/path.

### Input

Two interaction modes are required.

#### semantic mode

Prefer native accessibility actions where the intent is semantic:

- press/activate;
- focus;
- set value where explicitly requested and supported;
- increment/decrement;
- select.

#### physical mode

Use native input events where the test is intended to exercise physical interaction:

- click at screenshot coordinate;
- mouse move;
- drag;
- scroll;
- key down/up;
- text typing.

Do not silently substitute semantic activation for a requested physical click. The result must record which interaction path actually ran.

For keyboard synthesis, use the current `CGEventCreateKeyboardEvent` family rather than deprecated keyboard-posting APIs.

### Hit testing

Provide native equivalent of browser grounding:

```text
screenshot pixel
      |
      v
coordinate transform
      |
      v
macOS screen point
      |
      v
AXUIElementCopyElementAtPosition
      |
      v
SurfaceHit
```

`SurfaceHit` should include:

- input screenshot coordinates;
- converted logical/screen coordinates;
- resolved node;
- ancestor chain;
- confidence / exactness;
- whether the node is actionable;
- stable locator if available.

This enables `check grounding` to remain meaningful for native applications.

## Coordinate-space contract

Coordinate handling is a P0 requirement, not an implementation detail.

Native macOS testing mixes:

- screenshot pixels;
- Cocoa/AX logical points;
- global screen coordinates;
- window-local coordinates;
- Retina/non-Retina scale factors;
- multiple display origins.

Define one canonical public coordinate space:

- screenshots: window-local physical pixels, origin top-left;
- semantic bounds: window-local logical points, origin top-left;
- every screenshot includes an explicit logical-to-pixel transform;
- hit-testing and physical input conversions go through one tested transform module;
- no gate performs ad-hoc scale multiplication.

Required fixtures:

- 1x display;
- 2x Retina display;
- non-zero global display origin;
- window moved between displays;
- cropped/titlebar-inclusive capture behavior explicitly fixed by contract.

## Protocol

Use versioned line-delimited JSON-RPC-like messages over stdin/stdout.

No TCP listener is required.

Handshake:

```json
{"id":1,"method":"hello","params":{"protocolVersion":1}}
```

Response includes:

- protocol version;
- agent build/version;
- macOS version;
- capability flags;
- permission state.

Initial methods:

- `hello`
- `doctor`
- `launch`
- `attach`
- `windows`
- `selectWindow`
- `snapshot`
- `screenshot`
- `hitTest`
- `perform`
- `close`

Protocol rules:

- every request has an id;
- errors have machine-readable codes;
- methods have explicit timeouts;
- stdout is protocol-only;
- diagnostics go to stderr;
- unknown fields are ignored within the same major protocol;
- unknown methods fail explicitly;
- screenshot/artifact payloads use file references, not inline large binary blobs.

## Permission model

Native verification requires macOS privacy permissions.

`vlmkit native doctor` should report at least:

- Accessibility permission;
- Screen Recording / capture permission;
- selected app existence;
- sidecar executable/build availability;
- whether semantic observation works;
- whether screenshot capture works;
- whether physical input is available.

A failed permission must produce a dedicated fix message and non-zero exit, not a generic timeout.

The tool must not attempt to bypass TCC or modify protected privacy databases.

## CLI shape

Do not reuse `--backend` for native selection. It already means browser capture backend (`local`, `cloudflare-cdp`).

Introduce a separate driver/target concept.

Candidate UX:

```bash
vlmkit native doctor

vlmkit check integrity   --driver macos   --app ./fixtures/gpui-demo.app

vlmkit snapshot   --driver macos   --bundle-id com.example.gpui-demo   --output .vlmkit/snapshots

vlmkit check grounding   --driver macos   --bundle-id com.example.gpui-demo   --mark

vlmkit verify flow   --driver macos   --app ./fixtures/gpui-demo.app   --flow flows/native-save.json
```

The exact parser can change during implementation, but `browser backend` and `surface driver` must remain distinct concepts.

## Gate reuse matrix

### Reuse directly after native capture

- PNG diff / VRT;
- heatmap regions;
- visual semantic diff;
- image resizing/cropping;
- screenshot-based VLM judgement;
- snapshot history;
- artifact/report generation.

### Reuse through SurfaceNode -> A11yNode projection

- a11y tree diff;
- role/name presence;
- landmark-like semantic checks where roles map cleanly;
- interactive element labelling checks.

### Adapt with native implementation

- grounding;
- interactions;
- focus order;
- flow execution;
- element attribution;
- touch/click target geometry.

### Browser-only unless separately generalized

- DOM/CSS authored/computed-style checks;
- responsive CSS breakpoint discovery;
- selector healing;
- DOM equivalence;
- browser handler scans.

Native mode must report these as unsupported capabilities rather than pretending they passed.

## Capability negotiation

Every gate declares required capabilities.

Example:

```ts
type SurfaceCapability =
  | "screenshot"
  | "semantic-tree"
  | "stable-id"
  | "hit-test"
  | "semantic-action"
  | "physical-pointer"
  | "physical-keyboard"
  | "focus"
  | "window-management"
  | "dom"
  | "computed-style";
```

A gate has one of three outcomes before execution:

- supported: run normally;
- degraded: run a documented reduced check and report degradation;
- unsupported: fail/skip according to explicit CLI policy.

No native gate should accidentally inherit a browser assumption because a method happened to be absent.

## Locator model

Use explicit locator types:

```ts
type SurfaceLocator =
  | { by: "stable-id"; value: string }
  | { by: "role-name"; role: string; name: string; nth?: number }
  | { by: "path"; value: string }
  | { by: "point"; xPx: number; yPx: number };
```

Resolution returns evidence:

- matched node;
- number of candidates;
- confidence;
- fallback path used;
- screenshot bounds;
- stableId if discovered.

Ambiguous locators are errors by default for actions.

## Artifact schema

Native runs should persist enough evidence to debug failures without rerunning the application.

Suggested run directory:

```text
.vlmkit/runs/<run-id>/
  manifest.json
  doctor.json
  app.json
  windows.json
  snapshot.json
  screenshot.png
  grounding.json
  actions.jsonl
  stderr.log
```

Do not persist arbitrary full accessibility attribute dumps by default if they may contain sensitive application data. Keep a normalized tree and allow opt-in diagnostics.

## Security boundaries

Because this tool can inspect and control native applications:

- sidecar communication is stdio-only by default;
- scope actions to the attached PID/application;
- reject actions targeting unrelated processes;
- never provide arbitrary shell execution through the protocol;
- redact environment variables from reports;
- do not log typed secrets by default;
- make screenshot/tree artifact retention explicit and configurable;
- include the target bundle/PID in every action record;
- physical global input must be guarded by an attached-window check.

## Appium role

Appium Mac2 is not the runtime architecture.

It may be used in development for:

- comparing discovered windows/elements;
- cross-checking element roles/names;
- validating activation/click semantics;
- diagnosing whether a problem is in the application accessibility tree or our sidecar.

Any Appium comparison tests must be optional and not required for ordinary `vlmkit` execution.

## Implementation milestones

### P0 — contracts and fixtures

Deliver:

- `SurfaceTarget`, `SurfaceCapabilities`, `SurfaceNode`, coordinate types;
- protocol v1 document/schema;
- recorded fixture snapshots for protocol/unit tests;
- capability-to-gate matrix;
- no native process control yet.

Acceptance:

- TypeScript types compile;
- protocol fixture parser tests pass;
- browser behavior remains unchanged.

### P1 — observer-only macOS driver

Deliver:

- SwiftPM sidecar;
- doctor;
- attach/launch;
- window listing/selection;
- AX semantic snapshot;
- window PNG screenshot;
- coordinate transform metadata.

Acceptance:

- attach to a deterministic local fixture app;
- one command emits both `snapshot.json` and `screenshot.png`;
- bounds in the semantic tree overlay the screenshot correctly on 2x Retina;
- missing permissions produce actionable dedicated errors.

### P2 — hit testing and actions

Deliver:

- hitTest;
- semantic press/focus;
- physical click;
- keyboard/text input;
- scroll;
- action evidence log.

Acceptance:

- click a fixture button by screenshot coordinate;
- resolved hit-test node matches the semantic target;
- physical and semantic action modes are distinguishable in artifacts;
- wrong/ambiguous locator does not silently act.

### P3 — native VLMKit gates

Deliver native paths for:

- snapshot;
- diff;
- a11y tree;
- grounding;
- interactions;
- verify flow.

Acceptance:

- existing image diff engine consumes native PNG without special cases;
- native semantic tree projects into existing a11y diff;
- grounding report maps marked screenshot coordinates to native elements;
- flow runner can launch -> click -> type -> assert -> screenshot.

### P4 — GPUI / gpui.mbt acceptance

Deliver:

- a GPUI fixture or gpui.mbt-produced fixture;
- stable accessibility identifier contract;
- GPUI-specific acceptance documentation only where framework behavior requires it.

Acceptance:

- VLMKit contains no GPUI runtime dependency;
- application contains no VLMKit runtime dependency;
- test is black-box from the built `.app`;
- stable-id locator resolves a GPUI control;
- screenshot + semantic + action verification all pass against the same window.

### P5 — hardening

Cover:

- multiple windows;
- modal dialogs/sheets;
- app crash/exit;
- hung AX calls;
- dynamic trees;
- moved/resized windows;
- multiple displays;
- Retina scaling;
- menu items;
- scroll views;
- native text fields;
- focus traversal;
- timeout/cancellation;
- artifact cleanup;
- deterministic exit codes.

### P6 — production-ready acceptance

Production-ready means:

- one documented install/build path from a fresh clone;
- `vlmkit native doctor` reliably diagnoses prerequisites;
- native sidecar is built reproducibly;
- browser regression suite remains green;
- native unit/protocol tests are deterministic;
- native integration tests pass on supported macOS;
- a real GPUI application is validated end-to-end;
- no required Appium, browser, application instrumentation, or MoonBit runtime integration;
- failure artifacts are sufficient to reproduce/diagnose locator, permission, coordinate, screenshot, and action problems.

## Test strategy

### Pure tests

Run on any host where possible:

- protocol encode/decode;
- capability negotiation;
- locator resolution against recorded trees;
- SurfaceNode -> A11yNode projection;
- coordinate transform math;
- artifact schema;
- action log normalization;
- unsupported/degraded gate decisions.

### macOS integration tests

Use a tiny deterministic native fixture with:

- button;
- text field;
- checkbox/toggle;
- scroll view;
- modal;
- second window;
- controls with and without stable IDs.

Tests verify:

- attach;
- snapshot;
- screenshot;
- role/name/id;
- bounds;
- hit test;
- focus;
- click;
- typing;
- flow;
- termination handling.

### GPUI acceptance tests

Keep separate from the low-level fixture so failures can be classified as:

- VLMKit native driver bug;
- macOS permission/environment issue;
- GPUI accessibility exposure issue;
- gpui.mbt binding issue.

## CI policy

Do not make production correctness depend on a hosted macOS runner having interactive UI/TCC permissions.

Split CI into:

- normal cross-platform unit/protocol tests;
- macOS compile tests for the sidecar;
- native integration lane only in an environment where Accessibility and Screen Recording permissions are explicitly provisioned.

A skipped native integration lane is not equivalent to PASS and must be reported separately.

## Failure taxonomy

Native commands should use stable error codes, at minimum:

- `NATIVE_AGENT_MISSING`
- `NATIVE_AGENT_PROTOCOL_MISMATCH`
- `NATIVE_PERMISSION_ACCESSIBILITY`
- `NATIVE_PERMISSION_SCREEN_CAPTURE`
- `NATIVE_APP_NOT_FOUND`
- `NATIVE_APP_EXITED`
- `NATIVE_WINDOW_NOT_FOUND`
- `NATIVE_WINDOW_AMBIGUOUS`
- `NATIVE_AX_TIMEOUT`
- `NATIVE_LOCATOR_NOT_FOUND`
- `NATIVE_LOCATOR_AMBIGUOUS`
- `NATIVE_ACTION_UNSUPPORTED`
- `NATIVE_COORDINATE_MISMATCH`
- `NATIVE_CAPABILITY_UNSUPPORTED`

These errors must survive into machine-readable JSON output.

## Open design questions

These should be resolved before P1 implementation is considered stable:

1. Which existing CLI command parser is the narrowest insertion point for `SurfaceTarget` without duplicating every command?
2. Should `SurfaceNode.attributes` retain an allowlisted normalized AX subset only, or also expose a raw diagnostic namespace?
3. What is the exact titlebar/window-frame inclusion contract for screenshots?
4. Which stable GPUI identifier reaches macOS AXIdentifier today, and what gpui.mbt API is needed if it does not?
5. Should physical text entry always emit key events, or should `type` and `setValue` be separate public actions?
6. Which existing browser interaction/grounding modules can be parameterized by a surface session, and which should get fork-only native siblings?
7. How should window-relative screenshot coordinates behave when a window is partially off-screen?
8. Do native snapshots use the current VRT naming convention or a native-specific target key including bundle/window identity?
9. What minimum macOS version should this fork support?
10. Should the Swift sidecar be built lazily on first use, in repository bootstrap, or committed as a release artifact?

## Next design work

Before writing implementation code:

1. inspect the concrete CLI/gate entry points for `snapshot`, `check grounding`, `check interactions`, `check a11y tree`, and `verify flow`;
2. identify every place where a Playwright `Page` or `Browser` crosses a package boundary;
3. draft protocol v1 JSON schemas with recorded request/response examples;
4. define the exact coordinate conversion equations and screenshot frame contract;
5. define the GPUI stable accessibility identifier acceptance fixture;
6. turn P0-P6 into smaller `issues/open` packets only after those boundaries are verified against current code.

No implementation should begin from this issue until the boundary audit above is complete.

Re-checked against main @ 2ce237f (2026-10-09): the observer slice (P0/P1) is on main; P2-P5 remain open and are in flight on draft PR #2.
