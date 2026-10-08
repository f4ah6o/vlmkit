/**
 * Deterministic parity check for independent renderers of one component API.
 *
 * The reference is rendered by the project's real framework implementation;
 * the candidate is mounted by the same gallery from its generated output. The
 * gallery supplies only the case manifest and a mount/unmount adapter. It does
 * not supply expected HTML, styles, or pixels, so there is no second oracle to
 * drift away from the reference implementation.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { DEFAULT_PAGE_LOAD_TIMEOUT_MS, type PageLoadOptions, navigatePage } from "@mizchi/vlmkit-core/page-load.ts";
import { settlePage } from "@mizchi/vlmkit-core/page-open.ts";
import { withBrowser } from "@mizchi/vlmkit-core/browser-launch.ts";
import type { RuleView } from "@mizchi/vlmkit-core/plugin/contract.ts";
import { applyRuleTiers, hiddenByRuleNote } from "@mizchi/vlmkit-core/plugin/rule-tier.ts";

export type ParitySource = "react" | "moonbit";
export type ParityActionType = "focus" | "blur" | "hover" | "click" | "fill" | "press";
export type ParityComponent = "button" | "input" | "text" | "layerCard" | "appShell";

export interface ParityInteraction {
  type: ParityActionType;
  /** Resolves to one element marked `data-parity-target` inside the mounted root. */
  target: string;
  value?: string;
  /** Restrict an action to declared viewports, for example a mobile-only drawer control. */
  viewports?: string[];
  expect?: { attribute?: string; value?: string; text?: string; clickCount?: number };
  expectText?: string;
}

export interface ParityCase {
  id: string;
  component: ParityComponent;
  props?: Record<string, unknown>;
  content?: string;
  interactions?: ParityInteraction[];
}

export interface ParityViewport {
  id: string;
  width: number;
  height: number;
}

export interface RendererParityManifest {
  schemaVersion: 1;
  kumoVersion: string;
  viewports: ParityViewport[];
  cases: ParityCase[];
}

export interface RendererParityOptions extends PageLoadOptions {
  manifestPath: string;
  gallery: string;
  outputDir: string;
}

export type RendererParityRule = "coverage-incomplete" | "capture-failed" | "interaction-failed" | "renderer-drift";

export interface RendererParityFailure {
  rule: RendererParityRule;
  message: string;
  caseId?: string;
  viewport?: string;
  state?: string;
  source?: ParitySource;
  evidence?: Record<string, unknown>;
}

export interface ParityRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ParityNodeSnapshot {
  path: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  attributes: Record<string, string>;
  states: Record<string, boolean | string>;
  rect: ParityRect;
  styles: Record<string, string>;
}

export interface ParityDomSnapshot {
  aria: string;
  root: { width: number; height: number };
  activePath: string | null;
  hoverPath: string | null;
  invalidReferences: string[];
  targets: Record<string, string>;
  nodes: ParityNodeSnapshot[];
}

export interface ParityActionCapture {
  events: Array<{ type: string; target: string }>;
}

export interface RendererParityCapture {
  caseId: string;
  component: ParityComponent;
  viewport: string;
  state: string;
  source: ParitySource;
  screenshotPath?: string;
  domPath?: string;
  dimensions?: { width: number; height: number };
  nodeCount?: number;
  action?: ParityActionCapture;
  error?: string;
}

export interface ParityComparison {
  caseId: string;
  component: ParityComponent;
  viewport: string;
  state: string;
  ok: boolean;
  pixel: {
    differentPixels: number;
    totalPixels: number;
    ratio: number;
    width: number;
    height: number;
    dimensionsMatch: boolean;
  };
  semanticDiffs: string[];
  styleDiffs: string[];
  layoutDiffs: string[];
  behaviorDiffs: string[];
  referencePath: string;
  candidatePath: string;
  diffPath?: string;
}

export interface RendererParityReport {
  ok: boolean;
  gallery: string;
  manifestPath: string;
  kumoVersion?: string;
  outputDir: string;
  reportPath: string;
  cases: number;
  viewports: number;
  captures: RendererParityCapture[];
  comparisons: ParityComparison[];
  failures: RendererParityFailure[];
}

const SOURCES: readonly ParitySource[] = ["react", "moonbit"];
const COMPONENTS: readonly ParityComponent[] = ["button", "input", "text", "layerCard", "appShell"];
const ACTION_TYPES: readonly ParityActionType[] = ["focus", "blur", "hover", "click", "fill", "press"];
const ROOT_SELECTOR = "[data-parity-root]";
const EVENT_TYPES = [
  "focusin",
  "focusout",
  "pointerover",
  "pointerout",
  "keydown",
  "keyup",
  "click",
  "input",
  "change",
] as const;
const CONTRACT_EVENT_TYPES = ["focusin", "focusout", "keydown", "keyup", "click", "input", "change"] as const;
const ACTION_EVENT_TYPES: Record<ParityActionType, readonly string[]> = {
  focus: CONTRACT_EVENT_TYPES,
  blur: CONTRACT_EVENT_TYPES,
  hover: [...CONTRACT_EVENT_TYPES, "pointerover", "pointerout"],
  click: CONTRACT_EVENT_TYPES,
  fill: CONTRACT_EVENT_TYPES,
  press: CONTRACT_EVENT_TYPES,
};

interface BrowserDiagnostic {
  type: string;
  message: string;
  url?: string;
  status?: number;
}

class ParityDeadlineError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`renderer parity ${operation} exceeded its ${timeoutMs}ms host deadline; the active pages were closed`);
    this.name = "ParityDeadlineError";
  }
}

/**
 * Bound browser work from the Node host, including page.evaluate calls whose
 * in-page promises never settle (for example document.fonts.ready or a gallery
 * mount adapter). Expiry closes every involved page before rejecting so late
 * browser work cannot leak into later cases.
 */
