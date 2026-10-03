import assert from "node:assert/strict";
import { describe, it } from "vite-plus/test";
import { groundingGate } from "../gates/grounding.gate.ts";
import { interactionsGate } from "../gates/interactions.gate.ts";
import { verifyFlowGate } from "../gates/verify.gate.ts";
const ctx = { cwd: process.cwd(), argv: [], json: false };
describe("native gate parsing", () => {
  it("passes native target, agent and bounds through each gate", () => {
    for (const gate of [groundingGate, interactionsGate, verifyFlowGate]) {
      const options = gate.parse(
        [
          "macos:com.example.app",
          "--native-agent",
          "/tmp/agent",
          "--window",
          "main",
          "--max-depth",
          "8",
          "--max-nodes",
          "100",
          "--flow",
          "flow.json",
        ],
        ctx,
      );
      assert.equal(options.source, "macos:com.example.app");
      assert.equal(options.nativeAgent, "/tmp/agent");
      assert.equal(options.maxDepth, 8);
      assert.equal(options.maxNodes, 100);
    }
  });
  it("rejects native flags on browser sources", () => {
    for (const gate of [groundingGate, interactionsGate, verifyFlowGate]) {
      assert.throws(() => gate.parse(["page.html", "--launch", "--flow", "flow.json"], ctx), /macos:/);
    }
  });
  it("rejects DOM handlers and mixed interaction references", () => {
    assert.throws(() => interactionsGate.parse(["macos:app", "--handlers"], ctx), /DOM-specific/);
    assert.throws(() => interactionsGate.parse(["macos:app", "--reference", "page.html"], ctx), /macos:/);
    assert.throws(
      () => verifyFlowGate.parse(["macos:app", "--flow", "flow.json", "--storage-state", "auth.json"], ctx),
      /browser-only/,
    );
  });
});
