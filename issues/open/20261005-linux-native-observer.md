# Linux native observer and support admission

Status: bounded X11 observer implemented; GTK/Xvfb/xcompmgr fixture acceptance passed
for source `96249baa…`. The 2026-10-20 round (bounded traversal, GTK semantics matrix,
partial-tree and exit taxonomy, XWayland refusal) is implemented with pure tests green;
its hosted acceptance is **pending a run**. Broader Linux profiles remain subject to
their own admission evidence.

Linux native is a first-class target alongside macOS. Eventual application/tool support
covers macOS, Linux and Windows. New Windows work is deferred until higher-priority
macOS/Linux work is exhausted and a Windows work environment is supplied.

## This bounded slice

- Reuse the local NDJSON observer transport and `vlmkit-a11y/1` consumers.
- Linux composited X11, attach by PID, actual AT-SPI semantics and selected client-window PNG.
- Explicit frame/identity metadata, no fabricated accessible controls.
- Fail closed for missing capabilities, ambiguous association and physical input.
- Deterministic GTK fixture plus an isolated Xvfb/D-Bus CI lane.

This is an observer milestone, not native automation completion. It does not depend
on or promote the unmerged macOS action work in PR #2. It supports the external
observation side of gpui.mbt's MZed 0019 plan without introducing private GPUI hooks.

## Admission and follow-ups

Record implementation and actual acceptance separately for each profile:

| Profile | Observer | Physical input |
| --- | --- | --- |
| macOS 14+ AX/ScreenCaptureKit | Existing fixture evidence; preserve regression tests | PR #2 remains separately gated |
| Linux composited X11 AT-SPI/XComposite, scale 1 | GTK/Xvfb/xcompmgr fixture PASS at `96249baa…` ([exact evidence](../../docs/reports/2026-10-05-linux-native-observer.md)); matrix/partial/exit round [v2](../../docs/reports/2026-10-20-linux-native-observer-v2.md) is UNRUN on this source | Unsupported |
| X11 other WMs, toolkits, scale factors | Unqualified until corresponding runs | Unsupported |
| Linux Wayland, named compositor/portal versions | Follow-up required | Unsupported |
| XWayland | Separate qualification required | Unsupported |
| Windows | Deferred under priority/environment rule | Deferred |

Before broader X11 admission: GTK/Qt and real gpui.mbt/MZed semantics, multi-window,
resize/move, absent/partial AT-SPI, duplicate identities, target exit, CSD/SSD,
scaling and retained pixel/tree alignment evidence. The Linux observer now uses
lazy child acquisition and per-request 20,000-visited / 50,000-object-reference
budgets, reserved before each remote call; the selected window frame is itself a
visited node. It releases request-owned refs after each request while preserving the
selected window's dedicated identity ref. The emitted-node and depth caps remain
10,000 and 128 (default 64), with one reference slot within the request cap reserved
for selected-window geometry revalidation before capture. This closes the original
eager-reference gap in the implementation, with pure wide/deep/cyclic/foreign-tree
tests; broader desktop admission still requires its own live qualification evidence.
Only the request's hard budgets (timeout, visit limit, reference limit) stop
traversal — an attribute or subtree failure is a diagnostic and the rest of the tree
is still read, so a partial tree is reported as truncated, never as whole.
Missing GPUI accessibility is a framework gap, not permission to synthesize a
passing tree.

Wayland needs an explicit portal-backed observer packet: advertised WINDOW source,
user-authorized PipeWire stream, verified AT-SPI-to-stream identity and surface-local
geometry. No title-only matching, monitor-crop substitution or invented global origin.
RemoteDesktop/libei device permission alone does not prove selected-window delivery.
Keep input disabled until target-only delivery and negative sibling/occlusion tests
pass on the claimed profile. No root/uinput, xhost+, security-setting bypass, persistent
authorization or silent browser fallback is introduced.

## Remaining admission status — 2026-10-20

Implementation round: [Linux native observer v2](../../docs/reports/2026-10-20-linux-native-observer-v2.md).
A checkbox below is only checked when the named evidence exists; a skipped or unrun lane
is not a pass.

- [x] Distinct visited-node/reference budgets before broader AT-SPI traversal — landed
  from unmerged `30872529` (cherry-picked), reviewed and repaired: the root is charged,
  attribute failures no longer erase a node, the double request release is gone. Pure
  wide/deep/cyclic/foreign-tree tests PASS locally.
- [x] GTK semantics: a `--matrix` fixture (button, entry, password entry, check box,
  toggle, radios, tabs, combo box, scrolled list, disabled, image) with per-control
  role/name/state/action assertions. Implementation and fixture contract tests PASS
  locally; **hosted run: pending**.
- [x] Partial/absent AT-SPI and target exit: `NATIVE_AX_PARTIAL` (with window counts) and
  `NATIVE_TARGET_EXITED` are implemented and unit-tested; the X11-only partial profile
  is **UNRUN** (needs `python3-xlib`, not installed in the lane) and the live partial
  and exit checks await the hosted lane (the exit check is in the base profile's live
  assertions, not yet executed).
- [x] Multi-window: two same-title windows refuse implicit selection
  (`NATIVE_WINDOW_AMBIGUOUS`, base profile, pure + live assertions).
- [x] Duplicate identifiers: reported with both paths; a duplicate never drops a node.
- [ ] Resize/move and retained pixel/tree alignment evidence beyond the admitted
  fixture: the base/matrix profiles check rect-to-pixel alignment at capture time;
  resize/move during a session is **UNRUN**.
- [ ] CSD/SSD decorated windows, other toolkits (Qt, GTK4, Electron), scale != 1:
  **UNSUPPORTED / unqualified** — refused by geometry/visual admission.
- [ ] Wayland portal WINDOW/PipeWire identity on a named compositor/portal profile:
  **UNRUN**. XWayland: refused by the server extension check; its own observation is
  **UNSUPPORTED**.
- [ ] Physical input: **UNSUPPORTED** on every Linux profile; no input capability is
  advertised, and no flow PASS may be recorded before target-only delivery and negative
  sibling/occlusion checks exist.
- [ ] Real gpui.mbt/MZed semantics: **BLOCKED** on the application/framework exposing
  accessibility; no synthetic tree is permitted.
- [x] Preserve the macOS/browser regressions: macOS transport tests unchanged in source
  (their vitest run is **UNRUN** in this sandbox — no installed dependencies; the CI
  transport job runs both files).

## Sources

- [AT-SPI accessible objects](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/class.Accessible.html)
- [AT-SPI component geometry](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/iface.Component.html)
- [ScreenCast portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)
- [RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)
- [libei](https://libinput.pages.freedesktop.org/libei/api/index.html)
