import assert from "node:assert/strict";
import { describe, it } from "vite-plus/test";
import { PNG } from "pngjs";
import {
  compareRendererParityData,
  validateRendererParityManifest,
  type ParityDomSnapshot,
} from "./renderer-parity.ts";

function png(color: [number, number, number, number], width = 2, height = 2): Buffer {
  const image = new PNG({ width, height });
  for (let offset = 0; offset < image.data.length; offset += 4) image.data.set(color, offset);
  return PNG.sync.write(image);
}

function dom(overrides: Partial<ParityDomSnapshot> = {}): ParityDomSnapshot {
  return {
    aria: '- button "Save"',
    root: { width: 40, height: 24 },
    activePath: null,
    hoverPath: null,
    invalidReferences: [],
    targets: { button: "root" },
    nodes: [
      {
        path: "root",
        tag: "button",
        role: "button",
        name: "Save",
        text: "Save",
        attributes: { type: "button" },
        states: { disabled: false },
        rect: { x: 0, y: 0, width: 40, height: 24 },
        styles: { color: "rgb(0, 0, 0)", padding: "4px 8px" },
      },
    ],
    ...overrides,
  };
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kumoVersion: "2.14.0",
    viewports: [{ id: "desktop", width: 1280, height: 800 }],
    cases: [
      {
        id: "button-primary",
        component: "button",
        props: { variant: "primary" },
        interactions: [{ type: "click", target: "button", expectText: "Saved" }],
      },
    ],
    ...overrides,
  };
}

describe("renderer parity manifest", () => {
  it("accepts the gallery-owned case, viewport, and interaction contract", () => {
    const result = validateRendererParityManifest(manifest());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.manifest.cases[0]!.id, "button-primary");
      assert.equal(result.manifest.cases[0]!.interactions?.[0]?.type, "click");
      assert.equal(result.manifest.viewports[0]!.width, 1280);
    }
  });

  it("accepts a keyboard press and fails closed when its key is missing", () => {
    const accepted = validateRendererParityManifest(
      manifest({
        cases: [
          {
            id: "button-enter",
            component: "button",
            interactions: [{ type: "press", target: "button", value: "Enter" }],
          },
        ],
      }),
    );
    assert.equal(accepted.ok, true);
    const missingKey = validateRendererParityManifest(
      manifest({
        cases: [{ id: "button-enter", component: "button", interactions: [{ type: "press", target: "button" }] }],
      }),
    );
    assert.equal(missingKey.ok, false);
    if (!missingKey.ok) assert.match(missingKey.failures.map((failure) => failure.message).join(" "), /needs a key/);
  });

  it("accepts blur actions as an explicit interaction state", () => {
    const result = validateRendererParityManifest(
      manifest({
        cases: [
          {
            id: "input-blur",
            component: "input",
            interactions: [
              { type: "focus", target: "input" },
              { type: "blur", target: "input" },
            ],
          },
        ],
      }),
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.manifest.cases[0]!.interactions?.[1]?.type, "blur");
  });

  it("accepts viewport-scoped actions and validates every declared viewport", () => {
    const scoped = validateRendererParityManifest(
      manifest({
        viewports: [
          { id: "desktop", width: 1280, height: 900 },
          { id: "mobile", width: 390, height: 844 },
        ],
        cases: [
          {
            id: "mobile-drawer",
            component: "appShell",
            interactions: [{ type: "click", target: "sidebarTrigger", viewports: ["mobile"] }],
          },
        ],
      }),
    );
    assert.equal(scoped.ok, true);
    if (scoped.ok) assert.deepEqual(scoped.manifest.cases[0]!.interactions?.[0]?.viewports, ["mobile"]);

    for (const viewports of [[], ["tablet"], ["mobile", "mobile"]]) {
      const invalid = validateRendererParityManifest(
        manifest({
          viewports: [
            { id: "desktop", width: 1280, height: 900 },
            { id: "mobile", width: 390, height: 844 },
          ],
          cases: [
            {
              id: "mobile-drawer",
              component: "appShell",
              interactions: [{ type: "click", target: "sidebarTrigger", viewports }],
            },
          ],
        }),
      );
      assert.equal(invalid.ok, false);
    }
  });

  it("validates nonnegative click-count expectations for disabled controls", () => {
    const valid = validateRendererParityManifest(
      manifest({
        cases: [
          {
            id: "disabled-button",
            component: "button",
            interactions: [{ type: "press", target: "button", value: "Enter", expect: { clickCount: 0 } }],
          },
        ],
      }),
    );
    assert.equal(valid.ok, true);

    const invalid = validateRendererParityManifest(
      manifest({
        cases: [
          {
            id: "disabled-button",
            component: "button",
            interactions: [{ type: "press", target: "button", value: "Enter", expect: { clickCount: -1 } }],
          },
        ],
      }),
    );
    assert.equal(invalid.ok, false);
  });

  it("fails closed on empty coverage, duplicate ids, unsupported APIs, and bad interaction targets", () => {
    const empty = validateRendererParityManifest(manifest({ cases: [] }));
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.match(empty.failures.map((failure) => failure.message).join(" "), /at least one case/);

    const duplicate = validateRendererParityManifest(
      manifest({
        cases: [
          { id: "x", component: "button" },
          { id: "x", component: "button" },
        ],
      }),
    );
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok)
      assert.match(duplicate.failures.map((failure) => failure.message).join(" "), /duplicate case id/);

    const unsupported = validateRendererParityManifest(manifest({ cases: [{ id: "x", component: "other" }] }));
    assert.equal(unsupported.ok, false);
    if (!unsupported.ok)
      assert.match(unsupported.failures.map((failure) => failure.message).join(" "), /unsupported component/);

    const badInteraction = validateRendererParityManifest(
      manifest({ cases: [{ id: "x", component: "input", interactions: [{ type: "fill", target: "input" }] }] }),
    );
    assert.equal(badInteraction.ok, false);
    if (!badInteraction.ok)
      assert.match(badInteraction.failures.map((failure) => failure.message).join(" "), /needs a string value/);
  });

  it("rejects viewport dimensions beyond the deterministic capture budget", () => {
    const result = validateRendererParityManifest(
      manifest({ viewports: [{ id: "large", width: 8192, height: 8192 }] }),
    );
    assert.equal(result.ok, false);
    if (!result.ok)
      assert.match(result.failures.map((failure) => failure.message).join(" "), /16-megapixel capture limit/);
  });
});

