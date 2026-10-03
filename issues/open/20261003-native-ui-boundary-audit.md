# Native UI boundary audit and first vertical slice

Status: design / open  
Date: 2026-10-03  
Parent: `issues/open/20261003-native-ui-black-box-driver.md`

## Result

The current codebase already contains a stronger native seam than the parent design initially assumed.

The first macOS-native milestone should **not** begin by introducing a new generic `SurfaceNode` tree.

Instead:

1. reuse the existing portable `vlmkit-a11y/1` artifact as the static semantic contract;
2. add a macOS AX collector that writes that artifact plus a PNG frame;
3. prove `check a11y tree` against a native application before introducing live interaction abstractions;
4. add a runtime native session only for the gates that genuinely require live hit-testing or actions.

This reduces the first implementation surface and avoids creating a second semantic-tree model beside one that is already explicitly designed for non-browser collectors.

## Evidence from the current code

### Existing portable accessibility artifact

`packages/vlmkit-markup/src/a11y-tree/scan-a11y.ts` explicitly states that:

- Flutter web is one collector;
- Android uiautomator XML is another collector;
- macOS AX, Windows UI Automation, iOS, Flutter desktop, or another tool can write the same JSON;
- downstream consumers should not care which collector wrote it.

The shared format is defined in:

`packages/vlmkit-judge/src/a11y-tree.ts`

as:

```text
format: "vlmkit-a11y/1"
platform
viewport
scale
frame
nodes[]
  path
  role
  name
  value
  rect
  states
  actions
  textSize
  fontWeight
```

This is already the correct static observation boundary for native v0.

### The parser is extension-tolerant

`parseA11yTree` validates required fields but does not reject extra fields.

Therefore the fork can add optional native metadata without immediately changing the format identifier, provided the meaning of existing fields remains unchanged.

Candidate additions:

```ts
interface A11yNode {
  // existing fields...

  /** Stable automation/accessibility identifier, e.g. macOS AXIdentifier. */
  identifier?: string;

  /** Platform-native role/subrole retained for diagnostics. */
  platformRole?: string;
  platformSubrole?: string;
}
```

Decision for v0:

- add `identifier?: string`;
- add `platformRole?: string` and `platformSubrole?: string` only if needed during AX mapping;
- do not invent a parallel `SurfaceNode` tree yet.

If these fields later become semantically required across platforms, then consider `vlmkit-a11y/2`.

## Boundary classification

There are two different kinds of native integration in the current repository.

### A. artifact consumers

These can work from files after the application has been observed.

Examples:

- `check a11y tree`;
- PNG diff;
- screenshot VRT;
- image/VLM judgement.

These should receive native support first.

### B. live-session gates

These operate against a currently running UI.

Examples:

- `check grounding`;
- `check interactions`;
- `verify flow`;
- snapshot capture itself.

These need a runtime driver/session abstraction, but not before the artifact-first slice works.

Do not force both categories through one abstraction on day one.

## Gate-by-gate audit

## `check a11y tree`

Current state: already platform-neutral after capture.

`check-a11y-tree.ts` reads:

- a `vlmkit-a11y/1` JSON file;
- an optional PNG frame.

It does not need Playwright.

Native plan:

```text
macOS app
  -> AX collector
  -> native-a11y.json + native-frame.png
  -> existing check a11y tree
```

This is the first production vertical slice.

### Acceptance

Given a native fixture app with:

- named button;
- unnamed button;
- text field;
- checkbox;
- offscreen element;
- disabled control;

the existing checker must produce meaningful findings without any native-specific branch in the judge.

## `snapshot`

Current state: browser lifecycle is embedded in `src/vrt/snapshot/snapshot.ts`.

The command directly performs:

```text
CaptureBackend.launch()
  -> Browser.newPage()
  -> page.goto()
  -> page.screenshot()
  -> page.content()
```

`CaptureBackend` is a browser-launch abstraction, not a generic UI abstraction.

Decision:

- keep `CaptureBackend` browser-only;
- do not add `macos` to `CaptureBackendKind`;
- extract a higher-level single-target capture operation from snapshot before native snapshot support.

Candidate boundary:

