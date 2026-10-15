import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { runCheckA11yTree } from "./check-a11y-tree.ts";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "vite-plus/test";
import { captureNativeA11y, linuxTarget } from "./native-agent.ts";
import { runScanA11y } from "./scan-a11y.ts";
import { a11yScanGate } from "../gates/a11y-tree.gate.ts";

function fakeAgent(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "linux-observer-"));
  const file = join(dir, "agent.mjs");
  writeFileSync(
    file,
    `#!${process.execPath}
import {createInterface} from 'node:readline';
const overrides=${JSON.stringify(overrides)};
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 const defaults={hello:{protocol:1,platform:'linux',backend:'x11',capabilities:{physicalPointer:false,physicalKeyboard:false}},doctor:{accessibility:{available:false},screenCapture:{available:false}}};
 const result=overrides[r.method]??defaults[r.method];
 console.log(JSON.stringify(result?{id:r.id,ok:true,result}:{id:r.id,ok:false,error:{code:'NATIVE_UNEXPECTED_METHOD',message:r.method}}));
});`,
  );
  chmodSync(file, 0o755);
  return { dir, file };
}

function capturedAgent(identity = { pid: 123, windowId: "window[0]" }) {
  const dir = mkdtempSync(join(tmpdir(), "linux-capture-"));
  const treePath = join(dir, "tree.json"),
    pngPath = join(dir, "frame.png");
  const root = resolve(import.meta.dirname!, "../../../..");
  const tree = JSON.parse(readFileSync(join(root, "fixtures/native/macos/basic/a11y.json"), "utf8"));
  tree.platform = "linux";
  writeFileSync(treePath, JSON.stringify(tree));
  copyFileSync(join(root, "fixtures/native/macos/basic/frame.png"), pngPath);
  const capture = {
    treePath,
    pngPath,
    viewport: tree.viewport,
    framePixels: tree.viewport,
    scale: 1,
    counts: { nodes: tree.nodes.length, truncated: 0, attributeErrors: 0 },
    transform: { globalWindowOriginPoints: { x: 0, y: 0 }, logicalToPixelScale: 1 },
    diagnostics: [],
    backend: "x11",
    frameKind: "client-window",
    identity,
  };
  const agent = fakeAgent({
    doctor: { accessibility: { available: true }, screenCapture: { available: true } },
    "target.open": { sessionId: "session-test" },
    "window.select": { windowId: "window[0]" },
    "snapshot.capture": capture,
    "session.close": { closed: true },
  });
  return { dir, file: agent.file, treePath, pngPath };
}

