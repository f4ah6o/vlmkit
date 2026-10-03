import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, vi } from "vite-plus/test";
import type { Flow } from "../inspect/flow-verify.ts";

const mocks = vi.hoisted(() => ({ perform: vi.fn(), close: vi.fn(), capture: vi.fn(), open: vi.fn() }));
vi.mock("../a11y-tree/native-agent.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../a11y-tree/native-agent.ts")>()),
  openNativeInteractionSession: mocks.open,
}));
vi.mock("./native-surface.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native-surface.ts")>()),
  captureNativeState: mocks.capture,
}));
import { runFlowVerify } from "../inspect/flow-verify.ts";

async function run(flow: Flow) {
  const dir = await mkdtemp(join(tmpdir(), "native-flow-unit-"));
  mocks.perform.mockReset().mockResolvedValue({});
  mocks.close.mockReset().mockResolvedValue(undefined);
  mocks.open.mockReset().mockResolvedValue({ perform: mocks.perform, close: mocks.close });
  mocks.capture.mockReset().mockImplementation(async (_session, _dir, name) => ({
    tree: {
      viewport: { width: 100, height: 100 },
      nodes: [
        {
          path: "window[0]>button[0]",
          role: "button",
          identifier: "save",
          name: "Saved",
          rect: { left: 10, top: 10, width: 30, height: 20 },
          states: { focused: true },
        },
      ],
    },
    treePath: join(dir, `${name}.json`),
    pngPath: join(dir, `${name}.png`),
  }));
  try {
    return await runFlowVerify({ source: "macos:pid=1", flow, artifactDir: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("native flow dispatch (mock session, no live acceptance)", () => {
  it("performs native input, checks AX postconditions and preserves step evidence", async () => {
    const locator = { by: "stable-id", value: "save" } as const;
    const report = await run({
      steps: [
        {
          do: { action: "click", locator },
          expect: [
            { assert: "text", locator, contains: "Saved" },
            { assert: "visible", locator },
            { assert: "focused", locator },
            { assert: "count", locator, equals: 1 },
          ],
        },
      ],
    });
    assert.equal(report.done, true);
    assert.deepEqual(mocks.perform.mock.calls[0]?.[0], { kind: "click", mode: "physical", locator });
    assert.ok(report.steps[0]?.evidence?.treePath);
    assert.equal(mocks.close.mock.calls.length, 1);
  });
  it("stops after a failed postcondition and closes the native session", async () => {
    const locator = { by: "stable-id", value: "absent" } as const;
    const report = await run({
      steps: [
        { do: { action: "wait", ms: 0 }, expect: [{ assert: "visible", locator }] },
        { do: { action: "click", locator } },
      ],
    });
    assert.equal(report.done, false);
    assert.equal(report.steps.length, 1);
    assert.equal(mocks.perform.mock.calls.length, 0);
    assert.equal(mocks.close.mock.calls.length, 1);
  });
  it("rejects CSS action selectors before opening the native session", async () => {
    await assert.rejects(() => run({ steps: [{ do: { action: "click", selector: "#save" } }] }), /native flows require/);
    assert.equal(mocks.open.mock.calls.length, 0);
    assert.equal(mocks.perform.mock.calls.length, 0);
  });

  it("rejects browser-only click.force before opening or sending native input", async () => {
    const locator = { by: "stable-id", value: "save" } as const;
    await assert.rejects(
      () => run({ steps: [{ do: { action: "click", locator, force: true } }] }),
      /click\.force is browser-only/,
    );
    assert.equal(mocks.open.mock.calls.length, 0);
    assert.equal(mocks.perform.mock.calls.length, 0);
  });

  it("rejects browser viewport semantics before opening the native session", async () => {
    await assert.rejects(
      () => run({ viewport: { width: 800, height: 600 }, steps: [{ do: { action: "wait", ms: 0 } }] }),
      /viewport overrides/,
    );
    assert.equal(mocks.open.mock.calls.length, 0);
  });
});
