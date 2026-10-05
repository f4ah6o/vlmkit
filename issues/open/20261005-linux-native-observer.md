# Linux native observer and support admission

Status: bounded X11 observer implemented; GTK/Xvfb/xcompmgr fixture acceptance passed.
Broader Linux profiles remain subject to their own admission evidence.

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
| Linux composited X11 AT-SPI/XComposite, scale 1 | GTK/Xvfb/xcompmgr fixture PASS; [exact evidence](../../docs/reports/2026-10-05-linux-native-observer.md) | Unsupported |
| X11 other WMs, toolkits, scale factors | Unqualified until corresponding runs | Unsupported |
| Linux Wayland, named compositor/portal versions | Follow-up required | Unsupported |
| XWayland | Separate qualification required | Unsupported |
| Windows | Deferred under priority/environment rule | Deferred |

Before broader X11 admission: GTK/Qt and real gpui.mbt/MZed semantics, multi-window,
resize/move, absent/partial AT-SPI, duplicate identities, target exit, CSD/SSD,
scaling and retained pixel/tree alignment evidence. Add a distinct visited-node/
reference budget before broad desktop admission: the current emitted-node cap and
15-second AT-SPI deadline do not bound every eagerly acquired child reference.
Missing GPUI accessibility is
a framework gap, not permission to synthesize a passing tree.

Wayland needs an explicit portal-backed observer packet: advertised WINDOW source,
user-authorized PipeWire stream, verified AT-SPI-to-stream identity and surface-local
geometry. No title-only matching, monitor-crop substitution or invented global origin.
RemoteDesktop/libei device permission alone does not prove selected-window delivery.
Keep input disabled until target-only delivery and negative sibling/occlusion tests
pass on the claimed profile. No root/uinput, xhost+, security-setting bypass, persistent
authorization or silent browser fallback is introduced.

## Sources

- [AT-SPI accessible objects](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/class.Accessible.html)
- [AT-SPI component geometry](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/iface.Component.html)
- [ScreenCast portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)
- [RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)
- [libei](https://libinput.pages.freedesktop.org/libei/api/index.html)