describe("renderer parity comparison", () => {
  const reference = { png: png([255, 255, 255, 255]), dom: dom(), action: { events: [] } };

  it("passes identical pixels, accessibility tree, DOM, style, layout, and action evidence", () => {
    const result = compareRendererParityData({
      reference,
      candidate: { ...reference, png: Buffer.from(reference.png), dom: structuredClone(reference.dom) },
    });
    assert.equal(result.ok, true);
    assert.equal(result.pixel.differentPixels, 0);
    assert.deepEqual(result.semanticDiffs, []);
    assert.deepEqual(result.styleDiffs, []);
    assert.deepEqual(result.layoutDiffs, []);
    assert.deepEqual(result.behaviorDiffs, []);
  });

  it("fails on a one-pixel paint mutation even when the DOM and styles are unchanged", () => {
    const changed = png([255, 255, 255, 255]);
    const image = PNG.sync.read(changed);
    image.data[0] = 254;
    const result = compareRendererParityData({
      reference,
      candidate: { ...reference, png: PNG.sync.write(image) },
    });
    assert.equal(result.ok, false);
    assert.equal(result.pixel.differentPixels, 1);
  });

  it("counts alpha-only changes as exact RGBA pixel drift", () => {
    const changed = PNG.sync.read(reference.png);
    changed.data[3] = 128;
    const result = compareRendererParityData({
      reference,
      candidate: { ...reference, png: PNG.sync.write(changed) },
    });
    assert.equal(result.ok, false);
    assert.equal(result.pixel.differentPixels, 1);
  });

  it("counts RGB changes in fully transparent pixels", () => {
    const transparentReference = { ...reference, png: png([0, 0, 0, 0]) };
    const changed = PNG.sync.read(transparentReference.png);
    changed.data[0] = 255;
    changed.data[1] = 255;
    changed.data[2] = 255;
    const transparentCandidate = {
      ...transparentReference,
      png: PNG.sync.write(changed),
    };
    const result = compareRendererParityData({
      reference: transparentReference,
      candidate: transparentCandidate,
    });
    assert.equal(result.ok, false);
    assert.equal(result.pixel.differentPixels, 1);
  });

  it("fails on different screenshot dimensions even when the shared pixels match", () => {
    const result = compareRendererParityData({
      reference,
      candidate: { ...reference, png: png([255, 255, 255, 255], 3, 2) },
    });
    assert.equal(result.ok, false);
    assert.equal(result.pixel.dimensionsMatch, false);
  });

  it("fails on computed-style drift below any pixel threshold", () => {
    const candidateDom = dom({
      nodes: [
        {
          ...dom().nodes[0]!,
          styles: { color: "rgb(1, 1, 1)", padding: "4px 8px" },
        },
      ],
    });
    const result = compareRendererParityData({ reference, candidate: { ...reference, dom: candidateDom } });
    assert.equal(result.ok, false);
    assert.match(result.styleDiffs.join(" "), /color/);
  });

  it("fails on accessible names, layout size, and interaction-event drift", () => {
    const candidateDom = dom({
      aria: '- button "Submit"',
      root: { width: 41, height: 24 },
      nodes: [{ ...dom().nodes[0]!, name: "Submit", text: "Submit", rect: { x: 0, y: 0, width: 41, height: 24 } }],
    });
    const result = compareRendererParityData({
      reference,
      candidate: { ...reference, dom: candidateDom, action: { events: [{ type: "click", target: "button" }] } },
    });
    assert.equal(result.ok, false);
    assert.ok(result.semanticDiffs.length > 0);
    assert.ok(result.layoutDiffs.length > 0);
    assert.ok(result.behaviorDiffs.length > 0);
  });

  it("fails when a renderer emits an unexpected input or change event during another action", () => {
    const result = compareRendererParityData({
      reference: {
        ...reference,
        action: { events: [{ type: "focusin", target: "input" }] },
      },
      candidate: {
        ...reference,
        action: {
          events: [
            { type: "focusin", target: "input" },
            { type: "input", target: "input" },
          ],
        },
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.behaviorDiffs.join(" "), /event sequence differs/);
  });

  it("fails when keyboard activation is missing or duplicated", () => {
    const expectedEvents = [
      { type: "keydown", target: "button" },
      { type: "keyup", target: "button" },
      { type: "click", target: "button" },
    ];
    for (const candidateEvents of [
      [
        { type: "keydown", target: "button" },
        { type: "keyup", target: "button" },
      ],
      [...expectedEvents, { type: "click", target: "button" }],
    ]) {
      const result = compareRendererParityData({
        reference: { ...reference, action: { events: expectedEvents } },
        candidate: { ...reference, action: { events: candidateEvents } },
      });
      assert.equal(result.ok, false);
      assert.match(result.behaviorDiffs.join(" "), /event sequence differs/);
    }
  });

  it("fails when equivalent-looking interaction markers point to different DOM elements", () => {
    const result = compareRendererParityData({
      reference,
      candidate: { ...reference, dom: dom({ targets: { button: "root/span:nth-child(1)" } }) },
    });
    assert.equal(result.ok, false);
    assert.match(result.semanticDiffs.join(" "), /interaction targets/);
  });

  it("fails on missing or additional DOM nodes rather than comparing only the shared prefix", () => {
    const result = compareRendererParityData({
      reference,
      candidate: {
        ...reference,
        dom: dom({ nodes: [...dom().nodes, { ...dom().nodes[0]!, path: "root/span:nth-child(1)", tag: "span" }] }),
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.semanticDiffs.join(" "), /DOM node count differs/);
  });

  it("fails closed when either DOM contains duplicate IDs or unresolved ID references", () => {
    const invalidDom = dom({ invalidReferences: ['aria-labelledby references missing id "label"'] });
    const result = compareRendererParityData({ reference, candidate: { ...reference, dom: invalidDom } });
    assert.equal(result.ok, false);
    assert.match(result.semanticDiffs.join(" "), /unresolved ID references/);
  });
});
