#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  openNativeInteractionSession,
} from "@mizchi/vlmkit-markup/a11y-tree/native-agent.ts";
import { captureNativeState } from "@mizchi/vlmkit-markup/native/native-surface.ts";

function value(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const result = argv[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`Missing value for ${flag}`);
  return result;
}

function usage() {
  return [
    "Usage:",
    "  node native/macos/script/gpui_acceptance.mjs <app-path|bundle-id|macos:target> --id <AXIdentifier> [options]",
    "",
    "Black-box GPUI/gpui.mbt acceptance. The application is not instrumented and VLMKit",
    "does not link to GPUI. The target control must expose a stable macOS AXIdentifier.",
    "",
    "Options:",
    "  --id <value>          Required stable AXIdentifier to verify",
    "  --name <value>        Optional expected accessible name",
    "  --agent <path>        Native sidecar executable",
    "  --out <dir>           Evidence directory (default test-results/native/gpui)",
    "  --attach              Do not launch an app-path/bundle-id target",
    "",
    "Acceptance:",
    "  semantic tree contains the stable id; its bounds land on the same screenshot;",
    "  AX hit-test resolves the same element; physical click targets that element;",
    "  after-action semantic tree and screenshot are captured for evidence.",
  ].join("\n");
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(usage());
  process.exit(0);
}
const target = argv.find((arg, index) => !arg.startsWith("-") && argv[index - 1] !== "--id" && argv[index - 1] !== "--name" && argv[index - 1] !== "--agent" && argv[index - 1] !== "--out");
const stableId = value(argv, "--id");
if (!target || !stableId) throw new Error(usage());

const source = target.startsWith("macos:")
  ? target
  : target.includes("/") || target.endsWith(".app")
    ? `macos:${resolve(target)}`
    : `macos:${target}`;
const out = resolve(value(argv, "--out") ?? "test-results/native/gpui");
const agent = value(argv, "--agent");
const launch = !argv.includes("--attach");
await mkdir(out, { recursive: true });

const session = await openNativeInteractionSession({ source, agent, launch });
try {
  const before = await captureNativeState(session, out, "before");
  const node = before.tree.nodes.find((candidate) => candidate.identifier === stableId);
  assert.ok(node, `AXIdentifier ${JSON.stringify(stableId)} was not exposed by ${source}`);
  const expectedName = value(argv, "--name");
  if (expectedName !== undefined) assert.equal(node.name, expectedName);

  const point = {
    xPx: Math.round((node.rect.left + node.rect.width / 2) * before.capture.scale),
    yPx: Math.round((node.rect.top + node.rect.height / 2) * before.capture.scale),
  };
  const hit = await session.hitTest(point);
  assert.equal(hit.node.identifier, stableId, "screenshot-space hit test must resolve the stable AXIdentifier");
  assert.equal(hit.actionable, true, "stable-id target must be actionable");

  const actionPath = resolve(out, "actions.jsonl");
  const action = await session.perform(
    { kind: "click", mode: "physical", locator: { by: "stable-id", value: stableId } },
    { evidencePath: actionPath },
  );
  assert.equal(action.target?.identifier, stableId);

  const after = await captureNativeState(session, out, "after");
  assert.ok(after.tree.nodes.some((candidate) => candidate.identifier === stableId));

  const result = {
    source,
    app: basename(target),
    stableId,
    expectedName: expectedName ?? null,
    point,
    windowId: session.windowId,
    scale: before.capture.scale,
    before: { tree: before.treePath, screenshot: before.pngPath },
    after: { tree: after.treePath, screenshot: after.pngPath },
    actionEvidence: actionPath,
    pass: true,
  };
  await writeFile(resolve(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await session.close({ terminateIfLaunched: launch });
}
