import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vite-plus/test";
import { createUnifiedLLMClient } from "./llm-client.ts";
import { VrtConfigError } from "./errors.ts";

let originalFetch: typeof globalThis.fetch;
let originalKey: string | undefined;
let calls = 0;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
});

describe("unified LLM external-AI provenance gate", () => {
  it("rejects restricted derived text before transport", async () => {
    const client = createUnifiedLLMClient({ provider: "openrouter", model: "vendor/model" })!;
    await assert.rejects(
      () =>
        client.complete({
          text: "POISON_DO_NOT_EGRESS",
          provenance: "restricted_content",
          source: "ocr",
        }),
      (error: unknown) => error instanceof VrtConfigError && error.code === "EXTERNAL_AI_POLICY",
    );
    assert.equal(calls, 0);
  });

  it("rejects an unclassified image before transport", async () => {
    const client = createUnifiedLLMClient({ provider: "openrouter", model: "vendor/model" })!;
    await assert.rejects(
      () => client.completeWithImages([{ type: "image", base64: "POISON_DO_NOT_EGRESS" }]),
      (error: unknown) => error instanceof VrtConfigError && error.code === "EXTERNAL_AI_POLICY",
    );
    assert.equal(calls, 0);
  });

  it("allows app-owned image content", async () => {
    const client = createUnifiedLLMClient({ provider: "openrouter", model: "vendor/model" })!;
    const result = await client.completeWithImages([
      { type: "text", text: "Inspect this fixture." },
      { type: "image", base64: "SAFE_FIXTURE", provenance: "app_owned" },
    ]);
    assert.equal(result.content, "ok");
    assert.equal(calls, 1);
  });
});