function withParityDeadline<T>(input: {
  operation: string;
  timeoutMs: number;
  pages?: readonly import("playwright").Page[];
  onTimeout?: () => void | Promise<void>;
  run: () => Promise<T>;
}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = Promise.resolve().then(input.run);
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      for (const page of input.pages ?? []) void page.close().catch(() => {});
      if (input.onTimeout) void Promise.resolve(input.onTimeout()).catch(() => {});
      reject(new ParityDeadlineError(input.operation, input.timeoutMs));
    }, input.timeoutMs);
  });
  return Promise.race([pending, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function watchBrowserDiagnostics(page: import("playwright").Page): BrowserDiagnostic[] {
  const diagnostics: BrowserDiagnostic[] = [];
  const resourceTypes = new Set(["document", "stylesheet", "script", "font", "image", "xhr", "fetch"]);
  const safeUrl = (rawUrl: string): string => {
    try {
      const url = new URL(rawUrl);
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return rawUrl.split(/[?#]/, 1)[0] ?? rawUrl;
    }
  };
  const isWatchedRequest = (request: import("playwright").Request): boolean => {
    const pathname = safeUrl(request.url());
    return resourceTypes.has(request.resourceType()) && !pathname.endsWith("/favicon.ico");
  };
  page.on("pageerror", (error) => {
    diagnostics.push({ type: "pageerror", message: error.message.slice(0, 500) });
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/favicon\.ico/i.test(text) || safeUrl(message.location().url).endsWith("/favicon.ico")) return;
    diagnostics.push({ type: "console-error", message: text.slice(0, 500) });
  });
  page.on("requestfailed", (request) => {
    if (!isWatchedRequest(request)) return;
    diagnostics.push({
      type: "request-failed",
      url: safeUrl(request.url()),
      message: request.failure()?.errorText ?? "resource request failed",
    });
  });
  page.on("response", (response) => {
    const request = response.request();
    if (response.status() < 400 || !isWatchedRequest(request)) return;
    diagnostics.push({
      type: "resource-response",
      url: safeUrl(response.url()),
      status: response.status(),
      message: response.statusText().slice(0, 200),
    });
  });
  return diagnostics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(value);
}

function manifestError(message: string): RendererParityFailure {
  return { rule: "coverage-incomplete", message };
}

export function validateRendererParityManifest(
  value: unknown,
): { ok: true; manifest: RendererParityManifest } | { ok: false; failures: RendererParityFailure[] } {
  const failures: RendererParityFailure[] = [];
  if (!isRecord(value)) return { ok: false, failures: [manifestError("manifest must be a JSON object")] };
  if (value.schemaVersion !== 1) failures.push(manifestError("manifest schemaVersion must be 1"));
  if (typeof value.kumoVersion !== "string" || value.kumoVersion.trim() === "") {
    failures.push(manifestError("manifest kumoVersion must name the pinned reference package version"));
  }

  const rawViewports = value.viewports;
  if (!Array.isArray(rawViewports) || rawViewports.length === 0) {
    failures.push(manifestError("manifest must declare at least one viewport"));
  }
  const viewports: ParityViewport[] = [];
  const viewportIds = new Set<string>();
  if (Array.isArray(rawViewports)) {
    for (const [index, raw] of rawViewports.entries()) {
      if (!isRecord(raw) || !validId(raw.id) || !Number.isInteger(raw.width) || !Number.isInteger(raw.height)) {
        failures.push(manifestError(`viewports[${index}] needs an id and positive integer width/height`));
        continue;
      }
      if ((raw.width as number) <= 0 || (raw.height as number) <= 0) {
        failures.push(manifestError(`viewport ${raw.id} has a non-positive size`));
        continue;
      }
      if (
        (raw.width as number) > 8192 ||
        (raw.height as number) > 8192 ||
        (raw.width as number) * (raw.height as number) > 16_777_216
      ) {
        failures.push(manifestError(`viewport ${raw.id} exceeds the 16-megapixel capture limit`));
        continue;
      }
      if (viewportIds.has(raw.id)) failures.push(manifestError(`duplicate viewport id "${raw.id}"`));
      viewportIds.add(raw.id);
      viewports.push({ id: raw.id, width: raw.width as number, height: raw.height as number });
    }
  }

  const rawCases = value.cases;
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    failures.push(manifestError("manifest must declare at least one case"));
  }
  const cases: ParityCase[] = [];
  const caseIds = new Set<string>();
  if (Array.isArray(rawCases)) {
    for (const [index, raw] of rawCases.entries()) {
      if (!isRecord(raw) || !validId(raw.id)) {
        failures.push(manifestError(`cases[${index}] needs a filesystem-safe id`));
        continue;
      }
      if (caseIds.has(raw.id)) failures.push(manifestError(`duplicate case id "${raw.id}"`));
      caseIds.add(raw.id);
      if (typeof raw.component !== "string" || !COMPONENTS.includes(raw.component as ParityComponent)) {
        failures.push(
          manifestError(`case ${raw.id} uses an unsupported component; supported: ${COMPONENTS.join(", ")}`),
        );
        continue;
      }
      if (raw.props !== undefined && !isRecord(raw.props)) {
        failures.push(manifestError(`case ${raw.id} props must be a JSON object`));
        continue;
      }
      if (raw.content !== undefined && typeof raw.content !== "string") {
        failures.push(manifestError(`case ${raw.id} content must be a string`));
        continue;
      }
      if (raw.interactions !== undefined && !Array.isArray(raw.interactions)) {
        failures.push(manifestError(`case ${raw.id} interactions must be an array`));
        continue;
      }

      const interactions: ParityInteraction[] = [];
      let invalidInteraction = false;
      for (const [interactionIndex, item] of ((raw.interactions as unknown[] | undefined) ?? []).entries()) {
        if (!isRecord(item) || !ACTION_TYPES.includes(item.type as ParityActionType) || !validId(item.target)) {
          failures.push(
            manifestError(`case ${raw.id} interaction ${interactionIndex + 1} needs a supported type and target id`),
          );
          invalidInteraction = true;
          continue;
        }
        if (item.type === "fill" && typeof item.value !== "string") {
          failures.push(manifestError(`case ${raw.id} fill interaction ${interactionIndex + 1} needs a string value`));
          invalidInteraction = true;
          continue;
        }
        if (item.type === "press" && (typeof item.value !== "string" || item.value.trim() === "")) {
          failures.push(manifestError(`case ${raw.id} press interaction ${interactionIndex + 1} needs a key in value`));
          invalidInteraction = true;
          continue;
        }
        if (item.value !== undefined && typeof item.value !== "string") {
          failures.push(manifestError(`case ${raw.id} interaction ${interactionIndex + 1} value must be a string`));
          invalidInteraction = true;
          continue;
        }
        if (item.expectText !== undefined && typeof item.expectText !== "string") {
          failures.push(
            manifestError(`case ${raw.id} interaction ${interactionIndex + 1} expectText must be a string`),
          );
          invalidInteraction = true;
          continue;
        }
        if (item.expect !== undefined) {
          if (!isRecord(item.expect)) {
            failures.push(manifestError(`case ${raw.id} interaction ${interactionIndex + 1} expect must be an object`));
            invalidInteraction = true;
            continue;
          }
          const expectation = item.expect;
          if (
            (expectation.attribute !== undefined && typeof expectation.attribute !== "string") ||
            (expectation.value !== undefined && typeof expectation.value !== "string") ||
            (expectation.text !== undefined && typeof expectation.text !== "string") ||
            (expectation.clickCount !== undefined &&
              (!Number.isInteger(expectation.clickCount) || (expectation.clickCount as number) < 0)) ||
            (expectation.attribute === undefined &&
              expectation.text === undefined &&
              expectation.clickCount === undefined)
          ) {
            failures.push(
              manifestError(
                `case ${raw.id} interaction ${interactionIndex + 1} expect needs attribute or text strings`,
              ),
            );
            invalidInteraction = true;
            continue;
          }
        }
        if (item.viewports !== undefined) {
          if (!Array.isArray(item.viewports) || item.viewports.length === 0) {
            failures.push(
              manifestError(`case ${raw.id} interaction ${interactionIndex + 1} viewports must be a non-empty array`),
            );
            invalidInteraction = true;
            continue;
          }
          const scopedViewports = new Set<string>();
          let invalidViewport = false;
          for (const viewportId of item.viewports) {
            if (!validId(viewportId) || !viewportIds.has(viewportId)) {
              failures.push(
                manifestError(
                  `case ${raw.id} interaction ${interactionIndex + 1} references unknown viewport ${JSON.stringify(viewportId)}`,
                ),
              );
              invalidViewport = true;
            } else if (scopedViewports.has(viewportId)) {
              failures.push(
                manifestError(
                  `case ${raw.id} interaction ${interactionIndex + 1} repeats viewport ${JSON.stringify(viewportId)}`,
                ),
              );
              invalidViewport = true;
            } else {
              scopedViewports.add(viewportId);
            }
          }
          if (invalidViewport) {
            invalidInteraction = true;
            continue;
          }
        }
        interactions.push({
          type: item.type as ParityActionType,
          target: item.target,
          ...(typeof item.value === "string" ? { value: item.value } : {}),
          ...(Array.isArray(item.viewports) ? { viewports: item.viewports as string[] } : {}),
          ...(isRecord(item.expect) ? { expect: item.expect as ParityInteraction["expect"] } : {}),
          ...(typeof item.expectText === "string" ? { expectText: item.expectText } : {}),
        });
      }
      if (invalidInteraction) continue;
      cases.push({
        id: raw.id,
        component: raw.component as ParityComponent,
        ...(isRecord(raw.props) ? { props: raw.props } : {}),
        ...(typeof raw.content === "string" ? { content: raw.content } : {}),
        ...(interactions.length > 0 ? { interactions } : {}),
      });
    }
  }

  if (failures.length > 0) return { ok: false, failures };
  return {
    ok: true,
    manifest: {
      schemaVersion: 1,
      kumoVersion: value.kumoVersion as string,
      viewports,
      cases,
    },
  };
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function diffSnapshots(
  reference: ParityDomSnapshot,
  candidate: ParityDomSnapshot,
): {
  semanticDiffs: string[];
  styleDiffs: string[];
  layoutDiffs: string[];
} {
  const semanticDiffs: string[] = [];
  const styleDiffs: string[] = [];
  const layoutDiffs: string[] = [];
  if (reference.aria !== candidate.aria) semanticDiffs.push("accessible tree differs");
  if (reference.invalidReferences.length > 0 || candidate.invalidReferences.length > 0) {
    semanticDiffs.push("DOM contains duplicate IDs or unresolved ID references");
  }
  if (reference.activePath !== candidate.activePath) semanticDiffs.push("focused element differs");
  if (reference.hoverPath !== candidate.hoverPath) semanticDiffs.push("hovered element differs");
  if (stableJson(reference.targets) !== stableJson(candidate.targets)) {
    semanticDiffs.push("interaction targets map to different DOM elements");
  }
  if (reference.nodes.length !== candidate.nodes.length) {
    semanticDiffs.push(`DOM node count differs (${reference.nodes.length} vs ${candidate.nodes.length})`);
  }
  const count = Math.min(reference.nodes.length, candidate.nodes.length);
  for (let index = 0; index < count; index++) {
    const a = reference.nodes[index]!;
    const b = candidate.nodes[index]!;
    const path = a.path === b.path ? a.path : `${a.path} ↔ ${b.path}`;
    if (a.path !== b.path || a.tag !== b.tag || a.role !== b.role || a.name !== b.name || a.text !== b.text) {
      semanticDiffs.push(`${path}: element/role/name/text differs`);
    }
    if (stableJson(a.attributes) !== stableJson(b.attributes))
      semanticDiffs.push(`${path}: semantic attributes differ`);
    if (stableJson(a.states) !== stableJson(b.states)) semanticDiffs.push(`${path}: native/ARIA state differs`);
    if (stableJson(a.styles) !== stableJson(b.styles)) {
      const props = [...new Set([...Object.keys(a.styles), ...Object.keys(b.styles)])]
        .filter((property) => (a.styles[property] ?? "") !== (b.styles[property] ?? ""))
        .slice(0, 8);
      styleDiffs.push(`${path}: ${props.join(", ") || "computed declarations"} differ`);
    }
    if (stableJson(a.rect) !== stableJson(b.rect)) layoutDiffs.push(`${path}: relative geometry differs`);
  }
  if (reference.root.width !== candidate.root.width || reference.root.height !== candidate.root.height) {
    layoutDiffs.unshift(
      `root size differs (${reference.root.width}x${reference.root.height} vs ${candidate.root.width}x${candidate.root.height})`,
    );
  }
  return { semanticDiffs, styleDiffs, layoutDiffs };
}

function comparePng(
  referenceBytes: Buffer,
  candidateBytes: Buffer,
): {
  differentPixels: number;
  totalPixels: number;
  ratio: number;
  width: number;
  height: number;
  dimensionsMatch: boolean;
  diffBytes: Buffer;
} {
  const reference = PNG.sync.read(Buffer.from(referenceBytes));
  const candidate = PNG.sync.read(Buffer.from(candidateBytes));
  const width = Math.max(reference.width, candidate.width);
  const height = Math.max(reference.height, candidate.height);
  const pad = (image: PNG) => {
    const output = new Uint8Array(width * height * 4);
    for (let y = 0; y < image.height; y++) {
      output.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), y * width * 4);
    }
    return output;
  };
  const referencePixels = pad(reference);
  const candidatePixels = pad(candidate);
  const diff = new PNG({ width, height });
  // pixelmatch's output is useful for a human-readable diff, but its pixel
  // count composites alpha and can treat different RGBA tuples as equivalent.
  // The gate verdict uses exact decoded-channel equality, including alpha and
  // RGB values under transparent pixels.
  pixelmatch(referencePixels, candidatePixels, diff.data, width, height, {
    threshold: 0,
    includeAA: true,
  });
  let differentPixels = 0;
  for (let offset = 0; offset < referencePixels.length; offset += 4) {
    if (
      referencePixels[offset] !== candidatePixels[offset] ||
      referencePixels[offset + 1] !== candidatePixels[offset + 1] ||
      referencePixels[offset + 2] !== candidatePixels[offset + 2] ||
      referencePixels[offset + 3] !== candidatePixels[offset + 3]
    ) {
      differentPixels++;
    }
  }
  const totalPixels = width * height;
  return {
    differentPixels,
    totalPixels,
    ratio: totalPixels === 0 ? 1 : differentPixels / totalPixels,
    width,
    height,
    dimensionsMatch: reference.width === candidate.width && reference.height === candidate.height,
    diffBytes: PNG.sync.write(diff),
  };
}

export function compareRendererParityData(input: {
  reference: { png: Buffer; dom: ParityDomSnapshot; action?: ParityActionCapture };
  candidate: { png: Buffer; dom: ParityDomSnapshot; action?: ParityActionCapture };
}): Omit<
  ParityComparison,
  "caseId" | "component" | "viewport" | "state" | "referencePath" | "candidatePath" | "diffPath"
> & {
  diffBytes: Buffer;
} {
  const pixel = comparePng(input.reference.png, input.candidate.png);
  const dom = diffSnapshots(input.reference.dom, input.candidate.dom);
  const behaviorDiffs: string[] = [];
  if (stableJson(input.reference.action?.events ?? []) !== stableJson(input.candidate.action?.events ?? [])) {
    behaviorDiffs.push("interaction event sequence differs");
  }
  const ok =
    pixel.differentPixels === 0 &&
    pixel.dimensionsMatch &&
    dom.semanticDiffs.length === 0 &&
    dom.styleDiffs.length === 0 &&
    dom.layoutDiffs.length === 0 &&
    behaviorDiffs.length === 0;
  const { diffBytes, ...pixelSummary } = pixel;
  return { ok, pixel: pixelSummary, ...dom, behaviorDiffs, diffBytes };
}

function paritySelector(caseId: string, source: ParitySource): string {
  // Case ids are restricted to a conservative token alphabet by manifest validation.
  return `${ROOT_SELECTOR}[data-case-id="${caseId}"][data-source="${source}"]`;
}

function actionSelector(target: string): string {
  // Interaction targets use the same filesystem-safe alphabet as case ids.
  return `[data-parity-target="${target}"]`;
}

async function waitForStableRender(page: import("playwright").Page): Promise<void> {
  await settlePage(page, 0, 0);
  await page.evaluate(
    () => new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))),
  );
  // State changes can start CSS transitions. Comparing during an in-flight
  // transition makes otherwise identical implementations depend on scheduler
  // timing, so wait for finite animations to settle with a hard timeout.
  await page.waitForFunction(
    () =>
      document.documentElement.getAnimations({ subtree: true }).every((animation) => {
        const timing = animation.effect?.getTiming();
        return animation.playState === "finished" || animation.playState === "idle" || timing?.iterations === Infinity;
      }),
    undefined,
    { timeout: 10_000 },
  );
  await page.evaluate(async () => {
    await new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())));
  });
}