```ts
interface SnapshotSource {
  readonly kind: "web" | "native";

  capture(input: SnapshotCaptureInput): Promise<{
    screenshotPath: string;
    label: string;
    metadata: Record<string, unknown>;
    sidecars?: Record<string, string>;
  }>;
}
```

For browser capture, the existing HTML sidecar remains available.

For native capture, an accessibility JSON sidecar replaces HTML as the structural artifact.

Snapshot comparison itself remains PNG-based and reusable.

## `check grounding`

Current state: half reusable, half browser-specific.

The important existing seam is:

`analyzeGroundingSamples(input, options)`

It is already a pure post-process and has no browser requirement.

Browser-specific code is concentrated in collection and live probing:

- `COLLECT_GROUNDING_SCRIPT`;
- `document.elementFromPoint`;
- `page.evaluate`;
- `page.mouse`;
- browser navigation;
- screenshot capture.

This means native grounding should **not** rewrite the finding logic.

### Native strategy

Build a native collector that produces the same conceptual input:

```ts
interface GroundingScanInput {
  source: string;
  page: {
    viewportWidth: number;
    viewportHeight: number;
    capped: number;
  };
  targets: GroundingTargetSample[];
}
```

Map AX information into `GroundingTargetSample`:

- role <- normalized AX role;
- name <- AX accessible name/title/description mapping;
- bbox <- AX rect in canonical window-local logical points;
- disabled <- AXEnabled;
- inFrame <- intersection with selected window viewport;
- clickPoint <- center of visible rect;
- centreHit/interceptedBy <- AX hit test at center;
- reachable <- search nearby points only when center is intercepted;
- ancestorTexts <- ancestor names/titles;
- actions <- AX supported actions.

### Required fork refactor

Several exported result fields say `cssPoint` even though the arithmetic is actually "logical viewport units before screenshot scaling."

Do not put macOS point coordinates into a field named CSS.

Refactor toward:

```ts
logicalPoint: { x: number; y: number }
```

Compatibility option for existing browser JSON:

```ts
cssPoint?: { x: number; y: number } // browser-only alias during migration
```

Because this fork does not target upstream integration, internal call sites may migrate directly once tests are updated.

### Key rule

The existing `analyzeGroundingSamples` arithmetic/finding tests must remain the oracle.

Native code supplies samples; it does not reimplement:

- precision-floor rules;
- crowded-target rules;
- ambiguity rules;
- label mismatch;
- frame scaling;
- set-of-mark geometry.

## `check interactions`

Current state: substantially browser-specific.

`buildInteractionMap` directly depends on:

- DOM discovery scripts;
- ARIA attributes;
- Playwright keyboard;
- DOM focus;
- CSS focus styles;
- popup DOM probing;
- repeated page reloads.

However the higher-level report shape and issue derivation are useful.

Decision:

- do not attempt to adapt `Page` behind an interface;
- create a separate native measurement engine;
- converge only at a normalized interaction result.

### Native interaction observation model

Native probes need a generic state snapshot:

```ts
interface UiStateSnapshot {
  role: string;
  name: string;
  value?: string;
  focused?: boolean;
  selected?: boolean;
  expanded?: boolean;
  checked?: boolean;
  enabled?: boolean;

  controlledTarget?: {
    exists: boolean;
    visible?: boolean;
  };

  focusPath?: string;
  layoutSignature?: string;
}
```

Browser `AriaSnapshot` can later project into this type.

macOS AX can independently produce it.

A native activation probe then follows the same conceptual sequence:

```text
fresh app state
 -> focus target
 -> snapshot before
 -> press canonical key
 -> settle
 -> snapshot after
 -> derive state delta
 -> inspect focus movement
```

Do not call the generic delta `ariaDelta` once native support is added. Prefer `stateDelta`.

### Native focus indicator

The browser gate compares CSS styles before/after focus.

There is no equivalent generic AX property proving visual focus-ring paint.

For macOS, treat these separately:

- `tabReachable`: semantic/keyboard fact;
- `focused`: AX state fact;
- `focusIndicator`: visual judgement from before/after screenshot crop, or `null` if not implemented.

Never report `focusIndicator: true` merely because AXFocused became true.

## `verify flow`

Current state: browser-specific flow schema.

Actions use CSS selectors and assertions use DOM concepts:

