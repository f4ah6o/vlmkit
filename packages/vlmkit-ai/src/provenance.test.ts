import assert from "node:assert/strict";
import { describe, it } from "vite-plus/test";
import { PNG } from "pngjs";
import {
  assertExternalAiAllowed,
  assertExternalAiImageAllowed,
  normalizeImageInput,
  sanitizePngForExternalAi,
  type VlmImageInput,
} from "./provenance.ts";
import { VrtConfigError } from "./errors.ts";

function poisonPng(): Buffer {
  const png = new PNG({ width: 4, height: 2 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      png.data[i] = x < 2 ? 255 : 17;
      png.data[i + 1] = y === 0 ? 77 : 19;
      png.data[i + 2] = 33;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe("external AI provenance gate", () => {
  it("treats legacy bare input as unclassified and fails closed", () => {
    const poison = "POISON_DO_NOT_EGRESS";
    assert.equal(normalizeImageInput(poison).provenance, "unclassified");
    assert.throws(
      () => assertExternalAiImageAllowed(poison),
      (error: unknown) => {
        assert.ok(error instanceof VrtConfigError);
        assert.equal(error.code, "EXTERNAL_AI_POLICY");
        assert.doesNotMatch(error.message, /POISON_DO_NOT_EGRESS/);
        return true;
      },
    );
  });

  it("allows only explicitly permitted provenance", () => {
    assert.doesNotThrow(() => assertExternalAiAllowed({ provenance: "app_owned" }, "image"));
    assert.doesNotThrow(() => assertExternalAiAllowed({ provenance: "sanitized" }, "image"));
    assert.throws(() => assertExternalAiAllowed({ provenance: "restricted_content" }, "text"), /egress blocked/);
    assert.throws(() => assertExternalAiAllowed({ provenance: "unclassified" }, "image"), /egress blocked/);
  });

  it("masks restricted pixels without changing viewport dimensions", () => {
    const input: VlmImageInput = {
      bytes: poisonPng(),
      mediaType: "image/png",
      provenance: "restricted_content",
      source: "capture",
    };
    const sanitized = sanitizePngForExternalAi(input, [{ left: 0, top: 0, width: 2, height: 2 }]);
    assert.equal(sanitized.provenance, "sanitized");
    assert.equal(sanitized.source, "sanitized");

    const before = PNG.sync.read(poisonPng());
    const after = PNG.sync.read(Buffer.from(sanitized.bytes as Uint8Array));
    assert.equal(after.width, before.width);
    assert.equal(after.height, before.height);

    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        const i = (y * after.width + x) * 4;
        assert.deepEqual([...after.data.subarray(i, i + 4)], [0, 0, 0, 255]);
      }
    }
    const allowed = (0 * after.width + 3) * 4;
    assert.deepEqual(
      [...after.data.subarray(allowed, allowed + 4)],
      [...before.data.subarray(allowed, allowed + 4)],
    );
    assert.doesNotThrow(() => assertExternalAiImageAllowed(sanitized));
  });
});
