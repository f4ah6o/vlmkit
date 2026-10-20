# Linux native observer review: values, visit accounting and the fixture — 2026-10-20

Status: implementation complete; the **pure Python suite passes** (37 tests, ~0.3 s),
and four live GTK3 probes pass on a real X11/AT-SPI session. **The hosted X11 lane
has not run on this source**, so the v2 PASS (`d8c3ddf0`,
[run 39361423462](https://github.com/f4ah6o/vlmkit/actions/runs/39361423462)) is
not evidence for these changes. The full `integration.py` lane could not run in
this sandbox: there is no `Xvfb`/`xcompmgr`, and the shell's PID namespace makes
the X11 client's `_NET_WM_PID` differ from the process id AT-SPI reports, so the
observer's same-PID association cannot bind (which is itself the partial-tree
path, not a fixture failure).

Scope: the fork's Linux observer (`native/linux/`) and the `vlmkit-a11y/1`
artifacts it writes. The repository's other fork additions — the macOS
AX/ScreenCaptureKit observer, `check renderer-parity`, the content-provenance /
egress policy and the MoonBit toolchain bump — were surveyed but not changed in
this round.

## What was wrong

### 1. A memory address could be written as a control's `value`

`Atspi.value()` called the deprecated `atspi_accessible_get_value` as if it
returned a scalar. The C API returns an **`AtspiValue*`**
(`atspi-accessible.h:138`; its non-deprecated `..._get_value_iface` form is line
161 and is what the fix calls), and the value is the interface's `gdouble`
(`atspi_value_get_current_value`, `atspi-value.h:51`).
The pointer was an `int` to Python, so `scalar_value()` formatted it as a decimal
string and wrote it into the tree. The call also passed a `GError**` that the
one-argument function does not take.

Measured on a live GTK3 window (direct `collect()`, no X11 association needed):

| control | platform role | value before | value after |
|---|---|---|---|
| slider (`fixture.level`, set to 4) | `slider` | `516171760` | `4` |
| spin button (37) | `spin button` | `516163712` | `37` |
| progress bar (0.25) | `progress bar` | `515959312` | `0.25` |
| two scrolled-window bars | `scroll bar` | `265132240`, `265132432` | `0`, `0` |
| labelled entry | `text` | `None` | `None` |

The matrix had no assertion that read a non-entry value, and the committed
contract fixture trims the scroll bars out. The
text-entry rule also named only `entry`/`password text`, but GTK3 announces a
labelled `GtkEntry` as `text`; the value rule now names the text roles too and
only probes roles whose value is numeric.

### 2. Every traversed node was charged twice to the visit budget

`collect()` kept the pre-acquisition `visited += 1` from the cherry-picked
bounded-traversal commit **and** added an entry-time `visited += 1` when the root
started being charged. A child therefore cost two visits (one before
`child_at`, one on entry), so the documented 20,000-visited budget admitted about
10,000 nodes. The tests encoded the accidental arithmetic: a budget of 2 refused
a child that the "root + one child" comment says should fit.

The entry-time charge is now the only charge; the pre-fetch check remains, so a
wide parent is still not acquired past the budget. Updated expectations:
`max_visited=1` refuses the child before acquisition; `max_visited=2` admits root
+ child; a wide geometry-less parent with a budget of 4 fetches 3 children and
counts 7 truncated (was 2 and 9).

### 3. The matrix fixture overwrote its own notebook identity

`page.get_parent()` is the `Gtk.Notebook`, not the tab label. The fixture called
`page.get_parent().get_accessible().set_name(label)` for each page, so the tab
list's name became the last tab's (`"Two"`) and the v2 round concluded GTK3 was
doing it. A live probe of a notebook whose tab labels are named but not
identified shows the tab list keeps its own name and id:

```
page tab list | 'Pages' | id='fixture.pages'
  page tab 'One' selected -> label 'First page' id='fixture.page.one'
  page tab 'Two'           -> label 'Second page' id='fixture.page.two'
```

The fixture now names the tab label it creates, the matrix identifies the
notebook by **`fixture.pages`** (no pseudo `fixture.tabs`), and the selected tab /
selected page label assertions are unchanged. The committed
`fixtures/native/linux/matrix/a11y.json` is the older recorded contract fixture and
still shows the notebook name `Two`; it is read as an artifact by the unchanged
TypeScript judge test, while the live matrix lane asserts the current fixture. The duplicate role table in
`integration.py` (`observer_role`) was removed; the per-control expectation is
`MATRIX_ROLE`, one accepted normalized role per accepted platform name, so the
`entry -> textfield` and `text -> text` alternatives are both pinned
independently of the observer's output.

### 4. The fixture import smoke could only time out

`fixture.py` called `Gtk.main()` at import. `test_fixture.py` runs it through
`runpy` in a child process and waits for the window count, so on a host with a
display the child never returned: each of the two tests waited out its 30 s
subprocess timeout and skipped. On a host without a display it skipped
immediately. The smoke test could not catch a renamed or broken control in
either case.

`fixture.py` now separates `build_windows()` from `run()` and calls `Gtk.main()`
only under `if __name__ == '__main__'`. The child prints the window count and
exits. Pure suite measurements:

| | tests | time | skips |
|---|---|---|---|
| before (this sandbox has a display) | 35 | 60.1 s (two 30 s timeouts) | 2 |
| after, display | 37 | ~0.3 s | 0 |
| after, `env -u DISPLAY` | 37 | ~0.3 s | 2 |

### 5. Dead code and repeated tables

- `Agent.windows()` ended with two identical `return` statements; the second was
  unreachable.
- `collect()` re-implemented `role_of()` inline (`ROLES.get(...) or 'unknown'`).
- `integration.py` kept a second copy of the whole role table that no test
  pinned; `capture_matrix` used it as a fallback that accepted whatever the
  observer produced for `text`. The matrix now checks the per-name expectation.
- The 15-second deadline, 1-second call timeout, 64 KiB request bound, action
  bound and X11/window bounds were repeated literals; they are named constants.

### 6. Partial-association counts never reached the caller

The v2 report says `window.select` returns the X11/AT-SPI counts as diagnostics.
On failure the counts stayed on the session and the protocol error carried only
`{code, message}`; on success the diagnostics were always empty (the success
path clears them), so that always-empty field is gone. `Failure` now carries
`details`, `Agent.windows()` raises the partial error with the counts, and
`main()` serializes them. The TS transport already reads `error.details`.

Measured over NDJSON against a fixture the observer could not associate:

```json
{"code":"NATIVE_AX_PARTIAL",
 "message":"X11 client window(s) found, but AT-SPI exposes no same-PID window: ...",
 "details":{"x11Windows":1,"atspiWindows":0,"atspiApps":0}}
```

## Verification

```sh
python3 -m unittest discover -s native/linux -p 'test_*.py' -v
env -u DISPLAY python3 -m unittest discover -s native/linux -p 'test_*.py'
```

| what | outcome |
|---|---|
| Pure suite with a display | **PASS** — 37 tests, ~0.3 s, 0 skipped |
| Pure suite without a display | **PASS** — 37 tests, ~0.3 s, 2 skipped (GTK fixtures) |
| Live value probe (slider, spin button, progress bar, entry) | **PASS** — `4`, `37`, `0.25`, no entry value |
| Live matrix replay of the 11 `MATRIX` controls | **PASS** — roles/names/states/actions, 25 nodes, `truncated: 0`, no text leak |
| Live base fixture (`fixture.py`) | **PASS** — `fixture.level` role `slider`, value `4`, rect inside the 360x260 client |
| NDJSON partial error | **PASS** — `NATIVE_AX_PARTIAL` with `details` counts |
| Full `integration.py` X11 lane | **UNRUN** here (no Xvfb/xcompmgr; PID namespace separates the ids) |
| Hosted `.github/workflows/linux-native-observer.yml` | **UNRUN** on this source |

The permanent regressions are in the pure suite (`test_observer.py` pins the
`AtspiValue` API shape, numeric formatting, text-role exclusion, one-charge-per-
node budgets and the error details; `test_fixture.py` pins the matrix's accepted
roles and builds both fixtures) and in `integration.py` (the base profile asserts
`fixture.level == "4"`; the matrix asserts `fixture.pages`/`Pages`).

## Not claimed

- No hosted PASS for this source. The next lane run is the evidence; this round
  only proves the pure contracts and the live GTK probes above.
- No Wayland/XWayland, other toolkits, scale != 1, physical input or broader
  desktop acceptance — unchanged from the v2 packet.
- No review of `renderer-parity`, the macOS observer or the provenance policy
  beyond reading them for the fork survey; no TypeScript test ran here (the
  workspace has no installed dependencies).