- `attr`;
- CSS selector visibility;
- DOM focus;
- textContent;
- querySelectorAll count.

Do not overload the existing schema with native meanings.

Introduce a native-capable flow v2 after P1/P2.

Candidate locator:

```ts
type UiLocator =
  | { by: "identifier"; value: string }
  | { by: "role-name"; role: string; name: string; nth?: number }
  | { by: "path"; value: string }
  | { by: "point"; x: number; y: number };
```

Candidate portable actions:

- click;
- press;
- type;
- setValue;
- focus;
- scroll;
- wait.

Candidate portable assertions:

- visible;
- focused;
- value;
- text/name;
- count;
- state.

Keep browser-only assertions such as arbitrary DOM attribute matching in browser flow v1 unless a real cross-platform semantic emerges.

## Minimal runtime abstraction

After the artifact-first slice, add the smallest live abstraction required by grounding/actions.

Do not start with a large `SurfaceDriver`.

Suggested v1:

```ts
interface NativeSession {
  info(): Promise<NativeSessionInfo>;

  snapshot(): Promise<A11yTree>;
  screenshot(): Promise<NativeScreenshot>;

  hitTest(point: LogicalPoint): Promise<NativeHit>;
  perform(action: NativeAction): Promise<NativeActionResult>;

  close(): Promise<void>;
}
```

The macOS implementation is a TypeScript client over the Swift stdio sidecar.

If a second native platform later appears, promote this to a generic `SurfaceSession` based on the actual common subset discovered then.

## macOS AX collector mapping

Initial normalization table:

| macOS observation | VLMKit field |
| --- | --- |
| AXIdentifier | `identifier` |
| AXRole / AXSubrole | normalized `role`; native values retained diagnostically |
| AXTitle / AXDescription / label-like data | `name` according to deterministic precedence |
| AXValue | `value` |
| AXPosition + AXSize | `rect` |
| AXEnabled | `states.disabled = !enabled` |
| AXFocused | `states.focused` |
| selected-like attributes | `states.selected` |
| expanded-like attributes | `states.expanded` |
| supported AX actions | normalized `actions` |
| window content bounds | `viewport` |
| screenshot px / logical width | `scale` |
| captured PNG | `frame` |

The exact name precedence and role/action mapping must be table-driven and fixture-tested.

## First vertical slice

Create a macOS collector that can be invoked conceptually as:

```bash
vlmkit scan a11y   --driver macos   --bundle-id com.example.NativeFixture   --out .vlmkit/native-a11y.json   --frame .vlmkit/native-frame.png
```

Alternative CLI spelling is acceptable during implementation; the artifact contract matters more than the command spelling.

Required behavior:

1. locate or launch the target app;
2. select one deterministic window;
3. capture its AX tree;
4. normalize into `vlmkit-a11y/1`;
5. capture the same window to PNG;
6. populate `viewport`, `scale`, and `frame`;
7. write both artifacts;
8. run the existing `check a11y tree` unchanged.

### Why this is first

It proves all of the hardest observation prerequisites without simultaneously adding input:

- TCC permissions;
- process/window selection;
- AX traversal;
- role/name normalization;
- geometry;
- Retina scale;
- ScreenCaptureKit;
- artifact wiring.

If this slice is wrong, adding click/type/flow only makes diagnosis harder.

## Revised milestone order

### P0A — static contract

- add optional stable `identifier` to `A11yNode`;
- define AX role/name/action mapping tables;
- define coordinate/window-frame contract;
- add recorded macOS tree fixtures for parser/judge tests.

No live native process yet.

### P0B — Swift observer

- stdio protocol handshake;
- permission doctor;
- attach/launch;
- selected window;
- AX snapshot;
- ScreenCaptureKit PNG;
- emit `vlmkit-a11y/1`.

### P1 — native a11y vertical slice

- CLI integration for macOS collector;
- existing `check a11y tree` consumes output unchanged;
- overlay test proves tree rects align with PNG.

### P2 — native grounding

- native target collector -> existing `analyzeGroundingSamples`;
- native AX hit testing;
- set-of-mark reuse;
- coordinate replay actions.

### P3 — native snapshot/VRT