async function installCaretCaptureNormalization(page: import("playwright").Page): Promise<void> {
  // Blinking-caret rasterization can invalidate otherwise identical focus-ring
  // pixels. Apply one stable paint-only rule before mounting either renderer;
  // the unmodified page separately supplies the actual computed caret-color.
  await page.addStyleTag({
    content: 'input, textarea, [contenteditable="true"] { caret-color: transparent !important; }',
  });
  await page.evaluate(
    () => new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))),
  );
}

async function mountParitySource(
  page: import("playwright").Page,
  caseId: string,
  source: ParitySource,
): Promise<string | undefined> {
  try {
    // Focus and pointer state belong to the browser page, not to a mounted
    // renderer. Reset them before each independent source so a prior hover or
    // focus interaction cannot leak into the other renderer's initial state.
    await page.mouse.move(0, 0);
    const result = await page.evaluate(
      async ({ caseId, source }) => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        const api = globalThis as typeof globalThis & {
          mountParity?: (input: { caseId: string; source: ParitySource }) => Promise<void>;
          unmountParity?: () => Promise<void>;
        };
        if (typeof api.mountParity !== "function" || typeof api.unmountParity !== "function") {
          return "gallery must implement window.mountParity({caseId,source}) and window.unmountParity()";
        }
        try {
          await api.unmountParity();
          await api.mountParity({ caseId, source });
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      { caseId, source },
    );
    if (result) return result;
    await waitForStableRender(page);
    const selector = paritySelector(caseId, source);
    const roots = page.locator(ROOT_SELECTOR);
    const count = await roots.count();
    if (count !== 1) return `gallery mounted ${count} parity roots; exactly one is required`;
    const root = page.locator(selector);
    if ((await root.count()) !== 1)
      return `mounted root must carry data-case-id="${caseId}" and data-source="${source}"`;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message.split("\n")[0]! : String(error);
  }
}

async function installEventRecorder(root: import("playwright").Locator): Promise<void> {
  await root.evaluate((element, eventTypes) => {
    const win = globalThis as typeof globalThis & {
      __vlmkitParityEvents?: Array<{ type: string; target: string }>;
      __vlmkitParityRecorder?: { listeners: Array<{ type: string; listener: EventListener }> };
    };
    for (const { type, listener } of win.__vlmkitParityRecorder?.listeners ?? []) {
      document.removeEventListener(type, listener, true);
    }
    win.__vlmkitParityEvents = [];
    const listeners: Array<{ type: string; listener: EventListener }> = [];
    const pathOf = (target: Element): string => {
      const marker = target.closest("[data-parity-target]")?.getAttribute("data-parity-target");
      if (marker && element.contains(target)) return marker;
      const parts: string[] = [];
      let cursor: Element | null = target;
      while (cursor && cursor !== document.documentElement) {
        const parent: Element | null = cursor.parentElement;
        if (!parent) break;
        const index = Array.from(parent.children).indexOf(cursor) + 1;
        parts.unshift(`${cursor.tagName.toLowerCase()}:nth-child(${index})`);
        cursor = parent;
      }
      return `document/${parts.join("/")}`;
    };
    for (const type of eventTypes) {
      const listener: EventListener = (event) => {
        const eventTarget = event.target instanceof Element ? event.target : document.documentElement;
        win.__vlmkitParityEvents!.push({ type, target: pathOf(eventTarget) });
      };
      document.addEventListener(type, listener, true);
      listeners.push({ type, listener });
    }
    win.__vlmkitParityRecorder = { listeners };
  }, EVENT_TYPES);
}

async function captureDomSnapshot(
  root: import("playwright").Locator,
  action: ParityActionCapture = { events: [] },
): Promise<{ dom: ParityDomSnapshot; action: ParityActionCapture }> {
  const dom = await root.evaluate((rootElement) => {
    const root = rootElement as HTMLElement;
    const normalize = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
    const excludedAttributes = new Set(["class", "style", "id", "data-case-id", "data-source", "data-parity-root"]);
    const singleIdReferences = new Set([
      "aria-activedescendant",
      "aria-details",
      "aria-errormessage",
      "form",
      "for",
      "list",
      "popovertarget",
    ]);
    const multipleIdReferences = new Set([
      "aria-controls",
      "aria-describedby",
      "aria-flowto",
      "aria-labelledby",
      "aria-owns",
      "headers",
    ]);
    const rectOf = (element: Element, origin: DOMRect): ParityRect => {
      const rect = element.getBoundingClientRect();
      return {
        x: round(rect.left - origin.left),
        y: round(rect.top - origin.top),
        width: round(rect.width),
        height: round(rect.height),
      };
    };
    const round = (value: number) => Math.round(value * 1000) / 1000;
    const pathOf = (element: Element, root: Element) => {
      if (element === root) return "root";
      const parts: string[] = [];
      let cursor: Element | null = element;
      while (cursor && cursor !== root) {
        const parent: Element | null = cursor.parentElement;
        if (!parent) break;
        const index = Array.from(parent.children).indexOf(cursor) + 1;
        parts.unshift(`${cursor.tagName.toLowerCase()}:nth-child(${index})`);
        cursor = parent;
      }
      return `root/${parts.join("/")}`;
    };
    const roleOf = (element: Element): string => {
      const explicit = element.getAttribute("role");
      if (explicit) return explicit.split(/\s+/)[0] ?? "";
      const tag = element.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a" && element.hasAttribute("href")) return "link";
      if (tag === "textarea") return "textbox";
      if (tag === "select") return element.hasAttribute("multiple") ? "listbox" : "combobox";
      if (tag === "input") {
        const type = (element.getAttribute("type") ?? "text").toLowerCase();
        if (["button", "submit", "reset", "image"].includes(type)) return "button";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "range") return "slider";
        if (type === "search") return "searchbox";
        if (type === "hidden") return "";
        return "textbox";
      }
      if (/^h[1-6]$/.test(tag)) return "heading";
      if (tag === "img") return "img";
      if (tag === "main") return "main";
      if (tag === "nav") return "navigation";
      if (tag === "aside") return "complementary";
      if (tag === "article") return "article";
      if (tag === "form") return "form";
      if (tag === "ul" || tag === "ol") return "list";
      if (tag === "li") return "listitem";
      return "generic";
    };
    const nameOf = (element: Element): string => {
      const ariaLabel = element.getAttribute("aria-label");
      if (ariaLabel) return normalize(ariaLabel);
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        const labels = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .filter(Boolean);
        if (labels.length > 0) return normalize(labels.join(" "));
      }
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      ) {
        const labels = element.labels ? Array.from(element.labels).map((label) => label.textContent ?? "") : [];
        if (labels.length > 0) return normalize(labels.join(" "));
      }
      if (element.tagName.toLowerCase() === "img") return normalize(element.getAttribute("alt"));
      const title = element.getAttribute("title");
      if (title) return normalize(title);
      if (element instanceof HTMLInputElement && ["button", "submit", "reset", "image"].includes(element.type)) {
        return normalize(element.value);
      }
      if (["button", "a", "summary"].includes(element.tagName.toLowerCase())) return normalize(element.textContent);
      return "";
    };
    const allElements = [root, ...Array.from(root.querySelectorAll("*"))];
    const idElements = new Map<string, Element>();
    const invalidReferences: string[] = [];
    const targets: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const element of allElements) {
      const id = element.getAttribute("id");
      if (id === null) continue;
      if (idElements.has(id)) invalidReferences.push(`duplicate id "${id}"`);
      else idElements.set(id, element);
    }
    const canonicalIdReferences = (name: string, value: string): string => {
      const multiple = multipleIdReferences.has(name);
      if (!multiple && !singleIdReferences.has(name)) return value;
      const ids = multiple ? value.trim().split(/\s+/).filter(Boolean) : [value];
      if (ids.length === 0) invalidReferences.push(`${name} has an empty ID reference`);
      const paths = ids.map((id) => {
        const target = idElements.get(id);
        if (!target) {
          invalidReferences.push(`${name} references missing id "${id}"`);
          return `missing:${id}`;
        }
        return pathOf(target, root);
      });
      return paths.join(" ");
    };
    for (const element of allElements) {
      const target = element.getAttribute("data-parity-target");
      if (!target) continue;
      if (Object.prototype.hasOwnProperty.call(targets, target))
        invalidReferences.push(`duplicate parity target "${target}"`);
      else targets[target] = pathOf(element, root);
    }
    const origin = root.getBoundingClientRect();
    const nodes: ParityNodeSnapshot[] = allElements.map((element) => {
      const attributes: Record<string, string> = {};
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        if (excludedAttributes.has(name) || name.startsWith("data-parity-") || name.startsWith("data-vlmkit-"))
          continue;
        attributes[name] = canonicalIdReferences(name, attribute.value);
      }
      const states: Record<string, boolean | string> = {};
      const asInput = element as HTMLInputElement;
      if ("disabled" in element) states.disabled = Boolean(asInput.disabled);
      if ("required" in element) states.required = Boolean((element as HTMLInputElement).required);
      if ("readOnly" in element) states.readOnly = Boolean((element as HTMLInputElement).readOnly);
      if ("checked" in element) states.checked = Boolean((element as HTMLInputElement).checked);
      if ("selected" in element) states.selected = Boolean((element as HTMLOptionElement).selected);
      if ("value" in element) states.value = String((element as HTMLInputElement).value);
      for (const name of [
        "aria-disabled",
        "aria-expanded",
        "aria-invalid",
        "aria-pressed",
        "aria-checked",
        "aria-selected",
        "aria-current",
      ]) {
        const value = element.getAttribute(name);
        if (value !== null) states[name] = value;
      }
      const style = getComputedStyle(element);
      const styles: Record<string, string> = {};
      for (let index = 0; index < style.length; index++) {
        const property = style.item(index);
        if (property) styles[property] = style.getPropertyValue(property).trim();
      }
      return {
        path: pathOf(element, root),
        tag: element.tagName.toLowerCase(),
        role: roleOf(element),
        name: nameOf(element),
        text: normalize(element.textContent),
        attributes: Object.fromEntries(Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b))),
        states: Object.fromEntries(Object.entries(states).sort(([a], [b]) => a.localeCompare(b))),
        rect: rectOf(element, origin),
        styles: Object.fromEntries(Object.entries(styles).sort(([a], [b]) => a.localeCompare(b))),
      };
    });
    const pathFor = (element: Element | null) => (element && root.contains(element) ? pathOf(element, root) : null);
    return {
      root: { width: round(origin.width), height: round(origin.height) },
      activePath: pathFor(document.activeElement),
      hoverPath: pathFor(root.querySelector(":hover")),
      invalidReferences: [...new Set(invalidReferences)],
      targets,
      nodes,
    };
  });
  const aria = await root.ariaSnapshot();
  return { dom: { ...dom, aria }, action };
}

