# Apple Silicon macOS native-driver qualification

Status: open — bounded observer evidence exists; actions/gates/flow unqualified  
Updated: 2026-10-07 (JST)  
Parent: [Native UI black-box driver](20261003-native-ui-black-box-driver.md)  
Observer: [AX collector protocol](20261003-macos-ax-collector-protocol.md)

## Current evidence and dependencies

**Apple Silicon / arm64 only; Intel is excluded.** Keep the existing protocol,
collector and [boundary audit](20261003-native-ui-boundary-audit.md); do not
invent a new semantic schema for this split.

Main `f8196f8143c7d8b32b03af713d6ef7e4d5e2aea0` contains the bounded AX/
ScreenCaptureKit observer. The [P0 acceptance report](../../docs/reports/2026-10-03-native-observer-p0.md)
records an arm64 macOS 26.5.2 fixture, actual 2x window PNG/AX alignment,
lifecycle/ambiguity/truncation checks and dedicated errors. Live physical 1x
display coverage was unavailable. Preserve that evidence and its limits.

[PR #2](https://github.com/f4ah6o/vlmkit/pull/2), inspected head
`9893e13234cf222d7fcf606d02d9944094d3cb31`, proposes actions, grounding,
interactions, VRT, flow and GPUI acceptance. It remains draft; its body records
the executable tests/real application acceptance as NOT EXECUTED. Reconcile it
with current main and validate final source before adopting any capability.

## Scope and acceptance

Own the Mac-specific execution/evidence for the parent's remaining P2–P6 gates.
Common contracts and the completed observer packet remain in their existing files.

- [ ] Native build, Swift/TypeScript/protocol/browser regression checks pass on
  exact final source; observer behavior and historical fixture evidence remain intact.
- [ ] A provisioned arm64 host captures the selected window and actual AX tree,
  recording signing/TCC diagnostics, declared macOS/SDK/tool/app identities,
  completeness, scale and transform metadata. Never infer permission from a timeout.
- [ ] Hit testing, stable/fallback locators and semantic/physical actions retain
  distinct evidence. Ambiguous, stale, wrong-window, sibling/occluded and exited
  targets fail closed without acting on unrelated applications.
- [ ] Grounding/interactions/VRT/flow pass on the declared fixture/profile with
  same-window pixels, semantics and action records. Resize/move/display profiles
  are qualified separately; synthetic transforms do not prove an unrun display.
- [ ] Real GPUI/gpui.mbt acceptance uses a built application externally with no
  private framework hooks or fabricated AX controls. Missing application
  accessibility is an application/framework blocker.
- [ ] Timeout/cancellation/partial capture/permission/cleanup failures retain
  bounded diagnostic artifacts, target ownership and explicit outcomes.

No PR #2 feature is marked complete by this split. Preserve unsupported
browser-only gates, local-only transport/provenance boundaries and the parent's
release criteria; one fixture/profile is not universal macOS support.