- extract target capture boundary from `snapshot.ts`;
- native PNG source;
- native a11y sidecar included in report;
- no HTML expectation in native mode.

### P4 — native interactions

- normalized UI state snapshot;
- keyboard traversal/activation;
- AX state deltas;
- visual focus-indicator evidence.

### P5 — native flow

- flow v2 portable locator/action/assert schema;
- native runner;
- browser adapter optional after native semantics are stable.

### P6 — GPUI acceptance + hardening

- real GPUI/gpui.mbt app;
- stable AXIdentifier;
- multi-window;
- dialogs;
- scroll;
- dynamic content;
- app exit/hang;
- multi-display/Retina;
- production acceptance.

## P0A acceptance details

P0A is complete only when hand-written fixture trees prove:

- optional `identifier` round-trips through parser;
- existing a11y judges ignore identifier when irrelevant;
- native role mapping preserves unknown roles rather than dropping nodes;
- viewport units and frame scale are mathematically explicit;
- a 2x frame maps node rects exactly to pixel crop regions;
- duplicate path is rejected;
- duplicate identifier is diagnosed by the native collector even though the generic parser does not require global identifier uniqueness.

## Coordinate decision

For the native a11y artifact:

- `viewport` is selected-window full bounds in logical points (including title bar);
- node `rect` is full-window-local logical points;
- origin is top-left;
- `scale` is frame pixels per logical point;
- PNG must depict exactly the same full-window coordinate region represented by the tree.

Do not mix global AX screen coordinates into persisted `rect`.

The Swift collector performs:

```text
AX global screen rect
 -> selected window full-frame origin
 -> window-local logical rect
 -> A11yNode.rect
```

Grounding later maps:

```text
window-local logical point
 <-> screenshot pixel
 <-> global AX point
```

through one shared transform description.

## Driver dependency decision

Production runtime:

- Swift standard/macOS frameworks;
- AXUIElement;
- ScreenCaptureKit;
- CoreGraphics events when input arrives;
- Node/TypeScript client already used by VLMKit.

Not required:

- Appium server;
- WebDriverAgentMac;
- XCTest runner;
- Playwright for native mode.

Appium Mac2 remains an optional external differential oracle only.

## Files expected to change in the first implementation packet

Design expectation, not implementation yet:

```text
packages/vlmkit-judge/src/a11y-tree.ts
packages/vlmkit-markup/src/a11y-tree/scan-a11y.ts
packages/vlmkit-markup/src/a11y-tree/*.test.ts

packages/vlmkit-native/...
native/macos-agent/...

src/cli/...                 # only enough to route native scan/doctor
pnpm-workspace.yaml          # only if vlmkit-native is a workspace package
```

Files that should **not** need native branches in P1:

```text
packages/vlmkit-markup/src/a11y-tree/check-a11y-tree.ts
packages/vlmkit-judge/src/a11y-tree.ts judge functions
packages/vlmkit-core/src/heatmap.ts
packages/vlmkit-core/src/png-utils.ts
```

The first file may gain generic metadata types, but its judge logic should remain platform-neutral.

## Explicit implementation stop

Do not implement `check interactions`, native flow, or a broad generic surface framework before the native a11y artifact + frame vertical slice passes.

The next design packet should specify:

1. macOS AX -> `vlmkit-a11y/1` mapping tables;
2. window-content coordinate normalization;
3. stdio protocol v1 request/response examples;
4. P0A/P0B fixture and test matrix.

## P0 implementation — 2026-10-03

Model: unknown

P0A/P0B and the native scan vertical slice are implemented in `native/macos/`
and `packages/vlmkit-markup/src/a11y-tree/native-agent.ts`. The observer requires
macOS 14+, uses a stable app bundle identity, and implements protocol 1 over
stdio. The CLI accepts `macos:` targets and reports partial traversal. Generic
judges remain platform-independent.

The coordinate decision is refined by the collector protocol: **full selected
window bounds including title bar**, shadow excluded, top-left local logical
points; not an AppKit content-only crop. Recorded 2x fixture output and an actual
Save pixel/rect check verify this decision.

Validation and limitations:
[2026-10-03 native observer acceptance](../../docs/reports/2026-10-03-native-observer-p0.md).
These parent designs remain open for the later native driver/GPUI phases.
