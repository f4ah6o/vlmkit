# Flutter browser regressions — 2026-10-03

The four browser regressions left unverified in
[the native observer acceptance report](2026-10-03-native-observer-p0.md)
now pass: **4 passed, 0 failed**. The runner exited 0 in 6.36 seconds.

Tested checkout: `589097ecaba32162ebac2c9c1dc9bdce0a7a0de6` of
`f4ah6o/vlmkit`. No application, fixture, or test code was changed.

## Environment and command

- Linux cloud environment, Node.js 24.19.0, Vite+ 1.0.0 / Vitest 5.0.1.
- Playwright 1.63.0, its downloaded Chrome Headless Shell 153.0.8010.12
  (`chromium-headless-shell` revision 1243). No system-browser substitution.
- MoonBit `moon 0.1.20260920` (`914d7da`), required by the touch-target judge.
- Built `@mizchi/vlmkit-judge` and `@mizchi/vlmkit-core` with `vp pack --filter`.
  The test runner built the MoonBit modules on demand.

```bash
export PATH="$HOME/.moon/bin:$PATH"
./node_modules/.bin/vp test run \
  packages/vlmkit-markup/src/a11y-tree/a11y-tree.test.ts \
  -t 'scan a11y → check a11y tree on a Flutter-shaped page' \
  --reporter=verbose --reporter=json \
  --outputFile=test-results/flutter-browser/results.json
```

## Results

| Case | Result | Duration |
| --- | --- | --- |
| Enables semantics and detects exactly the planted naming, reachability, contrast, and touch-target defects | PASS | 1536 ms |
| Rejects a misspelled `--click` exact name and lists tappable names | PASS | 957 ms |
| Writes a never-built semantics tree with zero nodes, named nodes, and interactive nodes | PASS | 3207 ms |
| Rejects a non-Flutter page and points to DOM accessibility gates | PASS | 123 ms |

The other four cases in this file (pure Flutter role mapping and Android import)
were intentionally skipped by the test-name filter. The screenshot-backed first
case checks the actual browser capture and generic judges, including disabled
controls and WCAG spacing exemptions.

These cases use `fixtures/a11y-tree/flutter-like.html`, an HTML/canvas stand-in
for Flutter's transparent semantics DOM. They do not exercise a compiled Flutter
engine or a live deployed Flutter app.

The first browser run passed three cases and stopped the first case with
`spawnSync moon ENOENT`. Installing the required MoonBit CLI and rerunning the
same four cases resolved that environment failure. The final machine-readable
result is in `test-results/flutter-browser/results.json` (gitignored).
