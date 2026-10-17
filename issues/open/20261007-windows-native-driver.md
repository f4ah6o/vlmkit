# Windows native observer and driver follow-up

Status: deferred — no Windows native implementation or runtime qualification  
Updated: 2026-10-07 (JST)  
Parent: [Native UI black-box driver](20261003-native-ui-black-box-driver.md)

## Existing target and dependencies

Windows UI Automation is already an eventual target in the parent and the
[Linux admission packet](20261005-linux-native-observer.md). Preserve its
priority/environment gate: new Windows work waits until higher-priority
macOS/Linux work is exhausted and a Windows work environment is supplied.
This OS split schedules no implementation.

At inspected main `f8196f8143c7d8b32b03af713d6ef7e4d5e2aea0`, the native
collectors are macOS and bounded Linux X11. Neither browser tests, the Linux
observer nor unmerged macOS [PR #2](https://github.com/f4ah6o/vlmkit/pull/2)
qualifies a Windows native driver.

Reuse the actual NDJSON observer and `vlmkit-a11y/1` consumers after auditing
Windows capabilities. Keep common protocol/gates/security contracts in the
parent; do not silently inherit macOS AX objects or browser DOM assumptions.

## Observer-first scope and acceptance

- [ ] After the scheduling gate is satisfied, declare a reproducible Windows/
  SDK/architecture/tool profile and deterministic local native fixture.
- [ ] Passive doctor distinguishes prerequisites and permission failures.
  Attach/launch and window selection bind process and HWND identity; ambiguous
  windows fail explicitly. Closing an attached session cannot terminate a
  pre-existing user app.
- [ ] UI Automation emits bounded real names/roles/values/states/identifiers and
  completeness diagnostics; no invented controls or unbounded traversal.
- [ ] A declared selected-window capture path yields PNG plus explicit local
  logical/physical coordinates. Verify semantic/pixel alignment at each claimed
  DPI, resize/move and window identity; reject mismatches.
- [ ] Missing/partial UIA, duplicate identities, target exit, unavailable capture
  and timeouts have machine-readable errors and bounded retained evidence.
- [ ] Existing browser/macOS/Linux tests remain intact; unsupported native or
  browser-only gates stay honest.

Physical input, grounding/interactions/flow and broader profile support remain
unsupported until separately admitted using the parent's exact-target,
negative-sibling/occlusion and same-window evidence requirements. No global
input, privilege/security bypass or support claim is authorized by this packet.