async function captureActionEvents(
  root: import("playwright").Locator,
  relevantEventTypes: readonly string[],
): Promise<ParityActionCapture> {
  const events = await root.evaluate(() => {
    const win = globalThis as typeof globalThis & { __vlmkitParityEvents?: Array<{ type: string; target: string }> };
    return win.__vlmkitParityEvents ?? [];
  });
  return { events: events.filter((event) => relevantEventTypes.includes(event.type)) };
}

async function alignCapturePageScroll(
  visualPage: import("playwright").Page,
  stylePage: import("playwright").Page,
): Promise<string | undefined> {
  const position = await visualPage.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  await stylePage.evaluate(({ x, y }) => {
    window.scrollTo({ left: x, top: y, behavior: "instant" as ScrollBehavior });
  }, position);
  await stylePage.evaluate(
    () => new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))),
  );
  const aligned = await stylePage.evaluate(({ x, y }) => window.scrollX === x && window.scrollY === y, position);
  return aligned
    ? undefined
    : `could not align author-style page scroll position to visual capture (${position.x}, ${position.y})`;
}

async function captureCaretColors(root: import("playwright").Locator): Promise<Record<string, string>> {
  return await root.evaluate((rootElement) => {
    const pathOf = (element: Element, root: Element): string => {
      if (element === root) return "root";
      const parts: string[] = [];
      let cursor: Element | null = element;
      while (cursor && cursor !== root) {
        const parent: Element | null = cursor.parentElement;
        if (!parent) break;
        const index = Array.from(parent.children).indexOf(cursor) + 1;
        parts.unshift(`${cursor.tagName.toLowerCase()}:nth-child(${index})`);
        cursor = parent;
      }
      return `root/${parts.join("/")}`;
    };
    const elements = [rootElement, ...Array.from(rootElement.querySelectorAll("*"))];
    return Object.fromEntries(
      elements.map((element) => [pathOf(element, rootElement), getComputedStyle(element).caretColor]),
    );
  });
}

