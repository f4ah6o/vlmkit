/**
 * Transport-neutral content provenance shared by browser/native capture and AI egress.
 *
 * This is policy metadata, not a classifier result. Callers attach it based on ownership and
 * data-flow rules; unclassified content stays fail-closed at external-AI boundaries.
 */
export type ContentProvenance = "app_owned" | "restricted_content" | "unclassified" | "sanitized";

export type ContentSource = "capture" | "file" | "generated" | "sanitized";

export interface ContentPolicyMetadata {
  provenance: ContentProvenance;
  source?: ContentSource;
}

export function contentPolicyMetadata(
  provenance: ContentProvenance = "unclassified",
  source?: ContentSource,
): ContentPolicyMetadata {
  return {
    provenance,
    ...(source ? { source } : {}),
  };
}
