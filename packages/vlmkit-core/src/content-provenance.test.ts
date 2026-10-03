import assert from "node:assert/strict";
import { describe, it } from "vite-plus/test";
import { contentPolicyMetadata } from "./content-provenance.ts";

describe("content provenance metadata", () => {
  it("defaults to unclassified", () => {
    assert.deepEqual(contentPolicyMetadata(), { provenance: "unclassified" });
  });

  it("carries the same capture provenance for any surface adapter", () => {
    assert.deepEqual(contentPolicyMetadata("restricted_content", "capture"), {
      provenance: "restricted_content",
      source: "capture",
    });
  });
});
