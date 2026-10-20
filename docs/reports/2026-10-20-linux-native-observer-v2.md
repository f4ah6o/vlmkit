# Linux native observer v2: bounded traversal and a GTK semantics matrix — 2026-10-20

Status: observer-side implementation complete; the hosted X11 lane **passed** on source
`d8c3ddf0` ([run 39361423462](https://github.com/f4ah6o/vlmkit/actions/runs/39361423462):
`observer` and `transport` both green, 16/16 fixture checks, live TypeScript scan and
generic judge pass). The one profile still unrun is the X11-only partial-association
check (`python3-xlib` is not installed in the lane). Broader X11, Wayland, physical
input and GPUI/MZed acceptance remain open in the
[Linux packet](../../issues/open/20261005-linux-native-observer.md).

This round closes the observer's own remaining gaps in three parts: it lands the
unmerged bounded-traversal fix, replaces the profile's honest "no values" with an
explicit rule, and adds a GTK semantics matrix that asserts what each control
announces. Nothing here adds physical input, Wayland support, launch/termination or
toolkit-independent coordinates, and no row below claims a profile it did not observe.

## Evidence status

| what | outcome | basis |
|---|---|---|
| Python pure suite (`native/linux/test_*.py`) | **PASS**, 35 tests, 2 skipped | run in this sandbox: `python3 -m unittest discover -s native/linux -p 'test_*.py'` |
| Fixture import smoke (base + matrix) | **SKIPPED** by design | it imports GTK, which needs a display; the live lane below is what proves the fixtures build |
| `linux-agent.test.ts` + `native-agent.test.ts` (vitest transport lane) | **PASS** — `transport` job, [39361423462](https://github.com/f4ah6o/vlmkit/actions/runs/39361423462) | ran hosted; the author's sandbox could not install dependencies (`EROFS`) |
| GTK/Xvfb/xcompmgr fixture lane (`integration.py`) | **PASS** — [run 39361211824](https://github.com/f4ah6o/vlmkit/actions/runs/39361211824), then again at the final source in [39361423462](https://github.com/f4ah6o/vlmkit/actions/runs/39361423462) (`report.json` `passed: true`, SHA-256 `c402cc74…`) | all 16 checks: base (occlusion, ambiguity, truncation, entry text absent, `NATIVE_TARGET_EXITED`, close detaches), the semantics matrix, and `NATIVE_X11_CLIENT_FRAME`/no attribute diagnostics |
| Semantics-matrix live assertions | **PASS** (same run) | observed, per control: `push button→button`, `text→text` (the labelled entry), `password text→textfield`, `check box→checkbox` `checked`, `toggle button→button`, `radio button→radio` (`Mode A` checked), `page tab list→group` with one `selected` tab, `combo box→combobox`, `image→image`, plus native `atspi:click`/`atspi:activate`/`atspi:press` action names |
| Recorded fixture (`fixtures/native/linux/matrix`) | **PASS** in the `transport` job of 39361423462 | re-recorded from the hosted tree; the judge's rules give one finding (the unnamed `button[12]`), which is what `expected.json` holds |
| X11-only partial association (`python3-xlib`) | **UNRUN** in the lane | `python3-xlib` is not installed; the profile records that reason in `report.json` rather than skipping silently |

### Hosted runs

Each run on this branch was read from its log and, where an artifact was retained, from
the artifact itself:

| run | result | what it found | change |
|---|---|---|---|
| [39357777170](https://github.com/f4ah6o/vlmkit/actions/runs/39357777170) | transport FAIL | the fake observer could not answer `ok:false` overrides, so the partial-code regression hit `snapshot.capture` | fake agent honours `{error}` overrides |
| [39357942889](https://github.com/f4ah6o/vlmkit/actions/runs/39357942889) | observer FAIL | `fixture.name` is announced as platform role `text`, not `entry` | accepted names per control |
| [39358995057](https://github.com/f4ah6o/vlmkit/actions/runs/39358995057) | observer FAIL | naming `Atk.Role.ENTRY` did not change the announcement; `role` still normalized to `text` | an accepted alternative is recorded as announced |
| [39359119107](https://github.com/f4ah6o/vlmkit/actions/runs/39359119107) | observer FAIL | `fixture.tab.one` missing: the notebook announces the current page on its `page tab list`, the tab carries the `selected` state | the matrix asserts the tab list by its page name; the tab by its state |
| [39359445974](https://github.com/f4ah6o/vlmkit/actions/runs/39359445974) | observer FAIL, transport PASS | the same tab finding was then re-asserted by the normalized-role guard | tab found by announced page name, `page tab list` mapped to `group` |
| [39359993201](https://github.com/f4ah6o/vlmkit/actions/runs/39359993201) | observer FAIL, transport PASS | the retained tree showed the tab list inheriting the second tab's identifier, so the selected tab had none | one tab identifier (`fixture.tabs`), asserted on the tab's `selected` state |
| [39360303322](https://github.com/f4ah6o/vlmkit/actions/runs/39360303322) | observer FAIL, transport PASS | the tab identifier landed on the **page label** (`fixture.tabs.page`), and the tab list still kept the second tab's identifier | the tab is identified before the tab list's own name/id is set, and the tab list is cleared afterwards |
| [39360516307](https://github.com/f4ah6o/vlmkit/actions/runs/39360516307) | observer FAIL, transport PASS | setting the notebook's accessible after the pages changed nothing: GTK3's notebook accessible *is* the tab list and takes the last tab's name and id | the tabs are identified by name and their `selected` state; no tab identifier is claimed |
| [39360737238](https://github.com/f4ah6o/vlmkit/actions/runs/39360737238) | observer FAIL, transport PASS | the selected tab is a `page tab` that carries no name, so a named-tab assertion cannot hold | the notebook is asserted by its selected tab's state and selected page label |
| [39360963811](https://github.com/f4ah6o/vlmkit/actions/runs/39360963811) | observer FAIL, transport PASS | the tab list's own name is the last tab's; the expected normalized-role table lacked `page tab list`/`table`/`scroll bar` | no declared tab-list name; the observer's expected roles table learns the three roles |
| [39361211824](https://github.com/f4ah6o/vlmkit/actions/runs/39361211824) | fixture lane PASS, live TypeScript FAIL | every capture carries a `NATIVE_X11_CLIENT_FRAME` note the live test did not accept | accepted by name, alongside the geometry-less-widget diagnostic |
| [39361423462](https://github.com/f4ah6o/vlmkit/actions/runs/39361423462) | **observer PASS, transport PASS** | — | final source of this round (`d8c3ddf0`) |

The retained artifact of each run was read to make these rows: the base profile's tree
(7 nodes, identifier/actions/`disabled` present, no entry text) is the shape the generic
judge already consumes, and the matrix tree is what `fixtures/native/linux/matrix` now
records.

Artifact: [linux-x11-observer-evidence, run 39361423462](https://github.com/f4ah6o/vlmkit/actions/runs/39361423462/artifacts/12237691766)
(30,345 bytes, retained to 2026-11-03) with `SHA256SUMS`, `report.json`, both trees and
frames, and `ts-live/verdict.json` (`"success"`).

A skipped lane is not a pass. The previous round's hosted PASS
(`docs/reports/2026-10-05-linux-native-observer.md`) remains evidence for the code at
`96249baad0b7e7c499f1f797db92bcd29a3d078c`, not for anything in this round.

## 1. Bounded traversal (landed from an unmerged branch, reviewed)

The packet's "distinct visited-node/reference budget" item was already implemented and
tested on `origin/codex/linux-test-env-gi-cairo-20261008` as commit `30872529` ("Bound
Linux AT-SPI observer traversal resources"). It is cherry-picked here (with `-x`, so its
provenance stays in the log) rather than re-implemented. It adds: lazy depth-first
traversal that acquires one child at a time, request-wide 20,000-visited /
50,000-reference budgets reserved **before** each remote call, prompt release of
enumeration refs, per-request `begin_request`/`release`, and one reference slot reserved
for the pre-capture geometry revalidation.

Reviewing it against this repository's `observer.py` found two defects and a
double-release; the tests that encoded the old budget arithmetic were updated with the
reason at each assertion:

- **The root was never charged.** `collect()` started `visited = 1` "already retained by
  caller" but did not put the root in `seen`, so a root that re-entered itself (a cycle
  through the frame) could be visited again. The root is now a visited node like any
  other: charged to the budget and in `seen` before traversal. Tests that hard-coded the
  old off-by-one were updated with the reason at each assertion.
- **A non-budget failure erased the node.** If reading any attribute raised (for example
  a `NATIVE_AX_TRUNCATED` from the action-count bound), the whole `try` block was
  abandoned: the node was not emitted and its children were not traversed. Each optional
  attribute now reads in its own guard, so one bad attribute is a diagnostic and the node
  and its subtree survive. The hard budgets (timeout, visit limit, reference limit) still
  stop traversal, and are now one named constant (`HARD_BUDGET_CODES`) used by both
  `collect()` and the agent.
- Every request was released twice — `Agent.dispatch`'s `finally` and `main()`'s — so
  the ref list was walked and cleared once for nothing. The cleanup now lives in
  `dispatch` alone, which is also what the test asserting the selected window's
  dedicated ref outlives a request observes. `release_obj` scans the list forward
  instead of backwards from the end.

## 2. What the profile says about values

The README said "Values and text contents are not collected in this initial
profile". That remains the rule for **text entry**, and it is now stated as a policy
rather than an accident:

- `entry` and `password text` never report `value` — the text is content, and a password
  value is never read at all (the AT-SPI call is not made for those roles).
- Any other role whose AT-SPI value is a deterministic scalar (string, integer, finite
  float) may report `value`, bounded to 256 characters; complex layouts are omitted
  rather than serialized.
- The live matrix asserts that neither the entry's text nor the password's text appears
  anywhere in the tree file.

## 3. Fail-closed association, exit taxonomy, XWayland

- **`NATIVE_AX_PARTIAL`** now distinguishes "X11 sees the client but AT-SPI does not" (no
  toolkit bridge, or geometry refuses the pair) from `NATIVE_WINDOW_NOT_FOUND`. The
  counts (`x11Windows`, `atspiWindows`, `atspiApps`) are kept on the session as evidence,
  and `window.select` returns them as `diagnostics` so a caller retrying a toolkit that
  is still starting can say why. An empty tree is never produced.
- **Exit is `NATIVE_TARGET_EXITED`.** The target's process identity is re-checked after
  traversal and after pixel capture, so an app that exits mid-capture is not reported as
  an X11 window that changed shape.
- **XWayland is refused by the server, not the environment.** `backend()` still refuses
  on `WAYLAND_DISPLAY`/`XDG_SESSION_TYPE`, and now also asks the X server for the
  `XWAYLAND` extension (opcode out-parameter, not the success return), so a process whose
  Wayland variables are absent but whose `DISPLAY` is Xwayland fails closed too.
- `--max-depth`/`maxNodes` defaults are one pair of constants shared by the agent and
  `collect()` (64 / 10,000, clamped to 128 / 10,000).
- `image` maps to `image`. The previous table had no `image` entry, so a drawing area
  kept `image` as its role string anyway — the mapping now says so, and the matrix
  control that depends on it is tested.

## 4. The GTK semantics matrix

`native/linux/fixture.py --matrix` builds one undecorated 360x560 window, the same PID,
holding: a named button (`fixture.save`), an entry (`fixture.name`, text "Fixture
value"), a password entry (`fixture.secret`, text "hunter2"), a check button
(`fixture.remember`, active), a toggle button, two radio buttons (`fixture.mode.a`
active), a notebook with two named tabs, a combo box, a scrolled list view, a disabled
button and an image (`fixture.color`, opaque red). The window's controls carry
identifiers wherever GTK exposes them.

`native/linux/integration.py` drives it through the real observer and asserts, per
identifier: the AT-SPI platform role, the normalized role, the name, the required
states, a boolean value for every state key the node has, and at least one native
`atspi:` action name for controls GTK exposes actions on. It then asserts that the entry
and password texts appear nowhere in the tree file, that the unnamed button has no name,
that the image rect's centre pixel is red, and that the selected window is 360x560 on
screen and in the frame.

The base profile keeps every check from the previous round and adds: a second window
with the same title must not be selected without an explicit selector
(`NATIVE_WINDOW_AMBIGUOUS`), entry text is absent, and a stopped target yields
`NATIVE_TARGET_EXITED`.

A third profile is attempted and recorded honestly: an X11-only client (plain Xlib, no
toolkit) must be reported as `NATIVE_AX_PARTIAL`. It needs `python3-xlib`, which the CI
lane does not install; without it the profile records **UNRUN** with its reason rather
than skipping silently.

Recorded contract fixture: `fixtures/native/linux/matrix/` (`a11y.json`, `frame.png`,
`expected.json`) is recorded from the hosted lane ([39359445974](https://github.com/f4ah6o/vlmkit/actions/runs/39359445974)'s
retained tree), and the unchanged generic judge reads it (`linux-agent.test.ts`, "Linux recorded matrix artifact"). It is a
contract fixture, not a live recording — the live tree is the artifact the CI lane
retains. The committed `a11y.json` is trimmed from the hosted tree (18 nodes: the identified
controls, the tab list and its tabs/pages, the combo box and its list); `frame.png` is a
synthetic calibration PNG for the image rect, not that run's screenshot, and
`expected.json` says so.

## 5. Lane changes

`.github/workflows/linux-native-observer.yml`:

- measured on three runs: GTK3 announces the matrix's `GtkEntry` as `text`, not `entry`,
  even after the fixture names `Atk.Role.ENTRY`. The matrix now accepts the toolkit's
  own name for a control (`MATRIX_ROLE_NAMES`) and records the normalized role of what
  was announced, keeping the claims it can still make for that node: its name, its
  states, the exact role each accepted name normalizes to, and that it carries no
  value. A GTK4 entry will need the same treatment once that toolkit is qualified;
- the fixture step now produces both profiles under `test-results/native/linux/`
  (`base` beside the output, `matrix/` under it);
- a step records `SHA256SUMS` for the retained artifact;
- the live TypeScript step keeps its own verdict (`ts-live/verdict.json`) **and** still
  fails the job when it did not succeed — a separate step checks
  `steps.live.outcome`, so the verdict is visible even when the step fails;
- `tests/workflow-commands.test.mjs` now refuses `run:` lines that end in `|| true` or
  `; true`, because a swallowed exit code is how a lane reports green while measuring
  nothing.

## Not claimed

- No Wayland or XWayland observation, no portal surface identity, no HiDPI/fractional
  scale, no decorated (CSD/SSD) window admission.
- No physical or semantic input on Linux; the observer remains read-only.
- No other toolkit (Qt, Electron, GTK4) — only the GTK3 fixture profile, and only once
  the hosted lane passes on this source.
- No GPUI/MZed accessibility claim: gpui.mbt's native accessibility adapters are the
  framework's work, and missing accessibility is reported, never synthesized.
- No whole-repository typecheck/build claim: it cannot be run in this sandbox (no
  installed dependencies), and the previously reported base error in
  `packages/vlmkit-ai/src/provenance.ts` is out of this packet's scope.
