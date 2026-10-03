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

describe("native interaction map (mock session, no live acceptance)", () => {
  it("records focus and checkbox activation transitions and closes the session", async () => {
    let focused = false;
    let checked = false;
    const close = vi.fn().mockResolvedValue(undefined);
    const perform = vi.fn().mockImplementation(async (action) => {
      if (action.kind === "focus") focused = true;
      if (action.kind === "press") checked = !checked;
    });
    mocks.open.mockResolvedValue({
      close,
      perform,
      async capture({ treePath, pngPath }: { treePath: string; pngPath: string }) {
        const png = new PNG({ width: 20, height: 20 });
        png.data.fill(focused ? 0 : 255);
        await writeFile(pngPath, PNG.sync.write(png));
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
    assert.equal(map.elements[0]?.activation?.key, "AXPress");
    assert.equal(close.mock.calls.length, 1);
    assert.equal(perform.mock.calls.length, 2);
  });
});
