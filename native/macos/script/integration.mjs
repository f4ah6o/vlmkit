#!/usr/bin/env node
// Explicit macOS acceptance run: only the local deterministic fixture is opened/captured.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NativeAgentClient } from "@mizchi/vlmkit-markup/a11y-tree/native-agent.ts";
import { runScanA11y } from "@mizchi/vlmkit-markup/a11y-tree/scan-a11y.ts";
import { runCheckA11yTree } from "@mizchi/vlmkit-markup/a11y-tree/check-a11y-tree.ts";
import { parseA11yTree } from "@mizchi/vlmkit-judge/a11y-tree.ts";
import { decodePng } from "@mizchi/vlmkit-core/png-utils.ts";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const app = resolve(root, "native/macos/dist/VLMKitAXFixture.app");
const agent = resolve(root, "native/macos/dist/VLMKitNativeAgent.app/Contents/MacOS/VLMKitNativeAgent");
const out = resolve(root, "test-results/native/acceptance");
await mkdir(out, { recursive: true });
const client = new NativeAgentClient(agent);
const results = [];
const latestPid = () => {
  try {
    return Number(execFileSync("/usr/bin/pgrep", ["-nx", "VLMKitAXFixture"], { encoding: "utf8" }).trim());
  } catch {
    return 0;
  }
};
const delay = () => new Promise((r) => setTimeout(r, 100));
async function fixture(args, run) {
  const before = latestPid();
  const launcher = spawn("/usr/bin/open", ["-n", "-W", app, "--args", ...args], { stdio: "ignore" });
  launcher.on("error", () => {});
  let pid, sessionId;
  try {
    const deadline = Date.now() + 15000;
    while (!(pid = latestPid()) || pid === before) {
      assert.ok(Date.now() < deadline, "fixture did not launch");
      await delay();
    }
    ({ sessionId } = await client.request("target.open", { target: { by: "pid", pid } }));
    let windows;
    const ready = () =>
      args.includes("--ambiguous")
        ? windows.filter((w) => w.onScreen && !w.minimized && w.title?.startsWith("Ordinary ")).length >= 2
        : windows.some((w) => w.onScreen && !w.minimized && w.title === "VLMKit AX Fixture");
    do {
      try {
        windows = await client.request("window.list", { sessionId });
      } catch (e) {
        assert.match(e.message, /NATIVE_AX_CANNOT_COMPLETE/);
        windows = [];
      }
      if (!ready()) await delay();
    } while (!ready() && Date.now() < deadline);
    assert.ok(ready(), "fixture exposed no visible capturable AX windows");
    await run({ pid, sessionId, windows });
  } finally {
    if (sessionId) await client.request("session.close", { sessionId }).catch(() => {});
    if (pid && pid !== before) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    launcher.kill();
  }
}
try {
  assert.equal((await client.request("hello")).protocol, 1);
  const doctor = await client.request("doctor", { prompt: false });
  assert.ok(doctor.accessibility.trusted, "NATIVE_PERMISSION_ACCESSIBILITY");
  assert.ok(doctor.screenCapture.authorized, "NATIVE_PERMISSION_SCREEN_CAPTURE");
  results.push({ check: "hello/passive doctor", pass: true });
  // Test termination ownership only when the fixture was not already running.
  let existing;
  try {
    existing = await client.request("target.open", {
      target: { by: "bundle-id", bundleId: "com.f4ah6o.vlmkit.ax-fixture" },
    });
  } catch (e) {
    assert.ok(["NATIVE_TARGET_NOT_FOUND", "NATIVE_TARGET_AMBIGUOUS"].includes(e.code));
  }
  if (existing) {
    await client.request("session.close", { sessionId: existing.sessionId });
    results.push({ check: "launch/termination ownership", skipped: "fixture already running; preserved" });
  } else {
    const launched = await client.request("target.open", {
      target: { by: "app-path", appPath: app, launchIfNeeded: true },
    });
    assert.equal(launched.launched, true);
    try {
      const attached = await client.request("target.open", { target: { by: "pid", pid: launched.pid } });
      assert.equal(attached.launched, false);
      await client.request("session.close", { sessionId: attached.sessionId, terminateIfLaunched: true });
      // The launched app must still be alive after an attached session's terminate request.
      process.kill(launched.pid, 0);
      await client.request("session.close", { sessionId: launched.sessionId, terminateIfLaunched: true });
      const deadline = Date.now() + 5000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try {
          process.kill(launched.pid, 0);
          await delay();
        } catch {
          alive = false;
        }
      }
      assert.equal(alive, false);
      results.push({
        check: "launch by app path; attached session cannot terminate; launched session opts into termination",
        pass: true,
      });
    } finally {
      try {
        process.kill(launched.pid, "SIGTERM");
      } catch {}
    }
  }
  await fixture([], async ({ pid, sessionId }) => {
    const attached = await client
      .request("target.open", { target: { by: "bundle-id", bundleId: "com.f4ah6o.vlmkit.ax-fixture" } })
      .catch((e) => {
        // Another fixture instance is legitimate: PID targeting must still work.
        assert.match(e.message, /NATIVE_TARGET_AMBIGUOUS/);
        return null;
      });
    if (attached) await client.request("session.close", { sessionId: attached.sessionId });
    const scan = await runScanA11y({ source: `macos:pid=${pid}`, out: resolve(out, "a11y.json"), nativeAgent: agent });
    const tree = parseA11yTree(await readFile(resolve(out, "a11y.json"), "utf8"));
    const frame = await decodePng(scan.frame);
    assert.equal(scan.native.counts.truncated, 0);
    assert.equal(scan.native.counts.attributeErrors, 0);
    assert.ok(Math.abs(frame.width - tree.viewport.width * tree.scale) <= 1);
    assert.ok(Math.abs(frame.height - tree.viewport.height * tree.scale) <= 1);
    const save = tree.nodes.find((n) => n.identifier === "fixture.save");
    assert.equal(save.name, "Save");
    assert.deepEqual(save.actions, ["tap"]);
    const field = tree.nodes.find((n) => n.identifier === "fixture.name");
    assert.equal(field.name, "Name");
    assert.equal(field.value, "Ada");
    assert.ok(field.actions.includes("setText"));
    assert.equal(tree.nodes.find((n) => n.identifier === "fixture.remember").states.checked, true);
    assert.equal(tree.nodes.find((n) => n.identifier === "fixture.disabled").states.disabled, true);
    const duplicate = tree.nodes.filter((n) => n.name === "Duplicate");
    assert.equal(duplicate.length, 2);
    assert.notEqual(duplicate[0].identifier, duplicate[1].identifier);
    const report = await runCheckA11yTree({ source: resolve(out, "a11y.json") });
    const unnamed = tree.nodes.find((n) => n.identifier === "fixture.unnamed");
    assert.ok(report.unlabelled.some((f) => f.path === unnamed.path));
    assert.ok(report.touch.failures.some((f) => f.path === unnamed.path));
    assert.ok(!report.unreachable.some((f) => f.first.name === "Offscreen scroll control"));
    // Check the actual image: the center of Save is ink/fill and a point well to its right is white.
    const pixel = (x, y) => [...frame.data.slice((y * frame.width + x) * 4, (y * frame.width + x) * 4 + 3)];
    const cx = Math.round((save.rect.left + save.rect.width / 2) * tree.scale);
    const cy = Math.round((save.rect.top + save.rect.height / 2) * tree.scale);
    assert.ok(
      pixel(cx, cy).some((c) => c < 250),
      "Save center must overlap its painted pixels",
    );
    assert.ok(
      pixel(Math.round(250 * tree.scale), cy).every((c) => c >= 250),
      "control-free calibration pixel must be white",
    );
    // Vector overlay preserves the captured PNG; inspect overlay.svg beside frame.png.
    await writeFile(
      resolve(out, "overlay.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}"><image href="a11y.png" width="${frame.width}" height="${frame.height}"/><rect x="${save.rect.left * tree.scale}" y="${save.rect.top * tree.scale}" width="${save.rect.width * tree.scale}" height="${save.rect.height * tree.scale}" fill="none" stroke="red" stroke-width="2"/></svg>`,
    );
    const selected = await client.request("window.select", { sessionId });
    const truncated = await client.request("snapshot.capture", {
      sessionId,
      windowId: selected.windowId,
      maxNodes: 3,
      outputTreePath: resolve(out, "truncated.json"),
      outputPngPath: resolve(out, "truncated.png"),
    });
    assert.equal(truncated.counts.nodes, 3);
    assert.ok(truncated.counts.truncated > 0);
    results.push({
      check: "native scan, generic judges, 2x pixels, overlay, truncation",
      pass: true,
      counts: scan.native.counts,
      viewport: scan.viewport,
      scale: tree.scale,
    });
    if (process.argv.includes("--record")) {
      const dest = resolve(root, "fixtures/native/macos/recorded-2x");
      await mkdir(dest, { recursive: true });
      await copyFile(resolve(out, "a11y.json"), resolve(dest, "a11y.json"));
      await copyFile(scan.frame, resolve(dest, "frame.png"));
      const record = parseA11yTree(await readFile(resolve(dest, "a11y.json"), "utf8"));
      record.frame = "frame.png";
      await writeFile(resolve(dest, "a11y.json"), JSON.stringify(record, null, 2) + "\n");
      await writeFile(
        resolve(dest, "expected.json"),
        JSON.stringify(
          {
            provenance: "Live AppKit AX / ScreenCaptureKit capture on macOS 26.5.2; only fixture content",
            unlabelled: report.unlabelled.map((f) => f.path),
            unreachable: report.unreachable.map((f) => f.first.path),
            touch: report.touch.failures.map((f) => f.path),
          },
          null,
          2,
        ) + "\n",
      );
    }
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 5000;
    let exited = false;
    while (!exited && Date.now() < deadline) {
      try {
        await client.request("window.list", { sessionId });
        await delay();
      } catch (e) {
        if (e.code === "NATIVE_TARGET_EXITED") exited = true;
        else {
          assert.match(e.message, /NATIVE_AX_CANNOT_COMPLETE/);
          await delay();
        }
      }
    }
    assert.ok(exited);
    results.push({ check: "terminated target", pass: true });
  });
  await fixture(["--unchecked", "--duplicate-identifiers"], async ({ sessionId }) => {
    const window = await client.request("window.select", { sessionId });
    const capture = await client.request("snapshot.capture", {
      sessionId,
      windowId: window.windowId,
      outputTreePath: resolve(out, "unchecked.json"),
      outputPngPath: resolve(out, "unchecked.png"),
    });
    const tree = parseA11yTree(await readFile(capture.treePath, "utf8"));
    assert.equal(tree.nodes.find((n) => n.identifier === "fixture.remember").states.checked, false);
    assert.ok(capture.diagnostics.some((d) => d.code === "NATIVE_DUPLICATE_IDENTIFIER"));
    results.push({ check: "unchecked value and duplicate identifier warning", pass: true });
  });
  await fixture(["--ambiguous"], async ({ sessionId, windows }) => {
    assert.ok(windows.length >= 2);
    await assert.rejects(client.request("window.select", { sessionId }), /NATIVE_WINDOW_AMBIGUOUS/);
    const chosen = await client.request("window.select", { sessionId, selector: { by: "index", index: 0 } });
    assert.ok(chosen.windowId);
    results.push({ check: "two ordinary windows refuse default selection", pass: true });
  });
  await writeFile(resolve(out, "results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify(results, null, 2));
} finally {
  client.close();
}
