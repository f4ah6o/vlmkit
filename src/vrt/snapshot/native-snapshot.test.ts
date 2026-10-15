import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "vite-plus/test";
import { parseA11yTree } from "@mizchi/vlmkit-judge/a11y-tree.ts";
import { nativeTreeSnapshot, parseNativeSnapshotArgs } from "./native-snapshot.ts";

const root = resolve(import.meta.dirname!, "../../..");

describe("native snapshot pure contract", () => {
  it("parses a single macOS target and native-only flags", () => {
    const parsed = parseNativeSnapshotArgs(
      [
        "macos:com.example.App",
        "--label",
        "fixture",
        "--output",
        "artifacts/native",
        "--threshold",
        "0.2",
        "--fail-on-diff",
        "--native-agent",
        "/tmp/agent",
        "--window",
        "main",
        "--max-nodes",
        "100",
      ],
      "/repo",
    );
    assert.equal(parsed.source, "macos:com.example.App");
    assert.equal(parsed.label, "fixture");
    assert.equal(parsed.outputDir, "/repo/artifacts/native");
    assert.equal(parsed.threshold, 0.2);
    assert.equal(parsed.failOnDiff, true);
    assert.equal(parsed.maxNodes, 100);
  });

  it("keys default labels to the selected native window", () => {
    const auto = parseNativeSnapshotArgs(["macos:com.example.App"]);
    const main = parseNativeSnapshotArgs(["macos:com.example.App", "--window", "main"]);
    const focused = parseNativeSnapshotArgs(["macos:com.example.App", "--window", "focused"]);
    const index = parseNativeSnapshotArgs(["macos:com.example.App", "--window", "index=0"]);
    assert.notEqual(auto.label, main.label);
    assert.notEqual(main.label, focused.label);
    assert.notEqual(focused.label, index.label);
    assert.match(main.label, /window-main$/);
  });

  it("rejects browser-only or ambiguous native snapshot inputs", () => {
    assert.throws(() => parseNativeSnapshotArgs(["https://example.com"]), /macos:/i);
    assert.throws(() => parseNativeSnapshotArgs(["macos:one", "macos:two"]), /exactly one/i);
    assert.throws(
      () => parseNativeSnapshotArgs(["macos:one", "--mask", ".dynamic"]),
      /unsupported native snapshot option/i,
    );
  });

  it("projects flat AX paths into the existing semantic diff tree", () => {
    const tree = parseA11yTree(readFileSync(join(root, "fixtures/native/macos/basic/a11y.json"), "utf8"));
    const snapshot = nativeTreeSnapshot(tree, "fixture-native");
    assert.equal(snapshot.testId, "fixture-native");
    assert.equal(snapshot.tree.role, "window");
    const names: string[] = [];
    const walk = (node: typeof snapshot.tree) => {
      if (node.name) names.push(node.name);
      for (const child of node.children ?? []) walk(child);
    };
    walk(snapshot.tree);
    assert.ok(names.includes("Save"));
    assert.ok(names.includes("Name"));
  });
});
