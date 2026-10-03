import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "vite-plus/test";
import { decodePng } from "@mizchi/vlmkit-core/png-utils.ts";
import { isInteractive, parseA11yTree } from "@mizchi/vlmkit-judge/a11y-tree.ts";
import { runCheckA11yTree } from "./check-a11y-tree.ts";
import { macTarget, macWindow, NativeAgentClient } from "./native-agent.ts";
import { a11yScanGate } from "../gates/a11y-tree.gate.ts";
const root = resolve(import.meta.dirname!, "../../../..");
const fixture = (name: string, file: string) => join(root, "fixtures/native/macos", name, file);

describe("native static contract", () => {
  for (const name of ["basic", "retina-2x", "duplicate-labels", "truncated", "recorded-2x"]) {
    it(`judges ${name} without platform-specific changes`, async () => {
      const path = fixture(name, "a11y.json");
      const tree = parseA11yTree(readFileSync(path, "utf8"));
      const expected = JSON.parse(readFileSync(fixture(name, "expected.json"), "utf8"));
      assert.deepEqual(parseA11yTree(JSON.stringify(tree)), tree);
      assert.equal(tree.nodes[1]!.identifier?.startsWith("fixture."), true);
      const report = await runCheckA11yTree({ source: path });
      assert.deepEqual(
        report.unlabelled.map((f) => f.path),
        expected.unlabelled,
      );
      assert.deepEqual(
        report.unreachable.map((f) => f.first.path),
        expected.unreachable,
      );
      assert.deepEqual(
        report.touch.failures.map((f) => f.path),
        expected.touch,
      );
      // Metadata cannot change generic judgements.
      const bare = { ...tree, nodes: tree.nodes.map(({ identifier, platformRole, platformSubrole, ...n }) => n) };
      const dir = mkdtempSync(join(tmpdir(), "native-contract-"));
      writeFileSync(
        join(dir, "tree.json"),
        JSON.stringify({ ...bare, frame: tree.frame ? fixture(name, tree.frame) : undefined }),
      );
      const other = await runCheckA11yTree({ source: join(dir, "tree.json") });
      assert.deepEqual(other.unlabelled, report.unlabelled);
      assert.deepEqual(other.unreachable, report.unreachable);
      assert.deepEqual(other.touch, report.touch);
      assert.deepEqual(other.contrast, report.contrast);
      assert.throws(() => parseA11yTree({ ...tree, nodes: [...tree.nodes, tree.nodes[0]] }), /not unique/);
    });
  }
  for (const name of ["basic", "retina-2x"]) {
    it(`${name} local points map exactly to the calibration PNG`, async () => {
      const tree = parseA11yTree(readFileSync(fixture(name, "a11y.json"), "utf8"));
      const frame = await decodePng(fixture(name, "frame.png"));
      assert.equal(frame.width, tree.viewport.width * tree.scale!);
      assert.equal(frame.height, tree.viewport.height * tree.scale!);
      const rect = tree.nodes.find((n) => n.identifier === "fixture.save")!.rect;
      const x0 = Math.round(rect.left * tree.scale!),
        y0 = Math.round(rect.top * tree.scale!);
      const x1 = Math.round((rect.left + rect.width) * tree.scale!),
        y1 = Math.round((rect.top + rect.height) * tree.scale!);
      const pixel = (x: number, y: number) => [
        ...frame.data.slice((y * frame.width + x) * 4, (y * frame.width + x) * 4 + 3),
      ];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) assert.deepEqual(pixel(x, y), [37, 99, 235]);
      assert.deepEqual(pixel(x0 - 1, y0), [255, 255, 255]);
      assert.deepEqual(pixel(x1, y1 - 1), [255, 255, 255]);
      assert.equal(tree.nodes.at(-1)!.role, "AXCustom");
    });
  }
  it("identifiers may repeat while structural paths remain unique", () => {
    const tree = parseA11yTree(readFileSync(fixture("duplicate-labels", "a11y.json"), "utf8"));
    tree.nodes[2]!.identifier = tree.nodes[1]!.identifier;
    assert.deepEqual(parseA11yTree(JSON.stringify(tree)), tree);
  });
  it("only the specified normalized actions make an unknown role interactive", () => {
    const node = parseA11yTree(readFileSync(fixture("basic", "a11y.json"), "utf8")).nodes.at(-1)!;
    for (const action of ["tap", "setText", "longPress"])
      assert.equal(isInteractive({ ...node, actions: [action] }), true);
    for (const action of ["ax:AXPress", "increment", "decrement", "scroll", "focus"])
      assert.equal(isInteractive({ ...node, actions: [action] }), false);
  });
  it("native CLI parses explicit target/window/bounds and rejects mixed options", () => {
    assert.deepEqual(macTarget("macos:pid=123"), { by: "pid", pid: 123 });
    assert.deepEqual(macTarget("macos:com.example.app", true), {
      by: "bundle-id",
      bundleId: "com.example.app",
      launchIfNeeded: true,
    });
    assert.equal(macTarget("macos:/tmp/Fixture.app").by, "app-path");
    assert.throws(() => macTarget("macos:pid=-1"), /positive process/);
    assert.throws(() => macTarget("macos:pid=123", true), /cannot be used/);
    assert.deepEqual(macWindow("index=2"), { by: "index", index: 2 });
    assert.throws(() => macWindow("two"), /--window/);
    const options = a11yScanGate.parse(
      ["macos:com.example.app", "--launch", "--window", "main", "--max-nodes", "3", "--native-agent", "/tmp/agent"],
      { cwd: root, argv: [], json: false },
    );
    assert.equal(options.source, "macos:com.example.app");
    assert.equal(options.launch, true);
    assert.equal(options.maxNodes, 3);
    assert.throws(() => a11yScanGate.parse(["page.html", "--launch"], { cwd: root, argv: [], json: false }), /macos:/);
    assert.throws(
      () => a11yScanGate.parse(["macos:com.example.app", "--max-nodes", "0"], { cwd: root, argv: [], json: false }),
      /integer/,
    );
  });
});

