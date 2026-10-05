import assert from "node:assert/strict";
import { describe, it } from "vite-plus/test";
import type { ContentPolicyMetadata, ContentProvenance } from "@mizchi/vlmkit-core/content-provenance.ts";
import { createApiApp } from "./api-app.ts";
import { VrtClient } from "./client.ts";
import { CONTENT_POLICY_HEADER, decodeContentPolicy, encodeContentPolicy } from "./content-policy.ts";

const invalidPolicies = [
  undefined,
  null,
  {},
  [],
  "app_owned",
  { provenance: "unknown" },
  { provenance: "app_owned", source: "unknown" },
  { provenance: "app_owned", source: null },
  { provenance: "app_owned", unexpected: true },
];

function appWithPolicy(policy: unknown) {
  return createApiApp({
    cloudflareQuickActions: {
      async screenshot() {
        return {
          bytes: new Uint8Array([1, 2, 3]).buffer,
          contentType: "image/png",
          browserMsUsed: 25,
          contentPolicy: policy as ContentPolicyMetadata,
        };
      },
      async startCrawl() {
        throw new Error("unused");
      },
      async getCrawlResult() {
        throw new Error("unused");
      },
    },
  });
}

describe("binary screenshot content policy", () => {
  it("preserves every valid provenance and optional source exactly through server and client", async () => {
    const originalFetch = globalThis.fetch;
    try {
      for (const provenance of [
        "restricted_content",
        "unclassified",
        "app_owned",
        "sanitized",
      ] as ContentProvenance[]) {
        for (const source of [undefined, "capture", "file", "generated", "sanitized"] as const) {
          const policy: ContentPolicyMetadata = { provenance, ...(source ? { source } : {}) };
          const app = appWithPolicy(policy);
          // Entirely in process: no remote Cloudflare call, socket, image, or credentials.
          globalThis.fetch = async (input, init) => app.request(new Request(input, init));
          const result = await new VrtClient("http://vrt.local").cloudflareScreenshot({ provenance: "app_owned" });
          assert.deepEqual(result.contentPolicy, policy, "provider policy must not be overwritten by request metadata");
          assert.deepEqual(new Uint8Array(result.bytes), new Uint8Array([1, 2, 3]));
          assert.equal(result.contentType, "image/png");
          assert.equal(result.browserMsUsed, 25);
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refuses missing or invalid provider policy before serving screenshot bytes", async () => {
    for (const policy of invalidPolicies) {
      const response = await appWithPolicy(policy).request("http://vrt.local/api/cloudflare/screenshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "Missing or invalid screenshot content policy" });
      assert.equal(response.headers.get(CONTENT_POLICY_HEADER), null);
    }
  });

  it("refuses missing, malformed, or invalid response metadata rather than inferring from the request", async () => {
    const originalFetch = globalThis.fetch;
    try {
      for (const header of [null, "{", ...invalidPolicies.map((policy) => JSON.stringify(policy) ?? null)]) {
        globalThis.fetch = async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            headers: header === null ? {} : { [CONTENT_POLICY_HEADER]: header },
          });
        await assert.rejects(
          new VrtClient("http://vrt.local").cloudflareScreenshot({ provenance: "app_owned" }),
          /Missing or invalid screenshot content policy/,
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("serializes only validated snapshots, ignoring inherited serialization hooks", () => {
    let reads = 0;
    const policy = Object.create({
      source: "capture",
      toJSON() {
        return { provenance: "app_owned" };
      },
    });
    Object.defineProperty(policy, "provenance", {
      enumerable: true,
      get() {
        return ++reads === 1 ? "restricted_content" : "app_owned";
      },
    });
    assert.deepEqual(decodeContentPolicy(encodeContentPolicy(policy)), {
      provenance: "restricted_content",
      source: "capture",
    });
    assert.equal(reads, 1);
    assert.deepEqual(decodeContentPolicy(encodeContentPolicy({ provenance: "unclassified", source: undefined })), {
      provenance: "unclassified",
    });
    assert.throws(() => encodeContentPolicy(Object.create({ provenance: "app_owned" })), /Missing or invalid/);
  });

  it("rejects unsupported policy fields and never silently defaults the codec", () => {
    for (const policy of invalidPolicies) {
      assert.throws(() => encodeContentPolicy(policy as ContentPolicyMetadata), /Missing or invalid/);
      assert.throws(() => decodeContentPolicy(JSON.stringify(policy) ?? null), /Missing or invalid/);
    }
  });
});
