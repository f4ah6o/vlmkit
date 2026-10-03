# Content provenance and fail-closed external-AI egress gate

Status: design / open
Date: 2026-10-03
Scope: this fork; generic VLMKit capability

## Goal

Allow applications to use VLMKit at full fidelity for ordinary UI verification while preventing selected source content from being sent to external AI providers.

The mechanism must be generic and based on **provenance/policy labels**, not a content classifier.

This is needed for applications that display material which may be:

- private;
- purchased/licensed;
- copyrighted;
- customer data;
- sensitive;
- NSFW;
- simply not intended for external model upload.

Whether the material looks safe is not a sufficient policy decision.

## Current risk

`@mizchi/vlmkit-ai` accepts image data through APIs such as:

- `analyzeImage(imageBase64, ...)`;
- `analyzeImageFile(imagePath, ...)`;
- `analyzeDiff(baselineBase64, currentBase64, ...)`.

Provider implementations then send those images to OpenRouter, Gemini, or Anthropic.

Today the image payload itself carries no provenance contract. A caller has to remember whether a screenshot is allowed to leave the machine.

That is not strong enough for mixed UI surfaces where an application-owned shell can contain an opaque third-party/private content region.

## Design principle

Separate:

1. **what VLMKit may inspect locally**, from
2. **what VLMKit may send to an external AI provider**.

Deterministic/local verification should remain useful and high fidelity.

External-AI transmission should be a distinct, fail-closed boundary.

## Proposed provenance model

Introduce a small transport-neutral provenance type.

Initial policy classes:

```ts
type ContentProvenance =
  | "app_owned"
  | "restricted_content"
  | "unclassified";
```

The exact names are not important. The semantics are.

### `app_owned`

The caller explicitly owns/controls the content and permits it for the requested processing path.

Examples:

- application chrome;
- layout geometry;
- synthetic fixture screenshots;
- application-owned copy;
- fixed diagnostics.

### `restricted_content`

Content may be processed locally but must not be transmitted to an external AI provider.

Examples:

- purchased media;
- user documents;
- private store/catalog content;
- game/video/canvas content;
- customer-controlled screenshots.

### `unclassified`

No trusted provenance has been attached.

External AI MUST reject this class.

## Policy is independent from NSFW classification

Do not add a nudity/NSFW detector as the security boundary.

A SFW copyrighted game screenshot can still be restricted.
An ordinary private customer document can still be restricted.
A synthetic NSFW-free test image can be explicitly permitted.

The caller defines provenance based on ownership and data-flow policy.

## Provenance-carrying image input

Avoid APIs where a bare base64 string can reach a provider.

Target shape:

```ts
type VlmImageInput = {
  bytes: Uint8Array | string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  provenance: ContentProvenance;
  source?: "capture" | "file" | "generated" | "sanitized";
};
```

For a migration period, existing bare-string APIs may remain internally wrapped as `unclassified`, which means they are rejected by external-provider calls unless the caller explicitly upgrades them.

Do not silently assume legacy input is permitted.

## Mixed-surface representation

A screenshot is often too coarse a security unit.

Support sanitized/schematic representations where restricted regions are replaced before external analysis.

Example:

```text
application window
  app-owned toolbar
  app-owned navigation
  restricted rectangle -> opaque placeholder
  app-owned status controls
```

The sanitized image itself may be labeled `app_owned` or a dedicated `sanitized` provenance only after the sanitizer proves that restricted payload bytes/text are absent.

The sanitizer must preserve useful non-content information such as:

- actual viewport/window dimensions;
- aspect ratio;
- application-owned geometry;
- region bounds;
- fixed semantic roles;
- fixed action IDs.

Do not force the whole observation into coarse buckets merely because one child region is restricted.

## External-AI egress gate

Create one common gate used by all external providers.

Conceptually:

```ts
assertExternalAiAllowed(input)
```

It must run immediately before request serialization/provider transport.

Rules:

- `app_owned` -> allow;
- `restricted_content` -> reject;
- `unclassified` -> reject.

Provider adapters must not implement independent weaker policy.

The same gate should cover:

- OpenRouter;
- Gemini;
- Anthropic;
- future providers;
- image generation/edit inputs when source images are uploaded;
- external LLM prompts containing content-bearing extracted text.

## Text provenance

The problem is not limited to pixels.

Introduce equivalent handling for extracted text when it can originate from restricted content.

Examples that require provenance:

- OCR;
- DOM text;
- accessibility labels;
- captions/subtitles;
- image descriptions produced locally;
- filename/path-derived content;
- copied user text.

Fixed schema values, enum diagnostics, numeric geometry, and caller-owned prompts do not need to be treated as restricted merely because they accompany a restricted surface.

## Local deterministic processing

This issue MUST NOT make restricted content unusable for all VLMKit functionality.

Restricted input may be used by local deterministic processing when the caller permits it.

Examples:

- pixel diff;
- frame-change detection;
- geometry extraction;
- local hashing for ephemeral equality checks if policy permits;
- capture timing;
- local responsive/layout checks.

However, a local transform does not automatically declassify output.

Content-derived outputs such as OCR, embeddings, captions, perceptual fingerprints, or detailed descriptions remain restricted unless a sanitizer contract explicitly proves otherwise.

## Sanitizer / declassification contract

Only explicit sanitizers may convert restricted input into externally allowed input.

A sanitizer should return a new object rather than mutate provenance in place.

Example:

```ts
const safe = sanitizeForExternalAi(mixedSurface);
// safe.provenance === "app_owned" or "sanitized"
```

For visual UI verification a sanitizer may:

- replace restricted pixel regions with a solid/role-coded placeholder;
- remove restricted text nodes;
- remove image URLs and filenames;
- retain exact outer viewport dimensions;
- retain app-owned geometry and semantics;
- preserve source aspect ratio.

The sanitizer must be testable with poison fixtures.

## Artifact policy hooks

Expose policy hooks for capture/reporting so restricted content is not accidentally retained in:

- screenshots;
- traces;
- videos;
- HTML/DOM dumps;
- prompt dumps;
- failure artifacts;
- HTTP diagnostics;
- CI uploads.

This does not mean VLMKit globally forbids these artifacts. The decision follows provenance/policy.

## CLI/config surface

Do not require every existing command to grow a complex flag immediately.

Start with programmatic/internal plumbing and one explicit strict mode.

Possible configuration:

```json
{
  "contentPolicy": {
    "externalAi": "require-explicit-allow"
  }
}
```

A future CLI can expose provenance-aware capture/sanitization once the contract is stable.

The default for direct external-AI upload of unclassified inputs should be fail-closed.

## Compatibility

Keep deterministic/key-free gates usable without any provider key.

The provenance implementation should not force browser-only or native-only assumptions.

It must work for:

- Playwright/browser surfaces;
- native black-box surfaces;
- generated/synthetic images;
- caller-provided screenshots;
- mixed application/content surfaces.

This also fits the native-driver work: a native session can expose high-fidelity application geometry while marking selected windows/regions restricted.

## Tests

Add poison fixtures that make leakage unmistakable without containing real private material.

Required cases:

- restricted image bytes rejected before provider fetch;
- unclassified image bytes rejected before provider fetch;
- app-owned synthetic image accepted;
- restricted OCR/text rejected before provider fetch;
- sanitized mixed surface accepted;
- sanitizer output contains no poison pixel block or poison string;
- sanitizer preserves viewport dimensions/aspect ratio;
- sanitizer preserves allowed application geometry;
- each external provider shares the same egress gate;
- provider errors/logging never echo rejected payload data.

Tests should mock transport and assert that rejected requests never reach `fetch` / provider SDK calls.

## Acceptance criteria

- [ ] All supported external VLM providers route through one fail-closed provenance gate.
- [ ] Bare/unclassified image input cannot be externally transmitted by default.
- [ ] Restricted image input can still participate in explicitly local deterministic operations.
- [ ] Restricted text/OCR cannot be inserted into external prompts by default.
- [ ] Mixed surfaces can preserve exact allowed geometry while masking only restricted content.
- [ ] Sanitized visual output preserves original aspect ratio.
- [ ] Poison-fixture tests prove rejected content never reaches mocked network transport.
- [ ] Existing key-free/deterministic workflows remain available.
- [ ] Browser and native drivers can attach the same provenance metadata.
- [ ] Documentation explains that policy is based on provenance/ownership, not NSFW classification.

## Non-goals

- NSFW detection.
- Copyright classification.
- Deciding legal permission from image contents.
- Making all VLMKit screenshots private by default.
- Reducing all application geometry to coarse buckets.
- Preventing callers from explicitly constructing and transmitting content they are authorized to send; the goal is to make the safe boundary explicit and difficult to bypass accidentally.