function restoreMeasuredCaretColors(dom: ParityDomSnapshot, caretColors: Record<string, string>): string | undefined {
  for (const node of dom.nodes) {
    const caretColor = caretColors[node.path];
    if (caretColor === undefined) return `unmodified renderer did not provide caret-color for ${node.path}`;
    node.styles["caret-color"] = caretColor;
  }
  return undefined;
}

async function assertCapturePlaneAgreement(input: {
  png: Buffer;
  dom: ParityDomSnapshot;
  action: ParityActionCapture;
  styleRoot: import("playwright").Locator;
  eventTypes: readonly string[];
}): Promise<string | undefined> {
  const action = await captureActionEvents(input.styleRoot, input.eventTypes);
  const { dom } = await captureDomSnapshot(input.styleRoot, action);
  if (dom.nodes.length === 0 || dom.aria.trim() === "") {
    return "unmodified style page has no DOM or accessible-tree content";
  }
  if (dom.invalidReferences.length > 0) {
    return `unmodified style page contains invalid ID references: ${dom.invalidReferences.join("; ")}`;
  }
  const agreement = compareRendererParityData({
    reference: { png: input.png, dom: input.dom, action: input.action },
    candidate: { png: input.png, dom, action },
  });
  if (!agreement.ok) {
    return (
      "pixel and author-style capture pages diverged: " +
      `${agreement.semanticDiffs.length} semantic, ${agreement.styleDiffs.length} style, ` +
      `${agreement.layoutDiffs.length} layout, ${agreement.behaviorDiffs.length} behavior delta(s); ` +
      `examples: ${JSON.stringify({
        semantic: agreement.semanticDiffs.slice(0, 3),
        style: agreement.styleDiffs.slice(0, 3),
        layout: agreement.layoutDiffs.slice(0, 8),
        behavior: agreement.behaviorDiffs.slice(0, 3),
        referenceEvents: input.action.events.slice(0, 20),
        authorStyleEvents: action.events.slice(0, 20),
      })}`
    );
  }
  return undefined;
}

async function screenshotParityRoot(
  page: import("playwright").Page,
  root: import("playwright").Locator,
  path: string,
): Promise<Buffer> {
  // Interactions are also replayed on the author-style page, which brings that
  // page to the front last. Capture the visual page in the foreground so native
  // focus painting does not depend on whether its tab is backgrounded. Finite
  // animations already settled before this point; do not let screenshot capture
  // mutate their state as Playwright's `disabled` mode does.
  await page.bringToFront();
  await waitForStableRender(page);
  // The visual-only page has a persistent caret-color rule; leaving Playwright's
  // capture stylesheet untouched avoids per-shot paint changes.
  return await root.screenshot({ path, scale: "css", animations: "allow", caret: "initial" });
}

async function applyInteraction(
  page: import("playwright").Page,
  root: import("playwright").Locator,
  interaction: ParityInteraction,
): Promise<string | undefined> {
  const target = root.locator(actionSelector(interaction.target));
  const count = await target.count();
  if (count !== 1)
    return `interaction target "${interaction.target}" matched ${count} elements; exactly one is required`;
  // Each capture plane is an isolated browser page. Activate the page before
  // keyboard input so native Tab traversal has the same focused-window
  // behavior on both pages, including when focus leaves the mounted root.
  await page.bringToFront();
  // Start every real action from the same pointer location. This prevents a
  // prior screenshot's pointer placement from changing the next action trace.
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    const win = globalThis as typeof globalThis & { __vlmkitParityEvents?: Array<{ type: string; target: string }> };
    win.__vlmkitParityEvents = [];
  });
  if (interaction.type === "focus") {
    const disabled = await target.evaluate(
      (element) => element.matches(":disabled") || element.getAttribute("aria-disabled") === "true",
    );
    await target.focus();
    const focused = await target.evaluate((element) => document.activeElement === element);
    if (!focused && !disabled) return `focus action did not focus target "${interaction.target}"`;
    const events = await root.evaluate(() => {
      const win = globalThis as typeof globalThis & { __vlmkitParityEvents?: Array<{ type: string; target: string }> };
      return win.__vlmkitParityEvents ?? [];
    });
    if (!disabled && !events.some((event) => event.type === "focusin" && event.target === interaction.target)) {
      return `focus action emitted no focusin event for "${interaction.target}"`;
    }
  } else if (interaction.type === "blur") {
    const focused = await target.evaluate((element) => document.activeElement === element);
    if (!focused) return `blur action requires target "${interaction.target}" to be focused first`;
    await target.evaluate((element) => (element as HTMLElement).blur());
    const remainsFocused = await target.evaluate((element) => document.activeElement === element);
    if (remainsFocused) return `blur action did not blur target "${interaction.target}"`;
    const events = await root.evaluate(() => {
      const win = globalThis as typeof globalThis & { __vlmkitParityEvents?: Array<{ type: string; target: string }> };
      return win.__vlmkitParityEvents ?? [];
    });
    if (!events.some((event) => event.type === "focusout" && event.target === interaction.target)) {
      return `blur action emitted no focusout event for "${interaction.target}"`;
    }
  } else if (interaction.type === "hover") {
    await target.hover();
    const hovered = await target.evaluate((element) => element.matches(":hover"));
    if (!hovered) return `hover action did not hover target "${interaction.target}"`;
    const events = await root.evaluate(() => {
      const win = globalThis as typeof globalThis & { __vlmkitParityEvents?: Array<{ type: string; target: string }> };
      return win.__vlmkitParityEvents ?? [];
    });
    if (!events.some((event) => event.type === "pointerover" && event.target === interaction.target)) {
      return `hover action emitted no pointerover event for "${interaction.target}"`;
    }
  } else if (interaction.type === "click") {
    const disabled = await target.evaluate(
      (element) => element.matches(":disabled") || element.getAttribute("aria-disabled") === "true",
    );
    if (disabled) {
      const box = await target.boundingBox();
      if (!box) return `disabled click target "${interaction.target}" has no visible box`;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    } else {
      await target.click();
    }
    const events = await root.evaluate(() => {
      const win = globalThis as typeof globalThis & { __vlmkitParityEvents?: Array<{ type: string; target: string }> };
      return win.__vlmkitParityEvents ?? [];
    });
    if (disabled && events.some((event) => event.type === "click")) {
      return `disabled click target "${interaction.target}" emitted a click event`;
    }
    if (!disabled && !events.some((event) => event.type === "click")) {
      return `click action emitted no click event for "${interaction.target}"`;
    }
    const clickCount = events.filter((event) => event.type === "click" && event.target === interaction.target).length;
    if (!disabled && clickCount !== 1) {
      return `click action emitted ${clickCount} click events for "${interaction.target}"; exactly one is required`;
    }
  } else {
    if (interaction.type === "fill") {
      const before = await target.inputValue();
      const blocked = await target.evaluate(
        (element) =>
          element.matches(":disabled") || ("readOnly" in element && Boolean((element as HTMLInputElement).readOnly)),
      );
      if (blocked) {
        // Attempt the same kind of user text entry on the page. `locator.fill`
        // waits for a disabled control to become editable until its timeout;
        // native keyboard input is immediate and proves the control rejects it.
        await target.focus();
        await page.keyboard.insertText(interaction.value ?? "");
        if ((await target.inputValue()) !== before)
          return `disabled or readonly input "${interaction.target}" changed value`;
      } else {
        await target.fill(interaction.value ?? "");
        const value = await target.inputValue();
        if (value !== interaction.value) return `fill action value did not stick on target "${interaction.target}"`;
      }
      const events = await root.evaluate(() => {
        const win = globalThis as typeof globalThis & {
          __vlmkitParityEvents?: Array<{ type: string; target: string }>;
        };
        return win.__vlmkitParityEvents ?? [];
      });
      if (blocked && events.some((event) => event.type === "input")) {
        return `disabled or readonly input "${interaction.target}" emitted an input event`;
      }
      if (!blocked && !events.some((event) => event.type === "input")) {
        return `fill action emitted no input event for "${interaction.target}"`;
      }
    } else {
      const disabled = await target.evaluate(
        (element) => element.matches(":disabled") || element.getAttribute("aria-disabled") === "true",
      );
      await target.focus();
      if (disabled) {
        // Native disabled controls cannot receive focus. Dispatch the real
        // keyboard action at the page after attempting focus, then assert the
        // disabled target did not emit an activation click.
        await page.keyboard.press(interaction.value!);
      } else {
        await target.press(interaction.value!);
      }
      const events = await root.evaluate(() => {
        const win = globalThis as typeof globalThis & {
          __vlmkitParityEvents?: Array<{ type: string; target: string }>;
        };
        return win.__vlmkitParityEvents ?? [];
      });
      if (!disabled && !events.some((event) => event.type === "keydown" && event.target === interaction.target))
        return `press action emitted no keydown event for "${interaction.target}"`;
      if (!disabled && !events.some((event) => event.type === "keyup"))
        return `press action emitted no keyup event in the document for "${interaction.target}"`;
      const clickCount = events.filter((event) => event.type === "click" && event.target === interaction.target).length;
      if (disabled && clickCount !== 0) {
        return `disabled press target "${interaction.target}" emitted ${clickCount} click event(s)`;
      }
      const isButton = await target.evaluate((element) => element.matches("button,[role=button]"));
      if (!disabled && isButton && ["Enter", "Space"].includes(interaction.value!) && clickCount !== 1) {
        return `press action emitted ${clickCount} click events for button target "${interaction.target}"; exactly one is required`;
      }
    }
  }
  // Let framework state updates and finite CSS transitions settle before
  // checking resulting attributes/text; otherwise async React state can be
  // observed one action later than the action that produced it.
  await waitForStableRender(page);
  if (interaction.expectText !== undefined) {
    const actualText = await target.evaluate(
      (element) => (element as HTMLElement).innerText?.replace(/\s+/g, " ").trim() ?? "",
    );
    if (actualText !== interaction.expectText) {
      return `expected target text ${JSON.stringify(interaction.expectText)}, got ${JSON.stringify(actualText)}`;
    }
  }
  if (interaction.expect?.text !== undefined) {
    const actualText = await target.evaluate(
      (element) => (element as HTMLElement).innerText?.replace(/\s+/g, " ").trim() ?? "",
    );
    if (actualText !== interaction.expect.text) {
      return `expected target text ${JSON.stringify(interaction.expect.text)}, got ${JSON.stringify(actualText)}`;
    }
  }
  if (interaction.expect?.attribute !== undefined) {
    const actual = await target.getAttribute(interaction.expect.attribute);
    if (interaction.expect.value === undefined ? actual === null : actual !== interaction.expect.value) {
      return interaction.expect.value === undefined
        ? `expected ${interaction.expect.attribute} to be present, got ${JSON.stringify(actual)}`
        : `expected ${interaction.expect.attribute}=${JSON.stringify(interaction.expect.value)}, got ${JSON.stringify(actual)}`;
    }
  }
  if (interaction.expect?.clickCount !== undefined) {
    const events = await root.evaluate(() => {
      const win = globalThis as typeof globalThis & {
        __vlmkitParityEvents?: Array<{ type: string; target: string }>;
      };
      return win.__vlmkitParityEvents ?? [];
    });
    const actual = events.filter((event) => event.type === "click" && event.target === interaction.target).length;
    if (actual !== interaction.expect.clickCount) {
      return `expected ${interaction.expect.clickCount} click event(s) for "${interaction.target}", got ${actual}`;
    }
  }
  return undefined;
}

