import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { describe, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../a11y-tree/native-agent.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../a11y-tree/native-agent.ts")>()),
  openNativeInteractionSession: mocks.open,
}));
import { buildNativeInteractionMap } from "./native-surface.ts";

async function writeFrame(path: string, value: number) {
  const png = new PNG({ width: 20, height: 20 });
  png.data.fill(value);
  await writeFile(path, PNG.sync.write(png));
}

describe("native interaction map (mock session, no live acceptance)", () => {
  it("uses physical Tab and the role's canonical physical key", async () => {
    let focused = false;
    let checked = false;
    const close = vi.fn().mockResolvedValue(undefined);
    const perform = vi.fn().mockImplementation(async (action) => {
      if (action.kind !== "key") return;
      if (action.keyCode === 48) focused = true;
      if (action.keyCode === 49) checked = !checked;
    });
    mocks.open.mockResolvedValue({
      close,
      perform,
      async capture({ treePath, pngPath }: { treePath: string; pngPath: string }) {
        await writeFrame(pngPath, focused ? 0 : 255);
        const tree = {
          viewport: { width: 20, height: 20 },
          nodes: [
            {
              path: "window[0]>checkbox[0]",
              role: "checkbox",
              name: "Remember",
              identifier: "remember",
              rect: { left: 0, top: 0, width: 20, height: 20 },
              states: { focused, checked },
              actions: ["tap"],
            },
          ],
        };
        await writeFile(treePath, JSON.stringify(tree));
        return { tree, capture: { scale: 1 } };
      },
    });

    const map = await buildNativeInteractionMap({ source: "macos:pid=1", maxElements: 1 });
    assert.equal(map.elements[0]?.tabReachable, true);
    assert.equal(map.elements[0]?.focusIndicator, true);
    assert.deepEqual(map.elements[0]?.activation?.ariaDelta.checked, ["false", "true"]);
    assert.equal(map.elements[0]?.activation?.key, "Space");
    assert.equal(close.mock.calls.length, 1);
    assert.ok(perform.mock.calls.some(([action]) => action.kind === "key" && action.keyCode === 48));
    assert.ok(perform.mock.calls.some(([action]) => action.kind === "key" && action.keyCode === 49));
    assert.equal(perform.mock.calls.some(([action]) => action.kind === "focus" || action.kind === "press"), false);
  });

  it("probes duplicate identifiers and names without generating ambiguous action locators", async () => {
    let focused = -1;
    const selected = [false, false];
    const close = vi.fn().mockResolvedValue(undefined);
    const perform = vi.fn().mockImplementation(async (action) => {
      if (action.kind !== "key") return;
      if (action.keyCode === 48) focused = (focused + 1) % 2;
      if (action.keyCode === 36 && focused >= 0) selected[focused] = !selected[focused];
    });
    mocks.open.mockResolvedValue({
      close,
      perform,
      async capture({ treePath, pngPath }: { treePath: string; pngPath: string }) {
        await writeFrame(pngPath, focused < 0 ? 255 : 60 + focused * 60);
        const tree = {
          viewport: { width: 20, height: 20 },
          nodes: [0, 1].map((index) => ({
            path: `window[0]>button[${index}]`,
            role: "button",
            name: "Duplicate",
            identifier: "duplicate-id",
            rect: { left: 0, top: index * 10, width: 20, height: 10 },
            states: { focused: focused === index, selected: selected[index] },
            actions: ["tap"],
          })),
        };
        await writeFile(treePath, JSON.stringify(tree));
        return { tree, capture: { scale: 1 } };
      },
    });

    const map = await buildNativeInteractionMap({ source: "macos:pid=1", maxElements: 2 });
    assert.deepEqual(
      map.elements.map((element) => element.tabReachable),
      [true, true],
    );
    assert.deepEqual(
      map.elements.map((element) => element.activation?.key),
      ["Enter", "Enter"],
    );
    assert.deepEqual(
      map.elements.map((element) => element.activation?.ariaDelta.selected),
      [
        ["false", "true"],
        ["false", "true"],
      ],
    );
    assert.equal(
      perform.mock.calls.some(([action]) => "locator" in action && action.locator !== undefined),
      false,
    );
    assert.equal(close.mock.calls.length, 1);
  });
});
