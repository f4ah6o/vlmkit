import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "vite-plus/test";
import { parseA11yTree } from "@mizchi/vlmkit-judge/a11y-tree.ts";
import {
  nativeLocatorForNode,
  nativeNodeMatchesLocator,
  nativeNodesForLocator,
  nativeSelectorForNode,
  nativeGroundingSample,
} from "./native-surface.ts";
import type { NativeInteractionSession, NativeCaptureResult } from "../a11y-tree/native-agent.ts";

const root = resolve(import.meta.dirname!, "../../../..");
const fixture = (name: string) =>
  parseA11yTree(readFileSync(join(root, "fixtures/native/macos", name, "a11y.json"), "utf8"));

describe("native surface pure contract", () => {
  it("maps Retina control bounds to finite screenshot hit-test coordinates", async () => {
    const tree = fixture("retina-2x");
    const node = tree.nodes.find((candidate) => candidate.identifier === "fixture.save")!;
    const points: { xPx: number; yPx: number }[] = [];
    const session = {
      async hitTest(point: { xPx: number; yPx: number }) {
        points.push(point);
        return { node };
      },
    } as unknown as NativeInteractionSession;
    const capture = {
      scale: 2,
      framePixels: { width: tree.viewport.width * 2, height: tree.viewport.height * 2 },
    } as NativeCaptureResult;
    const sample = await nativeGroundingSample(session, tree, capture, node);
    assert.deepEqual(points, [
      {
        xPx: Math.round((node.rect.left + node.rect.width / 2) * 2),
        yPx: Math.round((node.rect.top + node.rect.height / 2) * 2),
      },
    ]);
    assert.equal(sample.inFrame, true);
    assert.equal(sample.centreHit, true);
    assert.equal(sample.clipped, false);
  });
  it("prefers stable ids, then role/name, then structural paths", () => {
    const tree = fixture("basic");
    const save = tree.nodes.find((node) => node.identifier === "fixture.save")!;
    assert.deepEqual(nativeLocatorForNode(save), { by: "stable-id", value: "fixture.save" });
    assert.match(nativeSelectorForNode(save), /fixture\.save/);

    const named = { ...save, identifier: undefined };
    assert.deepEqual(nativeLocatorForNode(named), { by: "role-name", role: save.role, name: save.name });
    assert.equal(nativeNodeMatchesLocator(named, nativeLocatorForNode(named)), true);

    const pathOnly = { ...save, identifier: undefined, name: undefined };
    assert.deepEqual(nativeLocatorForNode(pathOnly), { by: "path", value: save.path });
  });

  it("role/name ambiguity stays explicit and nth selects deterministically", () => {
    const tree = fixture("duplicate-labels");
    const duplicates = tree.nodes.filter((node) => node.name === "Duplicate");
    assert.ok(duplicates.length >= 2);
    const locator = { by: "role-name", role: duplicates[0]!.role, name: "Duplicate" } as const;
    assert.equal(nativeNodesForLocator(tree, locator).length, duplicates.length);
    assert.deepEqual(nativeNodesForLocator(tree, { ...locator, nth: 1 }), [duplicates[1]]);
  });

  it("point locators are action-only and do not pretend to match a semantic node", () => {
    const tree = fixture("basic");
    assert.deepEqual(nativeNodesForLocator(tree, { by: "point", xPx: 10, yPx: 20 }), []);
    assert.equal(nativeNodeMatchesLocator(tree.nodes[0]!, { by: "point", xPx: 10, yPx: 20 }), false);
  });
});
