# Native UI driver P2-P5 implementation report — 2026-10-03

Status: implementation landed on PR #2; live acceptance pending.

## Implemented

- P2 native hit testing and actions
  - screenshot-pixel -> logical/global coordinate transform;
  - AX hit testing with stable target evidence;
  - stable-id / role-name / path / point locators;
  - fail-closed ambiguous locators;
  - semantic press/focus/set-text;
  - physical click/key/text/scroll;
  - redacted JSONL action evidence.
- Native session client
  - reusable attach/window session;
  - reusable capture on the same selected window;
  - passive/explicit-prompt doctor;
  - provenance metadata preserved from the main branch.
- Native grounding
  - existing grounding analyzer consumes native AX targets;
  - screenshot-space hit probes and set-of-mark output;
  - coordinate replay for click/wheel;
  - browser-only load options fail closed.
- Native interactions
  - AX semantic inventory projected into the existing interaction report;
  - focusability, semantic activation, AX state deltas, and focus-pixel evidence;
  - DOM handler probing is explicitly rejected in native mode.
- Native VRT
  - native PNGs feed the existing screenshot diff engine;
  - current/baseline AX sidecars are persisted;
  - AX trees project into the existing semantic a11y diff engine.
- Native verified flow
  - portable stable-id / role-name / path locators;
  - click / focus / fill / type / press / wait;
  - post-condition assertions over AX role/name/value/state/visibility/count/focus;
  - per-step screenshot, tree and action evidence.
- CLI / operations
  - `vlmkit native doctor`;
  - `snapshot macos:...`;
  - native options on grounding, interactions and verify flow.
- GPUI boundary
  - no GPUI runtime dependency was added;
  - `native/macos/script/gpui_acceptance.mjs` validates a built GPUI/gpui.mbt app entirely black-box using a stable AXIdentifier.
- Hardening acceptance harness
  - target exit;
  - ambiguous/multiple windows;
  - dialog discovery/capture;
  - scrolling;
  - text fields;
  - duplicate identifiers;
  - bounded traversal;
  - protocol timeout/malformed/exit behavior.

## Deterministic tests added

Cross-platform pure tests cover:

- native locator preference/matching and role-name nth semantics;
- point locators remaining action-only;
- native snapshot CLI parsing;
- flat AX path -> existing semantic tree projection;
- portable native flow locators passing shared flow validation.

The provisioned macOS integration script now additionally exercises:

1. grounding;
2. interaction map;
3. native snapshot twice (new baseline, then zero-diff verification);
4. stable-id verified flow with click and semantic fill;
5. dialog discovery/capture;
6. physical scroll.

## Validation state

Not executed in this environment:

- `pnpm test`;
- `pnpm typecheck`;
- SwiftPM/native integration;
- GPUI/gpui.mbt live black-box acceptance;
- multi-display acceptance.

Observed environment constraints during this implementation:

- this fork currently reports zero GitHub Actions workflow runs for the PR branch;
- the connected Temote host has no vlmkit named root/session;
- Codex, OpenCode and Devin CLI probes on the only active Temote session each returned executable-not-found;
- Devin Cloud is not configured on that host.

These are validation gaps, not PASS results.

## Remaining production acceptance

Keep the parent native issues open until all of the following are observed on a provisioned macOS host:

- unit suite PASS;
- TypeScript typecheck PASS;
- Swift tests/build PASS;
- full `native/macos/script/integration.mjs` PASS;
- one real GPUI or gpui.mbt-built `.app` PASS via `gpui_acceptance.mjs`;
- multiple-display/window-move acceptance if production support claims those cases.

Once those gates pass, the implementation can be promoted from draft and the parent design issues can move to done.