function fakeAgent(body: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "native-wire-")), "agent.mjs");
  writeFileSync(file, `#!${process.execPath}\nimport { createInterface } from 'node:readline';\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}
describe("native NDJSON transport", () => {
  it("correlates replies and retains stable errors", async () => {
    const client = new NativeAgentClient(
      fakeAgent(`createInterface({input:process.stdin}).on('line', line => {
      const r=JSON.parse(line); console.log(JSON.stringify(r.method==='hello' ? {id:r.id,ok:true,result:{protocol:1}} : {id:r.id,ok:false,error:{code:'NATIVE_TARGET_EXITED',message:'gone'}}));
    });`),
    );
    try {
      assert.deepEqual(await client.request("hello"), { protocol: 1 });
      await assert.rejects(client.request("window.list"), /NATIVE_TARGET_EXITED: gone/);
    } finally {
      client.close();
    }
  });
  it("rejects malformed output and settles every pending request", async () => {
    const client = new NativeAgentClient(
      fakeAgent(`createInterface({input:process.stdin}).once('line', () => console.log('bad JSON'));`),
    );
    try {
      await assert.rejects(client.request("hello"), /NATIVE_PROTOCOL_MISMATCH/);
    } finally {
      client.close();
    }
  });
  it("bounds hung agents and handles process exit and missing executable", async () => {
    for (const executable of [
      fakeAgent(`setInterval(()=>{},1000);`),
      fakeAgent(`process.exit(3);`),
      "/does-not-exist/native-agent",
    ]) {
      const client = new NativeAgentClient(executable, 100);
      try {
        await assert.rejects(
          client.request("hello"),
          /NATIVE_AX_TIMEOUT|NATIVE_AGENT_EXITED|NATIVE_AGENT_START_FAILED/,
        );
      } finally {
        client.close();
      }
    }
  });
});
