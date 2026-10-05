import type { ContentPolicyMetadata } from "@mizchi/vlmkit-core/content-provenance.ts";

/** Policy travels with binary screenshot responses; missing metadata is never inferred. */
export const CONTENT_POLICY_HEADER = "x-vlmkit-content-policy";

function validateContentPolicy(value: unknown): ContentPolicyMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "provenance")) {
    throw new Error("Missing or invalid screenshot content policy");
  }
  // Snapshot once, then serialize only a fresh record: a provider's toJSON/getters
  // must not relabel content after validation.
  const { provenance, source } = value as Record<string, unknown>;
  if (
    typeof provenance !== "string" ||
    !["app_owned", "restricted_content", "unclassified", "sanitized"].includes(provenance) ||
    (source !== undefined &&
      (typeof source !== "string" || !["capture", "file", "generated", "sanitized"].includes(source))) ||
    Object.keys(value).some((key) => key !== "provenance" && key !== "source")
  ) {
    throw new Error("Missing or invalid screenshot content policy");
  }
  return { provenance, ...(source !== undefined ? { source } : {}) } as ContentPolicyMetadata;
}

export function encodeContentPolicy(value: ContentPolicyMetadata): string {
  return JSON.stringify(validateContentPolicy(value));
}

export function decodeContentPolicy(header: string | null): ContentPolicyMetadata {
  let value: unknown;
  try {
    value = header === null ? null : JSON.parse(header);
  } catch {
    throw new Error("Missing or invalid screenshot content policy");
  }
  return validateContentPolicy(value);
}
