import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { describe, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("@mizchi/vlmkit-markup/a11y-tree/native-agent.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mizchi/vlmkit-markup/a11y-tree/native-agent.ts")>()),
  captureNativeA11y: mocks.capture,
}));
import { parseNativeSnapshotArgs, runNativeSnapshotCli } from "./native-snapshot.ts";

describe("native snapshot VRT pipeline (contract fixture, no live acceptance)", () => {
  it("creates a baseline, compares an unchanged capture, then fails on a pixel change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "native-vrt-unit-"));
    const fixture = resolve(import.meta.dirname!, "../../../fixtures/native/macos/basic");
    const tree = JSON.parse(await readFile(join(fixture, "a11y.json"), "utf8"));
    let png: Buffer = await readFile(join(fixture, "frame.png"));
    mocks.capture.mockReset().mockImplementation(async ({ out, frame }) => {
      await writeFile(out, JSON.stringify(tree));
      await writeFile(frame, png);
      return { tree, capture: { scale: tree.scale } };
    });
    try {
      const args = ["macos:com.example.Fixture", "--output", dir, "--fail-on-diff"];
      assert.equal(await runNativeSnapshotCli(args), 0);
      let report = JSON.parse(await readFile(join(dir, "snapshot-report.json"), "utf8"));
      assert.equal(report.results[0].isNew, true);
      assert.equal(await runNativeSnapshotCli(args), 0);
      report = JSON.parse(await readFile(join(dir, "snapshot-report.json"), "utf8"));
      assert.equal(report.results[0].diffRatio, 0);
      assert.equal(report.a11yDiff.changes.length, 0);
      const changed = PNG.sync.read(png);
      for (let y = 0; y < 20; y++)
        for (let x = 0; x < 20; x++) {
          const offset = (y * changed.width + x) * 4;
          changed.data[offset] = 0;
          changed.data[offset + 1] = 0;
          changed.data[offset + 2] = 0;
        }
      png = PNG.sync.write(changed);
      assert.equal(await runNativeSnapshotCli(args), 1);
      report = JSON.parse(await readFile(join(dir, "snapshot-report.json"), "utf8"));
      assert.ok(report.results[0].diffRatio > 0);
      assert.equal(report.a11yDiff.changes.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps baselines separate for different selected windows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "native-vrt-windows-"));
    const fixture = resolve(import.meta.dirname!, "../../../fixtures/native/macos/basic");
    const tree = JSON.parse(await readFile(join(fixture, "a11y.json"), "utf8"));
    const png = await readFile(join(fixture, "frame.png"));
    mocks.capture.mockReset().mockImplementation(async ({ out, frame }) => {
      await writeFile(out, JSON.stringify(tree));
      await writeFile(frame, png);
      return { tree, capture: { scale: tree.scale } };
    });
    try {
      const mainArgs = ["macos:com.example.Fixture", "--output", dir, "--window", "main"];
      const focusedArgs = ["macos:com.example.Fixture", "--output", dir, "--window", "focused"];
      const main = parseNativeSnapshotArgs(mainArgs);
      const focused = parseNativeSnapshotArgs(focusedArgs);
      assert.notEqual(main.label, focused.label);
      assert.equal(await runNativeSnapshotCli(mainArgs), 0);
      assert.equal(await runNativeSnapshotCli(focusedArgs), 0);
      await readFile(join(dir, `${main.label}-native-baseline.png`));
      await readFile(join(dir, `${main.label}-native-baseline.a11y.json`));
      await readFile(join(dir, `${focused.label}-native-baseline.png`));
      await readFile(join(dir, `${focused.label}-native-baseline.a11y.json`));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on a partial baseline pair before capturing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "native-vrt-partial-"));
    const args = ["macos:com.example.Fixture", "--output", dir, "--window", "main"];
    const parsed = parseNativeSnapshotArgs(args);
    mocks.capture.mockReset();
    try {
      await writeFile(join(dir, `${parsed.label}-native-baseline.png`), Buffer.from("partial"));
      await assert.rejects(() => runNativeSnapshotCli(args), /baseline is incomplete/);
      assert.equal(mocks.capture.mock.calls.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
