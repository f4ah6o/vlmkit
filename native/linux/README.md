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
  be matched to accessibility windows. Setting DISPLAY does not override this:
  the observer also asks the X server for the `XWAYLAND` extension and refuses
  an Xwayland DISPLAY even when no Wayland variable reaches the process.
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
- Traversal is cycle-safe and lazy: it acquires one child reference at a time,
  only after checking request-wide limits of 20,000 visited nodes and 50,000
  AT-SPI object-reference attempts. The selected window frame is itself a
  visited node and is emitted as `window[0]`. The emitted-node cap is 10,000 and
  depth is capped at 128 (default 64). All request-owned object refs are released
  at the end of each request; the selected window identity has its own dedicated
  retained ref. One slot within the reference cap is reserved for final
  selected-window geometry revalidation before pixel capture.
  Requests also have a 15-second AT-SPI deadline and 1-second per-call timeout.
  Partial trees report truncation and the specific budget diagnostic. A subtree
  whose enumeration or attributes fail is a diagnostic and traversal continues;
  only the request's hard budgets (timeout, visit limit, reference limit) stop it.
  Missing geometry is diagnostic, never invented.
- These budgets close the eager-reference gap for the collector and window
  enumeration. They do not qualify additional desktop profiles; live GTK/Xvfb
  acceptance and the broader X11/Wayland follow-ups remain separate.
- Names, toolkit-exposed accessible IDs, roles, states and native action names
  are observed. Action names have an `atspi:` prefix; controls do not receive
  synthetic `tap` actions.
- **Values are numeric and never text.** An entry's text is content and a
  `password text` node is never read, so entry text and passwords never reach the
  artifact; GTK3 can announce a labelled entry as `text`, so the text roles are
  excluded too. A control whose AT-SPI value is a finite number (a slider, a
  progress bar, a spin button, a scroll bar) reports that number as `value`;
  other roles are not probed, because the value interface costs a request
  reference. The number is `atspi_value_get_current_value`, not the interface
  pointer: the previous reader treated the pointer as the value and could write
  a memory address into the tree.
- Accessibility association is all-or-nothing **and says why**: an X11 client
  that AT-SPI does not see (no toolkit bridge) or does not match by exact geometry
  fails with `NATIVE_AX_PARTIAL`, with the X11/AT-SPI window counts in the
  error's `details` (and on the session), never as `NATIVE_WINDOW_NOT_FOUND`
  ("the app has no window") and never as an empty tree.
- A target that exits between selection and capture is `NATIVE_TARGET_EXITED`;
  `NATIVE_WINDOW_CHANGED` is reserved for an X11/AT-SPI identity or geometry
  change on a live target.

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

Integration dependencies: `python3-xlib`, GTK3/Atk Python GI, `at-spi2-core`, `libatk-adaptor`,
D-Bus, Xvfb, xcompmgr (started before the fixture), and the shared libraries above. The fixture uses only its own local
windows and requires all three profiles below. Base and matrix retain their trees
and PNGs; `report.json` records the verdicts. Missing Xlib is a failure, never UNRUN:

- **base** (`fixture.py`): real stable IDs, duplicate-title surfaces, ambiguous
  windows refused without an explicit selector, client-local semantic rectangles
  against known red pixels, a foreign green occluder that must not appear in the
  selected window image, a slider's numeric value (`fixture.level`, `4`), a
  bounded/truncated capture, entry text never collected, and
  `NATIVE_TARGET_EXITED` after the target ends.
- **matrix** (`fixture.py --matrix`): one window holding a named button, an
  unnamed button, an entry, a password entry, a check button, a toggle button,
  radio buttons, a notebook (its tab list keeps `fixture.pages`/`Pages`, one
  selected tab and that tab's selected page label), a combo box, a scrolled list,
  a disabled button and an image. Every identifier's announced role, name, states
  and native action names are asserted, and the entry/password text must not
  appear anywhere in the artifact.

- **partial-association**: a plain Xlib client publishes `_NET_WM_PID`; an
  independent X11 query verifies its owner and visible geometry. With no AT-SPI
  bridge, both `window.list` and `window.select` must return `NATIVE_AX_PARTIAL`,
  with counts of one X11 window, zero AT-SPI windows and zero AT-SPI apps.
  `partial.json` retains the actual windows, responses and protocol history;
  no normal empty tree is accepted. Closing the session leaves the client alive.

The CI artifact includes `SHA256SUMS` over all evidence including the live
TypeScript verdict, excluding the checksum manifest itself. Unsupported Wayland,
XWayland, physical input and real GPUI/MZed applications remain unverified.

The fixture import smoke (`test_fixture.py`) builds both fixtures in a child
process without entering `Gtk.main()`, so a fixture that stops building fails the
pure suite instead of timing out; a host without a display skips it, and the live
lane remains the evidence for the fixture's GTK behavior.

The fixture's setup/teardown launches and terminates only its own test processes;
the observer never does so.

Pure tests do not establish live desktop acceptance. Review the integration
report and CI result before treating the backend as accepted. GPUI/other toolkit
accessibility exposure, decorated windows, scaling and Wayland need separate
acceptance evidence and are not inferred from GTK/Xvfb.


## Observed profile

The Ubuntu 24.04 / Xvfb / xcompmgr / GTK3 scale-1 fixture profile passed hosted
observation and actual TypeScript scan-to-generic-judge acceptance at source
`96249baad0b7e7c499f1f797db92bcd29a3d078c`.
See the [acceptance report](../../docs/reports/2026-10-05-linux-native-observer.md)
for exact versions, tests and retained artifact. The later bounded-traversal and
semantics-matrix work, and which of its checks have been observed on a hosted
runner rather than only run as pure tests, is recorded in
[2026-10-20-linux-native-observer-v2](../../docs/reports/2026-10-20-linux-native-observer-v2.md).
The follow-up review that fixed value reading (an interface pointer could become
`value`), the double visit charge and the fixture notebook's own identity is
[2026-10-20-linux-observer-review](../../docs/reports/2026-10-20-linux-observer-review.md);
its hosted lane passed at `b851e98a`
([run 39391132215](https://github.com/f4ah6o/vlmkit/actions/runs/39391132215):
`observer` and `transport`, `report.json` `passed: true`), still only for the
GTK3/Xvfb/xcompmgr profile. Neither is a general desktop, Wayland, GPUI/MZed or
physical-input support claim.