function hasVisiblePixels(pngBytes: Buffer): boolean {
  const png = PNG.sync.read(pngBytes);
  for (let offset = 3; offset < png.data.length; offset += 4) if (png.data[offset]! > 0) return true;
  return false;
}

async function captureSourceState(input: {
  page: import("playwright").Page;
  stylePage: import("playwright").Page;
  caseInfo: ParityCase;
  viewport: ParityViewport;
  source: ParitySource;
  state: string;
  outputDir: string;
}): Promise<{
  capture: RendererParityCapture;
  png?: Buffer;
  dom?: ParityDomSnapshot;
  root?: import("playwright").Locator;
  styleRoot?: import("playwright").Locator;
}> {
  const { page, stylePage, caseInfo, viewport, source, state, outputDir } = input;
  const capture: RendererParityCapture = {
    caseId: caseInfo.id,
    component: caseInfo.component,
    viewport: viewport.id,
    state,
    source,
  };
  const mountError = await mountParitySource(page, caseInfo.id, source);
  if (mountError) return { capture: { ...capture, error: mountError } };
  const styleMountError = await mountParitySource(stylePage, caseInfo.id, source);
  if (styleMountError) return { capture: { ...capture, error: `unmodified style capture: ${styleMountError}` } };
  const root = page.locator(paritySelector(caseInfo.id, source));
  const styleRoot = stylePage.locator(paritySelector(caseInfo.id, source));
  const [box, styleBox] = await Promise.all([root.boundingBox(), styleRoot.boundingBox()]);
  if (!box || box.width <= 0 || box.height <= 0 || !styleBox || styleBox.width <= 0 || styleBox.height <= 0) {
    return { capture: { ...capture, error: `mounted ${ROOT_SELECTOR} has an empty box` } };
  }
  await installEventRecorder(root);
  await installEventRecorder(styleRoot);
  await Promise.all([waitForStableRender(page), waitForStableRender(stylePage)]);
  const path = join(outputDir, slug(caseInfo.id), slug(viewport.id), slug(state));
  await mkdir(path, { recursive: true });
  const screenshotPath = join(path, `${source}.png`);
  const domPath = join(path, `${source}.dom.json`);
  try {
    const action = await captureActionEvents(root, []);
    const png = await screenshotParityRoot(page, root, screenshotPath);
    if (png.length === 0) return { capture: { ...capture, error: "Playwright returned an empty PNG capture" } };
    const image = PNG.sync.read(png);
    if (image.width <= 0 || image.height <= 0 || image.data.length === 0 || !hasVisiblePixels(png)) {
      return { capture: { ...capture, error: "capture has no visible pixels or dimensions" } };
    }
    const scrollError = await alignCapturePageScroll(page, stylePage);
    if (scrollError) return { capture: { ...capture, error: scrollError } };
    const caretColors = await captureCaretColors(styleRoot);
    const { dom } = await captureDomSnapshot(root, action);
    const caretError = restoreMeasuredCaretColors(dom, caretColors);
    if (caretError) return { capture: { ...capture, error: caretError } };
    const agreementError = await assertCapturePlaneAgreement({
      png,
      dom,
      action,
      styleRoot,
      eventTypes: [],
    });
    if (agreementError) return { capture: { ...capture, error: agreementError } };
    if (dom.nodes.length === 0 || dom.aria.trim() === "") {
      return { capture: { ...capture, error: "capture has no DOM or accessible-tree content" } };
    }
    await writeFile(domPath, JSON.stringify({ ...dom, action }, null, 2));
    if (dom.invalidReferences.length > 0) {
      return {
        capture: {
          ...capture,
          screenshotPath,
          domPath,
          dimensions: { width: image.width, height: image.height },
          nodeCount: dom.nodes.length,
          action,
          error: `DOM contains invalid ID references: ${dom.invalidReferences.join("; ")}`,
        },
        png,
        dom,
        root,
        styleRoot,
      };
    }
    return {
      capture: {
        ...capture,
        screenshotPath,
        domPath,
        dimensions: { width: image.width, height: image.height },
        nodeCount: dom.nodes.length,
        action,
      },
      png,
      dom,
      root,
      styleRoot,
    };
  } catch (error) {
    return {
      capture: {
        ...capture,
        error: error instanceof Error ? error.message.split("\n")[0]! : String(error),
      },
    };
  }
}

