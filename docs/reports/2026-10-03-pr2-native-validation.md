# PR #2 Native UI driver P2–P5 validation

Date: 2026-10-03. Target: [f4ah6o/vlmkit#2](https://github.com/f4ah6o/vlmkit/pull/2),
branch `codex/native-p2-actions-20261003` (draft).
Starting PR HEAD: `2b663ec3ace2bbd1a4a86ec41a602490f2cc4a10`.
Fetched main: `4be3177a62d8a3304e1cb09958dc5deab92d7eff`.
The initial PR diff contains 26 files, 2,855 insertions and 107 deletions.

Validation uses `/Volumes/devstorage/Developer/vlmkit-pr2-validation`, a separate
worktree checked out at the PR HEAD. The original checkout remains on main with
its pre-existing README and issue changes preserved. No reset, clean, stash,
force push, main push, issue move, or PR state change was performed.

## Environment and command selection

macOS 26.5.2, arm64; Node 26.8.2; pnpm 10.29.3; Swift 6.3.3;
MoonBit 0.1.20260920. Commands were selected from `.claude/CLAUDE.md`, root
`package.json`, `pnpm-workspace.yaml`, `vite.config.ts`, `tsconfig.json`, README,
`.github/workflows/unit-tests.yml` and `native/macos/{README.md,Package.swift}`.
There is no root lint script; `vp lint` is configured and callable.

No model API or secret was needed. Tests unset `OPENROUTER_API_KEY` as documented
for missing-key assertions. No 1Password developer environment was accessed.

## Fixes

1. Swift `describeElement()` omitted the required `reader:` argument label when
   calling `normalizedActions()`. This prevented the native agent from building.
2. Native grounding passed an `{x,y,width,height}` screenshot bbox into an
   intersection helper reading `left/top`. The resulting NaNs marked controls
   out of frame and skipped hit testing. The helper now reads `x/y`; a Retina
   contract regression test checks exact finite hit coordinates.
3. Native snapshot dereferenced the nullable return of `generateDiffReport()`.
   It now checks the result before reading shift/compensation fields.
4. Native snapshot's existing rejection test failed because a browser URL's error
   omitted the expected `macos:` target requirement. The diagnostic now states it.
5. A main-inherited `readonly Array<T>` parse error in AI provenance prevented
   every complete build. The minimal `ReadonlyArray<T>` correction unblocks the
   build; this is recorded separately from PR-introduced defects.
6. Applied the required Oxfmt formatting to PR files. Unrelated main-inherited
   formatting changes were removed from this worktree's patch.

Additional unit tests cover native flow dispatch, AX postconditions, stopping
at the first failure, CSS selector rejection and session close; native gate
option constraints; native checkbox activation/focus evidence; and the native
VRT pipeline (new baseline, identical capture, then a pixel change with exit 1).
Mocks and synthetic contract fixtures are explicitly labelled and do not count
as macOS live, GPUI, or multi-display acceptance.

## Results

| Check | Status | Evidence |
| --- | --- | --- |
| Frozen-lockfile install | PASS | `pnpm install --frozen-lockfile` |
| Complete JS/MoonBit build | PASS | `pnpm build`, repeated after fixes |
| Swift debug build | PASS | `swift build --package-path native/macos` |
| Swift tests | PASS | 8 XCTest tests, repeated after fixes |
| Release app bundle build/sign | PASS | `bash native/macos/script/build_and_run.sh --build-only` |
| MoonBit markup tests/check | PASS | 39 tests; check completed, warnings retained |
| Targeted native + browser tests | PASS | 11 files, 128 tests; additional interaction-map unit test passed |
| Whole unit suite | FAIL (main inherited) | Final rerun: 4,017 passed, 1 failed, 319 files; all new tests pass |
| Whole typecheck | FAIL (main inherited) | Four remaining diagnostics listed below |
| Whole lint | PASS with warnings | `pnpm exec vp lint`, exit 0; warnings retained |
| Whole format check | FAIL (main inherited) | Nine unrelated AI/benchmark files; native changed files pass |
| Native CLI doctor/help/invalid option | PASS | Live passive doctor `ok:true`; help exits 0; unknown flag exits 1 |
| macOS integration script | FAIL / environment limitation | No visible capturable fixture AX windows; live checks NOT RUN |
| GPUI acceptance | NOT RUN | No usable GPUI `.app` target was supplied or located |
| Multi-display acceptance | NOT RUN | No available multi-display setup verified |

The final complete rerun finished with **4,017 passed, 1 failed, 319 files**
(283.93 seconds), including all four added test files. The preceding full run
finished with 4,009 passed, 1 failed, 315 files. The sole failure is `src/cli/version.test.ts`: it requires
the first changelog heading to be `0.23.2`, whereas `CHANGELOG.md` starts with
`Unreleased`. Both files are byte-identical to fetched main.

Remaining typecheck errors are also in files byte-identical to fetched main:

- `packages/vlmkit-ai/src/zoom.test.ts:480` and
  `src/experiments/benchmark/vlm-bench.ts:202`: `provenance` is not accepted by
  the zoom input type.
- `src/api/api-app.test.ts:282` and `src/api/client.ts:145`: required
  `CloudflareScreenshotResult.contentPolicy` is missing.

The nine whole-repo format failures are `image-gen-client{,.test}.ts`,
`provenance.test.ts`, `reasoning-pipeline.test.ts`, `vlm-client{,.test}.ts`,
`zoom-drivers.ts`, `zoom.test.ts` under `packages/vlmkit-ai/src/`, and
`src/experiments/benchmark/vlm-bench.ts`. These are outside this PR's original
changes and remain untouched. Native files and newly added tests pass targeted
format checks.

## Environment limitations and initial failures

The first JS build/typecheck attempt started before install finished and failed
on missing dependencies. These preparation failures were superseded by reruns.
A later typecheck overlapping a build saw transient missing `dist` declarations;
it was repeated after both builds had completed. Newly added test typing errors
were corrected before the final typecheck.

Playwright's downloader repeatedly timed out. The first full suite therefore
failed with missing Chromium (391 failed, 3,562 passed, 56 skipped). Official
Chromium 153.0.8010.12 and headless-shell archives were then fetched with curl,
extracted to `/tmp/vlmkit-pr2-browsers`, and their real browser launch verified.
All subsequent browser runs use `PLAYWRIGHT_BROWSERS_PATH` pointing there.
No substituted older browser or fake browser PASS is claimed.

Passive doctor reports Accessibility and Screen Recording authorization, but
`integration.mjs` fails at `fixture exposed no visible capturable AX windows`.
A separate direct launch of the local fixture also returned `window.list: []`.
CoreGraphics active display enumeration returned 0 (success status), while
AppKit reported one screen. Thus permissions alone did not provide a usable live
window/display session. This remains an environment limitation, not evidence
that the remaining live actions passed, and is not proof of the exact host cause.

No live GPUI app was used. No multi-display move/resize/scaling was tested.
All three `issues/open/20261003-*.md` native issues stay open.

## Diff review

Target: PR #2 plus these validation fixes. Base: fetched `origin/main`.
Verdict: deterministic coverage is verified; live acceptance remains incomplete.
Reviewed correctness/behavior, safety/boundaries/error handling, and tests/integration.
API compatibility, process/session cleanup, native coordinate mapping, locator
ambiguity, evidence redaction, and browser regression were included. The confirmed
defects are corrected above; no additional confirmed defect is reported. This does
not remove the requirement to run macOS live, GPUI and multi-display acceptance.

The final patch contains the listed corrections, labelled regression tests, native
formatting and this report. `git diff --check` passes. No issue file is modified
by the validation patch, and the isolated worktree is clean after committing.

## Verification command record

Run from the isolated worktree unless otherwise stated. Repeated invocations
were used after the documented corrections; read-only inspection additionally
used `cat`, `sed`, `rg`, `git show`, `git diff`, `git status`, and `ps`.

```sh
# PR checkout and protection of original work
 git status --short --branch
 git remote -v
 gh pr view 2 --repo f4ah6o/vlmkit --json headRefName,headRefOid,baseRefName,isDraft,url
 git fetch origin main codex/native-p2-actions-20261003
 git diff --stat origin/main...origin/codex/native-p2-actions-20261003
 git worktree add /Volumes/devstorage/Developer/vlmkit-pr2-validation -b codex/native-p2-actions-20261003 origin/codex/native-p2-actions-20261003

# Install, toolchain and browser preparation
 uname -a
 node --version
 pnpm --version
 swift --version
 export PATH="$HOME/.moon/bin:$PATH"
 moon version
 pnpm install --frozen-lockfile
 pnpm exec playwright install chromium
 NODE_USE_ENV_PROXY=1 PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=120000 pnpm exec playwright install chromium
 pnpm exec playwright install --dry-run chromium
 curl -IL --connect-timeout 10 --max-time 20 https://cdn.playwright.dev/builds/cft/153.0.8010.12/mac-arm64/chrome-mac-arm64.zip
 curl -L --connect-timeout 10 --max-time 180 -o /tmp/vlmkit-pr2-chromium.zip https://cdn.playwright.dev/builds/cft/153.0.8010.12/mac-arm64/chrome-mac-arm64.zip
 curl -L --connect-timeout 10 --max-time 180 -o /tmp/vlmkit-pr2-headless.zip https://cdn.playwright.dev/builds/cft/153.0.8010.12/mac-arm64/chrome-headless-shell-mac-arm64.zip
 mkdir -p /tmp/vlmkit-pr2-browsers/chromium-1243 /tmp/vlmkit-pr2-browsers/chromium_headless_shell-1243
 unzip -q /tmp/vlmkit-pr2-chromium.zip -d /tmp/vlmkit-pr2-browsers/chromium-1243
 unzip -q /tmp/vlmkit-pr2-headless.zip -d /tmp/vlmkit-pr2-browsers/chromium_headless_shell-1243
 PLAYWRIGHT_BROWSERS_PATH=/tmp/vlmkit-pr2-browsers node --input-type=module -e 'import {chromium} from "playwright"; const b=await chromium.launch(); console.log(await b.version()); await b.close();'

# Whole repository checks
 pnpm build
 env -u OPENROUTER_API_KEY pnpm test
 PLAYWRIGHT_BROWSERS_PATH=/tmp/vlmkit-pr2-browsers env -u OPENROUTER_API_KEY pnpm test
 pnpm typecheck
 pnpm fmt
 pnpm fmt:check
 pnpm exec vp lint
 pnpm moon:test:markup

# Targeted regression checks (final selection)
 PLAYWRIGHT_BROWSERS_PATH=/tmp/vlmkit-pr2-browsers pnpm exec vp test run \
   packages/vlmkit-markup/src/native \
   packages/vlmkit-markup/src/a11y-tree/native-agent.test.ts \
   packages/vlmkit-markup/src/inspect/flow-verify.test.ts \
   packages/vlmkit-markup/src/inspect/grounding-scan.test.ts \
   packages/vlmkit-markup/src/inspect/interaction-map.test.ts \
   packages/vlmkit-markup/src/gates/interactions-coverage.test.ts \
   src/vrt/snapshot/native-snapshot.test.ts \
   src/vrt/snapshot/native-snapshot-runner.test.ts \
   src/vrt/snapshot/snapshot-cli.test.ts
 pnpm exec vp test run src/vrt/snapshot/native-snapshot.test.ts packages/vlmkit-markup/src/native
 pnpm exec vp test run src/vrt/snapshot/native-snapshot-runner.test.ts
 pnpm exec vp test run packages/vlmkit-markup/src/native/native-interactions.test.ts
 pnpm exec vp fmt --check packages/vlmkit-markup/src/native src/vrt/snapshot/native-snapshot-runner.test.ts

# macOS and CLI
 swift build --package-path native/macos
 swift test --package-path native/macos
 bash native/macos/script/build_and_run.sh --build-only
 node native/macos/script/integration.mjs
 printf '%s\n' '{"id":1,"protocol":1,"method":"doctor","params":{"prompt":false}}' | native/macos/dist/VLMKitNativeAgent.app/Contents/MacOS/VLMKitNativeAgent
 node dist/vlmkit.mjs native doctor --native-agent native/macos/dist/VLMKitNativeAgent.app/Contents/MacOS/VLMKitNativeAgent --json
 node dist/vlmkit.mjs native doctor --help
 node dist/vlmkit.mjs native doctor --unknown

# Final Git verification / publication
 git diff --check
 git diff --stat
 git diff origin/main...HEAD
 git diff --cached --stat
 git status --short --branch
 git commit -m "fix: correct readonly array syntax to unblock validation"
 git commit -m "fix: validate native driver and correct grounding and snapshot errors"
 git push origin HEAD:codex/native-p2-actions-20261003
 gh pr view 2 --repo f4ah6o/vlmkit --json headRefOid,isDraft
```

Raw validation logs are retained locally under
`test-results/native/pr2-validation/` (ignored, not published), including the
initial and final whole suite output. No screenshots of unrelated applications
were taken. The report and narrowly scoped fixes are committed to the existing
PR branch; the final pushed SHA is reported in the task completion message.
