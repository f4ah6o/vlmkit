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
import { runNativeSnapshotCli } from "./native-snapshot.ts";

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
});