async function compareCapturePair(input: {
  reference: Awaited<ReturnType<typeof captureSourceState>>;
  candidate: Awaited<ReturnType<typeof captureSourceState>>;
  caseInfo: ParityCase;
  viewport: ParityViewport;
  state: string;
}): Promise<{ comparison?: ParityComparison; failure?: RendererParityFailure }> {
  const { reference, candidate, caseInfo, viewport, state } = input;
  if (
    reference.capture.error ||
    candidate.capture.error ||
    !reference.png ||
    !candidate.png ||
    !reference.dom ||
    !candidate.dom
  ) {
    return {
      failure: {
        rule: "capture-failed",
        caseId: caseInfo.id,
        viewport: viewport.id,
        state,
        message:
          `${caseInfo.id}/${viewport.id}/${state} could not capture both renderers` +
          ` (react: ${reference.capture.error ?? "ok"}; moonbit: ${candidate.capture.error ?? "ok"})`,
        evidence: { react: reference.capture, moonbit: candidate.capture },
      },
    };
  }
  try {
    const result = compareRendererParityData({
      reference: { png: reference.png, dom: reference.dom, action: reference.capture.action },
      candidate: { png: candidate.png, dom: candidate.dom, action: candidate.capture.action },
    });
    const diffPath = join(dirnamePath(reference.capture.screenshotPath!), "diff.png");
    if (result.pixel.differentPixels > 0 || !result.pixel.dimensionsMatch) await writeFile(diffPath, result.diffBytes);
    const { diffBytes: _diffBytes, ...comparisonFields } = result;
    const comparison: ParityComparison = {
      caseId: caseInfo.id,
      component: caseInfo.component,
      viewport: viewport.id,
      state,
      ...comparisonFields,
      referencePath: reference.capture.screenshotPath!,
      candidatePath: candidate.capture.screenshotPath!,
      ...(result.pixel.differentPixels > 0 || !result.pixel.dimensionsMatch ? { diffPath } : {}),
    };
    return { comparison };
  } catch (error) {
    return {
      failure: {
        rule: "capture-failed",
        caseId: caseInfo.id,
        viewport: viewport.id,
        state,
        message: `could not compare ${caseInfo.id}/${viewport.id}/${state}: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

function dirnamePath(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash >= 0 ? path.slice(0, slash) : ".";
}

export async function runRendererParity(options: RendererParityOptions): Promise<RendererParityReport> {
  const manifestPath = resolve(options.manifestPath);
  const outputDir = resolve(options.outputDir);
  const reportPath = join(outputDir, "report.json");
  const report: RendererParityReport = {
    ok: false,
    gallery: options.gallery,
    manifestPath,
    outputDir,
    reportPath,
    cases: 0,
    viewports: 0,
    captures: [],
    comparisons: [],
    failures: [],
  };
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    report.failures.push(
      manifestError(
        `could not read JSON manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  const validation = validateRendererParityManifest(rawManifest);
  if (!validation.ok) report.failures.push(...validation.failures);
  if (!validation.ok || report.failures.length > 0) {
    await mkdir(outputDir, { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    return report;
  }
  const manifest = validation.manifest;
  report.kumoVersion = manifest.kumoVersion;
  report.cases = manifest.cases.length;
  report.viewports = manifest.viewports.length;
  const operationTimeoutMs = options.timeout ?? DEFAULT_PAGE_LOAD_TIMEOUT_MS;
  let abortRemainingMatrix = false;

  try {
    await withBrowser(async (browser) => {
      for (const viewport of manifest.viewports) {
        if (abortRemainingMatrix) break;
        const pageOptions = {
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 1,
        };
        const page = await withParityDeadline({
          operation: `open ${viewport.id} pixel capture page`,
          timeoutMs: operationTimeoutMs,
          onTimeout: () => browser.close(),
          run: () => browser.newPage(pageOptions),
        });
        const stylePage = await withParityDeadline({
          operation: `open ${viewport.id} author-style capture page`,
          timeoutMs: operationTimeoutMs,
          pages: [page],
          onTimeout: () => browser.close(),
          run: () => browser.newPage(pageOptions),
        });
        const diagnostics = watchBrowserDiagnostics(page);
        const styleDiagnostics = watchBrowserDiagnostics(stylePage);
        try {
          await withParityDeadline({
            operation: `navigate both ${viewport.id} capture pages`,
            timeoutMs: operationTimeoutMs,
            pages: [page, stylePage],
            run: () =>
              Promise.all([
                navigatePage(page, options.gallery, options),
                navigatePage(stylePage, options.gallery, options),
              ]),
          });
          const waitForParityApi = (targetPage: import("playwright").Page) =>
            targetPage.waitForFunction(
              () => {
                const api = globalThis as typeof globalThis & {
                  mountParity?: unknown;
                  unmountParity?: unknown;
                  parityKumoVersion?: unknown;
                };
                return (
                  typeof api.mountParity === "function" &&
                  typeof api.unmountParity === "function" &&
                  typeof api.parityKumoVersion === "string"
                );
              },
              undefined,
              { timeout: 20_000 },
            );
          try {
            await withParityDeadline({
              operation: `wait for ${viewport.id} gallery API and package version`,
              timeoutMs: operationTimeoutMs,
              pages: [page, stylePage],
              run: () => Promise.all([waitForParityApi(page), waitForParityApi(stylePage)]),
            });
          } catch (error) {
            if (error instanceof ParityDeadlineError) abortRemainingMatrix = true;
            report.failures.push({
              rule: error instanceof ParityDeadlineError ? "capture-failed" : "coverage-incomplete",
              viewport: viewport.id,
              message:
                error instanceof ParityDeadlineError
                  ? error.message
                  : "timed out waiting for the gallery parity API and installed Kumo version to become ready",
              ...(error instanceof ParityDeadlineError
                ? { evidence: { operation: error.operation, timeoutMs: error.timeoutMs } }
                : {}),
            });
            continue;
          }
          const [referenceVersion, styleVersion] = await withParityDeadline({
            operation: `read ${viewport.id} gallery Kumo version`,
            timeoutMs: operationTimeoutMs,
            pages: [page, stylePage],
            run: () =>
              Promise.all([
                page.evaluate(() => {
                  const api = globalThis as typeof globalThis & { parityKumoVersion?: unknown };
                  return api.parityKumoVersion;
                }),
                stylePage.evaluate(() => {
                  const api = globalThis as typeof globalThis & { parityKumoVersion?: unknown };
                  return api.parityKumoVersion;
                }),
              ]),
          });
          if (typeof referenceVersion !== "string" || styleVersion !== referenceVersion) {
            report.failures.push({
              rule: "coverage-incomplete",
              viewport: viewport.id,
              message:
                "both gallery pages must expose the same window.parityKumoVersion from installed Cloudflare Kumo",
            });
            continue;
          }
          if (referenceVersion !== manifest.kumoVersion) {
            report.failures.push({
              rule: "coverage-incomplete",
              viewport: viewport.id,
              message: `gallery Kumo version ${referenceVersion} does not match manifest version ${manifest.kumoVersion}`,
              evidence: { galleryVersion: referenceVersion, manifestVersion: manifest.kumoVersion },
            });
            continue;
          }
          await withParityDeadline({
            operation: `initialize ${viewport.id} capture pages`,
            timeoutMs: operationTimeoutMs,
            pages: [page, stylePage],
            run: async () => {
              await Promise.all([
                page.evaluate(() => {
                  (
                    globalThis as typeof globalThis & { __vlmkitParityCapturePlane?: string }
                  ).__vlmkitParityCapturePlane = "pixels";
                }),
                stylePage.evaluate(() => {
                  (
                    globalThis as typeof globalThis & { __vlmkitParityCapturePlane?: string }
                  ).__vlmkitParityCapturePlane = "author-styles";
                }),
              ]);
              await installCaretCaptureNormalization(page);
            },
          });
          for (const caseInfo of manifest.cases) {
            const applicableInteractions = (caseInfo.interactions ?? []).filter(
              (interaction) => interaction.viewports === undefined || interaction.viewports.includes(viewport.id),
            );
            const states = [
              "initial",
              ...applicableInteractions.map(
                (interaction, index) =>
                  `step-${String(index + 1).padStart(2, "0")}-${interaction.type}-${interaction.target}`,
              ),
            ];
            const sourceCaptures = new Map<ParitySource, Array<Awaited<ReturnType<typeof captureSourceState>>>>();
            for (const source of SOURCES) {
              const captures: Array<Awaited<ReturnType<typeof captureSourceState>>> = [];
              const initial = await withParityDeadline({
                operation: `mount/settle/capture ${caseInfo.id}/${viewport.id}/initial/${source}`,
                timeoutMs: operationTimeoutMs,
                pages: [page, stylePage],
                run: () =>
                  captureSourceState({
                    page,
                    stylePage,
                    caseInfo,
                    viewport,
                    source,
                    state: "initial",
                    outputDir,
                  }),
              });
              captures.push(initial);
              report.captures.push(initial.capture);
              for (const [index, interaction] of applicableInteractions.entries()) {
                const actionError = await withParityDeadline({
                  operation: `apply ${caseInfo.id}/${viewport.id}/${states[index + 1]}/${source}`,
                  timeoutMs: operationTimeoutMs,
                  pages: [page, stylePage],
                  run: async () => {
                    let error =
                      initial.root && initial.styleRoot
                        ? await applyInteraction(page, initial.root, interaction)
                        : (initial.capture.error ?? "initial component capture failed");
                    if (!error && initial.styleRoot) {
                      error = await applyInteraction(stylePage, initial.styleRoot, interaction);
                    }
                    return error;
                  },
                });
                if (actionError) {
                  const failedCapture: RendererParityCapture = {
                    caseId: caseInfo.id,
                    component: caseInfo.component,
                    viewport: viewport.id,
                    state: states[index + 1]!,
                    source,
                    error: actionError,
                  };
                  const failed = { capture: failedCapture };
                  captures.push(failed);
                  report.captures.push(failedCapture);
                  report.failures.push({
                    rule: "interaction-failed",
                    caseId: caseInfo.id,
                    viewport: viewport.id,
                    state: states[index + 1]!,
                    source,
                    message: `${caseInfo.id}/${viewport.id}/${states[index + 1]} ${source}: ${actionError}`,
                  });
                  continue;
                }
                const stateCapture = await withParityDeadline({
                  operation: `capture ${caseInfo.id}/${viewport.id}/${states[index + 1]}/${source}`,
                  timeoutMs: operationTimeoutMs,
                  pages: [page, stylePage],
                  run: () =>
                    captureMountedSourceState({
                      page,
                      stylePage,
                      root: initial.root!,
                      styleRoot: initial.styleRoot!,
                      caseInfo,
                      viewport,
                      source,
                      state: states[index + 1]!,
                      interactionType: interaction.type,
                      outputDir,
                    }),
                });
                captures.push(stateCapture);
                report.captures.push(stateCapture.capture);
              }
              sourceCaptures.set(source, captures);
            }

            const references = sourceCaptures.get("react") ?? [];
            const candidates = sourceCaptures.get("moonbit") ?? [];
            const expectedStates = 1 + applicableInteractions.length;
            if (references.length !== expectedStates || candidates.length !== expectedStates) {
              report.failures.push({
                rule: "coverage-incomplete",
                caseId: caseInfo.id,
                viewport: viewport.id,
                message: `${caseInfo.id}/${viewport.id} captured ${references.length} React and ${candidates.length} MoonBit states; expected ${expectedStates} each`,
              });
            }
            for (let index = 0; index < Math.min(references.length, candidates.length); index++) {
              const state = states[index] ?? `state-${index}`;
              const result = await compareCapturePair({
                reference: references[index]!,
                candidate: candidates[index]!,
                caseInfo,
                viewport,
                state,
              });
              if (result.failure) report.failures.push(result.failure);
              if (result.comparison) {
                report.comparisons.push(result.comparison);
                if (!result.comparison.ok) {
                  report.failures.push({
                    rule: "renderer-drift",
                    caseId: caseInfo.id,
                    viewport: viewport.id,
                    state,
                    message:
                      `${caseInfo.id}/${viewport.id}/${state} differs: ` +
                      `${result.comparison.pixel.differentPixels}/${result.comparison.pixel.totalPixels} pixels, ` +
                      `${result.comparison.semanticDiffs.length} semantic, ${result.comparison.styleDiffs.length} style, ` +
                      `${result.comparison.layoutDiffs.length} layout, ${result.comparison.behaviorDiffs.length} behavior delta(s)`,
                    evidence: {
                      pixel: result.comparison.pixel,
                      semanticDiffs: result.comparison.semanticDiffs,
                      styleDiffs: result.comparison.styleDiffs,
                      layoutDiffs: result.comparison.layoutDiffs,
                      behaviorDiffs: result.comparison.behaviorDiffs,
                      diffPath: result.comparison.diffPath,
                    },
                  });
                }
              }
            }
          }
        } catch (error) {
          if (error instanceof ParityDeadlineError) abortRemainingMatrix = true;
          report.failures.push({
            rule: "capture-failed",
            viewport: viewport.id,
            message:
              error instanceof ParityDeadlineError
                ? error.message
                : `could not load parity gallery for ${viewport.id}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
            ...(error instanceof ParityDeadlineError
              ? { evidence: { operation: error.operation, timeoutMs: error.timeoutMs } }
              : {}),
          });
        } finally {
          const allDiagnostics = [
            ...diagnostics,
            ...styleDiagnostics.map((diagnostic) => ({ ...diagnostic, page: "unmodified-style" })),
          ];
          if (allDiagnostics.length > 0) {
            report.failures.push({
              rule: "capture-failed",
              viewport: viewport.id,
              message: `gallery reported ${allDiagnostics.length} browser error(s), failed request(s), or missing resource(s)`,
              evidence: {
                diagnostics: allDiagnostics.slice(0, 30),
                omittedDiagnostics: Math.max(0, allDiagnostics.length - 30),
              },
            });
          }
          await Promise.allSettled([page.close(), stylePage.close()]);
        }
      }
    });
  } catch (error) {
    report.failures.push({
      rule: "capture-failed",
      message: `could not launch browser for renderer parity: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    });
  }
  const expectedComparisons = manifest.cases.reduce(
    (sum, caseInfo) =>
      sum +
      manifest.viewports.reduce(
        (viewportSum, viewport) =>
          viewportSum +
          1 +
          (caseInfo.interactions ?? []).filter(
            (interaction) => interaction.viewports === undefined || interaction.viewports.includes(viewport.id),
          ).length,
        0,
      ),
    0,
  );
  if (report.comparisons.length !== expectedComparisons) {
    report.failures.push({
      rule: "coverage-incomplete",
      message: `captured ${report.comparisons.length} state comparisons; expected ${expectedComparisons}`,
    });
  }
  report.ok = report.failures.length === 0 && report.comparisons.length === expectedComparisons;
  await mkdir(outputDir, { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  return report;
}

async function captureMountedSourceState(input: {
  page: import("playwright").Page;
  stylePage: import("playwright").Page;
  root: import("playwright").Locator;
  styleRoot: import("playwright").Locator;
  caseInfo: ParityCase;
  viewport: ParityViewport;
  source: ParitySource;
  state: string;
  interactionType: ParityActionType;
  outputDir: string;
}): Promise<{ capture: RendererParityCapture; png?: Buffer; dom?: ParityDomSnapshot }> {
  const { page, stylePage, root, styleRoot, caseInfo, viewport, source, state, interactionType, outputDir } = input;
  const capture: RendererParityCapture = {
    caseId: caseInfo.id,
    component: caseInfo.component,
    viewport: viewport.id,
    state,
    source,
  };
  const box = await root.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0)
    return { capture: { ...capture, error: "mounted root has an empty box" } };
  const path = join(outputDir, slug(caseInfo.id), slug(viewport.id), slug(state));
  await mkdir(path, { recursive: true });
  const screenshotPath = join(path, `${source}.png`);
  const domPath = join(path, `${source}.dom.json`);
  try {
    const action = await captureActionEvents(root, ACTION_EVENT_TYPES[interactionType]);
    const png = await screenshotParityRoot(page, root, screenshotPath);
    const image = PNG.sync.read(png);
    if (
      png.length === 0 ||
      image.width <= 0 ||
      image.height <= 0 ||
      image.data.length === 0 ||
      !hasVisiblePixels(png)
    ) {
      return { capture: { ...capture, error: "capture has no visible pixels or dimensions" } };
    }
    const scrollError = await alignCapturePageScroll(page, stylePage);
    if (scrollError) return { capture: { ...capture, error: scrollError } };
    const caretColors = await captureCaretColors(styleRoot);
    const { dom } = await captureDomSnapshot(root, action);
    const caretError = restoreMeasuredCaretColors(dom, caretColors);
    if (caretError) return { capture: { ...capture, error: caretError } };
    const agreementError = await assertCapturePlaneAgreement({
      png,
      dom,
      action,
      styleRoot,
      eventTypes: ACTION_EVENT_TYPES[interactionType],
    });
    if (agreementError) return { capture: { ...capture, error: agreementError } };
    if (dom.nodes.length === 0 || dom.aria.trim() === "")
      return { capture: { ...capture, error: "capture has no DOM or accessible-tree content" } };
    await writeFile(domPath, JSON.stringify({ ...dom, action }, null, 2));
    if (dom.invalidReferences.length > 0) {
      return {
        capture: {
          ...capture,
          screenshotPath,
          domPath,
          dimensions: { width: image.width, height: image.height },
          nodeCount: dom.nodes.length,
          action,
          error: `DOM contains invalid ID references: ${dom.invalidReferences.join("; ")}`,
        },
        png,
        dom,
      };
    }
    return {
      capture: {
        ...capture,
        screenshotPath,
        domPath,
        dimensions: { width: image.width, height: image.height },
        nodeCount: dom.nodes.length,
        action,
      },
      png,
      dom,
    };
  } catch (error) {
    return { capture: { ...capture, error: error instanceof Error ? error.message.split("\n")[0]! : String(error) } };
  }
}

export function formatRendererParityReport(report: RendererParityReport, rules?: RuleView): string {
  const { shown, hiddenByRule } = applyRuleTiers(
    report.failures,
    (failure) => ({ rule: failure.rule, emitted: "suspect" }),
    rules,
  );
  const lines = [
    "vlmkit check renderer-parity",
    `gallery: ${report.gallery}`,
    `reference: Cloudflare Kumo ${report.kumoVersion ?? "(version unavailable)"}`,
    `coverage: ${report.cases} cases × ${report.viewports} viewports; ${report.comparisons.length} state comparisons`,
    `result: ${shown.length === 0 ? "PASS" : "FAIL"}`,
    `artifacts: ${report.outputDir}`,
    `report: ${report.reportPath}`,
  ];
  const hiddenNote = hiddenByRuleNote(hiddenByRule);
  if (hiddenNote) lines.push(`rules: ${hiddenNote}`);
  for (const { row: failure } of shown) {
    const location = [failure.caseId, failure.viewport, failure.state].filter(Boolean).join("/");
    lines.push(`  FAIL ${failure.rule}${location ? ` ${location}` : ""}: ${failure.message}`);
    const diffPath = failure.evidence?.diffPath;
    if (typeof diffPath === "string") lines.push(`    diff: ${diffPath}`);
  }
  return lines.join("\n");
}
