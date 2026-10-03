import { PNG } from "pngjs";
import type { ContentProvenance, ContentSource } from "@mizchi/vlmkit-core/content-provenance.ts";
import { VrtConfigError } from "./errors.ts";

export type { ContentProvenance, ContentSource } from "@mizchi/vlmkit-core/content-provenance.ts";

export interface VlmImageInput {
  /**
   * Base64 when a string, raw bytes when Uint8Array.
   * Bare legacy strings at API boundaries are normalized to unclassified.
   */
  bytes: Uint8Array | string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  provenance: ContentProvenance;
  source?: ContentSource;
}

export interface VlmTextInput {
  text: string;
  provenance: ContentProvenance;
  source?: "prompt" | "ocr" | "accessibility" | "caption" | "file" | "generated" | "sanitized";
}

export interface RestrictedRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface NormalizedImageInput {
  base64: string;
  mediaType: VlmImageInput["mediaType"];
  provenance: ContentProvenance;
  source?: ContentSource;
}

const ALLOWED: ReadonlySet<ContentProvenance> = new Set(["app_owned", "sanitized"]);

function policyError(kind: "image" | "text", provenance: ContentProvenance, label?: string): VrtConfigError {
  const suffix = label ? ` (${label})` : "";
  return new VrtConfigError(
    "EXTERNAL_AI_POLICY",
    `External AI egress blocked for ${kind}${suffix}: provenance "${provenance}" is not explicitly allowed.`,
  );
}

/**
 * The single fail-closed decision used by external provider adapters.
 * Never include payload bytes/text in the error message.
 */
export function assertExternalAiAllowed(
  value: { provenance?: ContentProvenance },
  kind: "image" | "text",
  label?: string,
): void {
  const provenance = value.provenance ?? "unclassified";
  if (!ALLOWED.has(provenance)) throw policyError(kind, provenance, label);
}

export function normalizeImageInput(
  input: VlmImageInput | string | Uint8Array,
  options?: {
    provenance?: ContentProvenance;
    mediaType?: VlmImageInput["mediaType"];
    source?: ContentSource;
  },
): NormalizedImageInput {
  if (typeof input === "object" && !(input instanceof Uint8Array) && "bytes" in input) {
    return {
      base64: typeof input.bytes === "string" ? input.bytes : Buffer.from(input.bytes).toString("base64"),
      mediaType: input.mediaType,
      provenance: input.provenance,
      ...(input.source ? { source: input.source } : {}),
    };
  }
  return {
    base64: typeof input === "string" ? input : Buffer.from(input).toString("base64"),
    mediaType: options?.mediaType ?? "image/png",
    provenance: options?.provenance ?? "unclassified",
    ...(options?.source ? { source: options.source } : {}),
  };
}

export function assertExternalAiImageAllowed(
  input: VlmImageInput | string | Uint8Array,
  options?: {
    provenance?: ContentProvenance;
    mediaType?: VlmImageInput["mediaType"];
    source?: ContentSource;
    label?: string;
  },
): NormalizedImageInput {
  const normalized = normalizeImageInput(input, options);
  assertExternalAiAllowed(normalized, "image", options?.label);
  return normalized;
}

export function assertExternalAiMessageAllowed(
  content:
    | string
    | readonly Array<
        | { type: "text"; text: string; provenance?: ContentProvenance }
        | { type: "image"; provenance?: ContentProvenance }
      >,
): void {
  if (typeof content === "string") return; // direct caller-owned prompt
  for (const part of content) {
    if (part.type === "image") {
      assertExternalAiAllowed(part, "image");
    } else if (part.provenance !== undefined) {
      assertExternalAiAllowed(part, "text");
    }
  }
}

/**
 * Explicit declassification for visual UI checks: mask restricted rectangles locally,
 * preserve exact image dimensions, and return a new sanitized object.
 */
export function sanitizePngForExternalAi(
  input: VlmImageInput | string | Uint8Array,
  regions: readonly RestrictedRegion[],
  options?: { fill?: readonly [number, number, number, number] },
): VlmImageInput {
  const normalized = normalizeImageInput(input);
  if (normalized.mediaType !== "image/png") {
    throw new VrtConfigError("INVALID_REQUEST", "sanitizePngForExternalAi currently accepts image/png only");
  }
  const png = PNG.sync.read(Buffer.from(normalized.base64, "base64"));
  const fill = options?.fill ?? [0, 0, 0, 255];
  if (regions.length === 0) {
    throw new VrtConfigError("INVALID_REQUEST", "sanitizePngForExternalAi: at least one restricted region is required");
  }

  let changedPixels = 0;
  for (const region of regions) {
    if (![region.left, region.top, region.width, region.height].every(Number.isFinite)) {
      throw new VrtConfigError("INVALID_REQUEST", "sanitizePngForExternalAi: region coordinates must be finite");
    }
    if (region.width <= 0 || region.height <= 0) {
      throw new VrtConfigError("INVALID_REQUEST", "sanitizePngForExternalAi: region width and height must be positive");
    }
    const left = Math.max(0, Math.floor(region.left));
    const top = Math.max(0, Math.floor(region.top));
    const right = Math.min(png.width, Math.ceil(region.left + region.width));
    const bottom = Math.min(png.height, Math.ceil(region.top + region.height));
    if (right <= left || bottom <= top) {
      throw new VrtConfigError("INVALID_REQUEST", "sanitizePngForExternalAi: region must intersect the image");
    }
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const i = (y * png.width + x) * 4;
        if (
          png.data[i] !== fill[0] ||
          png.data[i + 1] !== fill[1] ||
          png.data[i + 2] !== fill[2] ||
          png.data[i + 3] !== fill[3]
        ) {
          changedPixels++;
        }
        png.data[i] = fill[0];
        png.data[i + 1] = fill[1];
        png.data[i + 2] = fill[2];
        png.data[i + 3] = fill[3];
      }
    }
  }

  if (changedPixels === 0) {
    throw new VrtConfigError("INVALID_REQUEST", "sanitizePngForExternalAi: sanitization changed no pixels");
  }

  return {
    bytes: new Uint8Array(PNG.sync.write(png)),
    mediaType: "image/png",
    provenance: "sanitized",
    source: "sanitized",
  };
}