describe("Linux observer admission", () => {
  it("accepts only an explicit PID without launch or command parsing", () => {
    assert.deepEqual(linuxTarget("linux:pid=123"), { by: "pid", pid: 123 });
    for (const value of [
      "linux:pid=0",
      "linux:pid=-1",
      "linux:pid=1e3",
      "linux:pid=2147483648",
      "linux:app.desktop",
      "linux:/bin/app",
      "macos:pid=1",
    ])
      assert.throws(() => linuxTarget(value));
    assert.throws(() => linuxTarget("linux:pid=123", true), /attach-only/);
  });
  it("routes Linux native options without treating the source as a browser URL", () => {
    const options = a11yScanGate.parse(["linux:pid=123", "--window", "index=0", "--native-agent", "/tmp/observer"], {
      cwd: process.cwd(),
      argv: [],
      json: false,
    });
    assert.equal(options.source, "linux:pid=123");
    assert.equal(options.nativeAgent, "/tmp/observer");
  });
  it("rejects browser actions before opening an observer", async () => {
    await assert.rejects(
      runScanA11y({ source: "linux:pid=123", out: "/tmp/unused.json", clicks: ["Save"] }),
      /observer-only/,
    );
  });
  it.skipIf(process.platform !== "linux")("fails closed on Wayland or an input-enabled helper", async () => {
    for (const hello of [
      {
        protocol: 1,
        platform: "linux",
        backend: "wayland",
        capabilities: { physicalPointer: false, physicalKeyboard: false },
      },
      {
        protocol: 1,
        platform: "linux",
        backend: "x11",
        capabilities: { physicalPointer: true, physicalKeyboard: false },
      },
      { protocol: 1 },
    ]) {
      const { dir, file } = fakeAgent({ hello });
      await assert.rejects(
        captureNativeA11y({
          source: "linux:pid=123",
          out: join(dir, "tree.json"),
          frame: join(dir, "frame.png"),
          agent: file,
        }),
        /NATIVE_PROTOCOL_MISMATCH/,
      );
    }
  });
  it.skipIf(process.platform !== "linux")(
    "reports missing accessibility instead of an empty passing tree",
    async () => {
      const { dir, file } = fakeAgent();
      await assert.rejects(
        captureNativeA11y({
          source: "linux:pid=123",
          out: join(dir, "tree.json"),
          frame: join(dir, "frame.png"),
          agent: file,
        }),
        /NATIVE_PERMISSION_ACCESSIBILITY/,
      );
    },
  );
  it.skipIf(process.platform !== "linux")("reports missing selected-window capture separately", async () => {
    const { dir, file } = fakeAgent({
      doctor: { accessibility: { available: true }, screenCapture: { available: false } },
    });
    await assert.rejects(
      captureNativeA11y({
        source: "linux:pid=123",
        out: join(dir, "tree.json"),
        frame: join(dir, "frame.png"),
        agent: file,
      }),
      /NATIVE_PERMISSION_SCREEN_CAPTURE/,
    );
  });
  it.skipIf(process.platform !== "linux")(
    "does not dispatch a macOS source into the Linux observer branch",
    async () => {
      await assert.rejects(
        captureNativeA11y({
          source: "macos:pid=123",
          out: "/tmp/unused-native-tree.json",
          frame: "/tmp/unused-native-frame.png",
          agent: "/does-not-exist/native-agent",
        }),
        /Native macOS scan requires a macOS host/,
      );
    },
  );
  it.skipIf(process.platform !== "linux")("accepts aligned synthetic artifacts with selected identity", async () => {
    const { file, treePath, pngPath } = capturedAgent();
    const result = await captureNativeA11y({ source: "linux:pid=123", out: treePath, frame: pngPath, agent: file });
    assert.equal(result.tree.platform, "linux");
    assert.equal(result.capture.frameKind, "client-window");
    assert.equal(result.capture.contentPolicy.provenance, "unclassified");
  });
  it.skipIf(process.platform !== "linux")("rejects artifacts attributed to another PID or window", async () => {
    for (const identity of [
      { pid: 999, windowId: "window[0]" },
      { pid: 123, windowId: "window[1]" },
    ]) {
      const { file, treePath, pngPath } = capturedAgent(identity);
      await assert.rejects(
        captureNativeA11y({ source: "linux:pid=123", out: treePath, frame: pngPath, agent: file }),
        /NATIVE_TARGET_MISMATCH/,
      );
    }
  });
});

// Opt-in only on a provisioned isolated native test display; never uses user apps.
describe("Linux live client-to-judge", () => {
  it.skipIf(process.env.VLMKIT_LINUX_LIVE !== "1")(
    "captures a GTK fixture through the public scan and generic judge",
    async () => {
      const root = resolve(import.meta.dirname!, "../../../..");
      const dir = mkdtempSync(join(tmpdir(), "linux-live-"));
      const fixture = spawn("/usr/bin/python3", [join(root, "native/linux/fixture.py")], {
        env: { ...process.env, GTK_MODULES: "gail:atk-bridge", NO_AT_BRIDGE: "0", GDK_BACKEND: "x11" },
        stdio: ["ignore", "pipe", "inherit"],
      });
      const lines = createInterface({ input: fixture.stdout });
      try {
        await new Promise<void>((resolveReady, reject) => {
          const timer = setTimeout(() => reject(new Error("Fixture ready timeout")), 15000);
          fixture.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          fixture.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`Fixture exited ${code}`));
          });
          lines.once("line", (line) => {
            clearTimeout(timer);
            try {
              assert.equal(JSON.parse(line).pid, fixture.pid);
              resolveReady();
            } catch (error) {
              reject(error);
            }
          });
        });
        const out = join(dir, "nested", "a11y.json");
        const deadline = Date.now() + 10000;
        let report;
        for (;;) {
          try {
            report = await runScanA11y({
              source: `linux:pid=${fixture.pid}`,
              out,
              frame: join(dir, "pixels", "frame.png"),
              nativeAgent: join(root, "native/linux/observer.py"),
            });
            break;
          } catch (error) {
            if (!String(error).includes("NATIVE_WINDOW_NOT_FOUND") || Date.now() > deadline) throw error;
            await new Promise((resolveWait) => setTimeout(resolveWait, 200));
          }
        }
        assert.equal(report.platform, "linux");
        assert.equal(report.native?.identity?.pid, fixture.pid);
        assert.equal(report.native?.counts.attributeErrors, 0);
        assert.equal(report.native?.counts.truncated, 0);
        const judged = await runCheckA11yTree({ source: out });
        assert.ok(judged.unlabelled.length > 0, "Planted unnamed button must be detected by unchanged generic judge");
      } finally {
        lines.close();
        fixture.kill();
      }
    },
    45000,
  );
});
