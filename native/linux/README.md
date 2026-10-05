# Linux native observer (experimental)

`observer.py` is a dependency-free Python 3 stdio NDJSON executable. It dynamically
loads system `libatspi`, `libglib-2.0`, `libgobject-2.0`, `libX11` and
`libXcomposite`. A running X11 desktop and desktop D-Bus accessibility session
and an already-running compositing manager are required. No AT-SPI Python
typelib is required.

## Scope and admission

- PID attach only, with `/proc` process-start identity checks against PID reuse.
- `hello`, passive `doctor`, `target.open`, `window.list`, `window.select`,
  `snapshot.capture`, `session.close`. No input, activation, launch or termination.
- Wayland **and XWayland sessions** are refused until portal surface identity can
  be matched to accessibility windows. Setting DISPLAY does not override this.
- Exact selected **client-window** frame, without server decorations or shadows.
  Coordinate units are X11 screen pixels, translated to client-local pixels;
  `scale=1`. This does not claim toolkit-independent HiDPI logical units.
  Only opaque depth-24 TrueColor RGB backing is admitted; alpha/depth-32
  windows are refused rather than flattening unknown premultiplied pixels.
- Accessibility association requires equal PID, unique equal global extents in
  both registries, and a retained accessible object identity after selection.
  Titles never bind surfaces. Decorated root/client geometry mismatches,
  duplicate geometries, zero-size, unmapped and nonzero-border windows are refused.
- Requires an existing `_NET_WM_CM_Sn` compositing manager and a pre-existing
  named Composite backing pixmap. **Never redirects or unredirects windows**:
  first redirection can copy occluder pixels from the parent before repaint,
  so the observer refuses uncomposited desktops instead of attempting this.
  The compositor must remain the same between selection and capture. It never
  captures/crops the root desktop. Validation and pixels are read under a short
  server grab, released before PNG encoding. Semantics and pixels are not an
  atomic application snapshot.
- The X11 client PID property is self-reported. This is a trusted local-session
  observer, **not** a security boundary against malicious X11 clients. Explicit
  foreign-PID embedded child windows are refused. No cross-client X11 security
  guarantees are asserted.
- Traversal is cycle-safe, bounded to 10,000 nodes / depth 128 maximum, 15 seconds
  per AT-SPI request sequence and 1 second per remote AT-SPI call. Partial trees
  report truncation/errors. Missing geometry is diagnostic, never invented.
- Names, toolkit-exposed accessible IDs, roles, states and native action names
  are observed. Action names have an `atspi:` prefix; controls do not receive
  synthetic `tap` actions. Values and text contents are not collected in this
  initial profile. Password values are consequently never collected.

`hello.capabilities` describes implemented features; `doctor.*.available` reports
runtime availability, not macOS-style authorization. A successful doctor cannot
promise any particular target has accessibility or a capturable surface.
Capture returns `backend: "x11"`, `frameKind: "client-window"`, and
`identity: {pid, windowId}` in addition to protocol-1 capture fields.

## Validation

```sh
python3 -m unittest discover -s native/linux -p 'test_*.py' -v
# On a provisioned Linux desktop-test host:
dbus-run-session -- xvfb-run -a -s '-screen 0 1280x1024x24 -nolisten tcp' \
  native/linux/with-compositor.sh /usr/bin/python3 native/linux/integration.py \
    --out test-results/native/linux
```

Integration dependencies: GTK3/Atk Python GI, `at-spi2-core`, `libatk-adaptor`,
D-Bus, Xvfb, xcompmgr (started before the fixture), and the shared libraries above. The fixture uses only its own local
windows and produces a tree, PNG, truncated tree, and machine-readable report.
It verifies real stable IDs, duplicate-title surfaces, client-local semantic
rectangles against known red pixels, and a foreign green occluder that must not
appear in the selected window image. The fixture's setup/teardown launches and
terminates only its own test processes; the observer never does so.

Pure tests do not establish live desktop acceptance. Review the integration
report and CI result before treating the backend as accepted. GPUI/other toolkit
accessibility exposure, decorated windows, scaling and Wayland need separate
acceptance evidence and are not inferred from GTK/Xvfb.


## Observed profile

The Ubuntu 24.04 / Xvfb / xcompmgr / GTK3 scale-1 fixture profile passed hosted
observation and actual TypeScript scan-to-generic-judge acceptance at source
`96249baad0b7e7c499f1f797db92bcd29a3d078c`.
See the [acceptance report](../../docs/reports/2026-10-05-linux-native-observer.md)
for exact versions, tests and retained artifact. This is not a general desktop,
Wayland, GPUI/MZed or physical-input support claim.
