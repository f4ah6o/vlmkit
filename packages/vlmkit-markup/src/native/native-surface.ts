import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "@mizchi/vlmkit-core/cli-error.ts";
import { decodePng } from "@mizchi/vlmkit-core/png-utils.ts";
import { isInteractive, type A11yNode, type A11yTree } from "@mizchi/vlmkit-judge/a11y-tree.ts";
import {
  openNativeInteractionSession,
  type NativeCaptureResult,
  type NativeInteractionSession,
  type NativeHitResult,
  type NativeSurfaceLocator,
} from "../a11y-tree/native-agent.ts";
import {
  analyzeGroundingSamples,
  writeMarkedScreenshot,
  type GroundingProbe,
  type GroundingScanOptions,
  type GroundingScanReport,
  type GroundingTargetSample,
} from "../inspect/grounding-scan.ts";
import {
  activationKeyForRole,
  type ActivationResult,
  type InteractionElement,
  type InteractionMapResult,
} from "../inspect/interaction-map.ts";

export interface NativeSurfaceOptions {
  source: string;
  nativeAgent?: string;
  launch?: boolean;
  window?: string;
  timeout?: number;
  maxDepth?: number;
  maxNodes?: number;
}

export interface NativeCapturedState {
  tree: A11yTree;
  capture: NativeCaptureResult;
  treePath: string;
  pngPath: string;
}

export function nativeLocatorForNode(node: A11yNode): NativeSurfaceLocator {
  if (node.identifier) return { by: "stable-id", value: node.identifier };
  if (node.name) return { by: "role-name", role: node.role, name: node.name };
  return { by: "path", value: node.path };
}

export function nativeProbeLocatorForNode(
  tree: A11yTree,
  node: A11yNode,
): Exclude<NativeSurfaceLocator, { by: "point" }> {
  if (node.identifier) {
    const matches = tree.nodes.filter((candidate) => candidate.identifier === node.identifier);
    if (matches.length === 1) return { by: "stable-id", value: node.identifier };
  }
  if (node.name) {
    const matches = tree.nodes.filter(
      (candidate) => candidate.role === node.role && (candidate.name ?? "") === node.name,
    );
    if (matches.length === 1) return { by: "role-name", role: node.role, name: node.name };
    const nth = matches.findIndex((candidate) => candidate.path === node.path);
    if (nth >= 0) return { by: "role-name", role: node.role, name: node.name, nth };
  }
  return { by: "path", value: node.path };
}

export function nativeSelectorForNode(node: A11yNode): string {
  if (node.identifier) return `native[id=${JSON.stringify(node.identifier)}]`;
  if (node.name) return `native[role=${JSON.stringify(node.role)}][name=${JSON.stringify(node.name)}]`;
  return `native[path=${JSON.stringify(node.path)}]`;
}

export function nativeNodeMatchesLocator(node: A11yNode, locator: NativeSurfaceLocator): boolean {
  switch (locator.by) {
    case "stable-id":
      return node.identifier === locator.value;
    case "role-name":
      return node.role === locator.role && (node.name ?? "") === locator.name;
    case "path":
      return node.path === locator.value;
    case "point":
      return false;
  }
}

export function nativeNodesForLocator(tree: A11yTree, locator: NativeSurfaceLocator): A11yNode[] {
  if (locator.by === "point") return [];
  const nodes = tree.nodes.filter((node) => nativeNodeMatchesLocator(node, locator));
  if (locator.by === "role-name" && locator.nth !== undefined) return nodes[locator.nth] ? [nodes[locator.nth]!] : [];
  return nodes;
}

export async function captureNativeState(
  session: NativeInteractionSession,
  dir: string,
  name: string,
  options: Pick<NativeSurfaceOptions, "maxDepth" | "maxNodes"> = {},
): Promise<NativeCapturedState> {
  const treePath = join(dir, `${name}.a11y.json`);
  const pngPath = join(dir, `${name}.png`);
  const result = await session.capture({
    treePath,
    pngPath,
    maxDepth: options.maxDepth,
    maxNodes: options.maxNodes,
  });
  return { ...result, treePath, pngPath };
}

function intersect(rect: { x: number; y: number; width: number; height: number }, width: number, height: number) {
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(width, rect.x + rect.width);
  const bottom = Math.min(height, rect.y + rect.height);
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function ancestorNames(tree: A11yTree, node: A11yNode): string[] {
  const out: string[] = [];
  let path = node.path;
  while (out.length < 3) {
    const cut = path.lastIndexOf(">");
    if (cut < 0) break;
    path = path.slice(0, cut);
    const parent = tree.nodes.find((candidate) => candidate.path === path);
    const name = parent?.name?.trim();
    if (name) out.push(name);
  }
  return out;
}

function nativeHitTargetsNode(hit: NativeHitResult, node: A11yNode): boolean {
  return [hit.node, ...hit.ancestors].some((candidate) => candidate.path === node.path);
}

export async function nativeGroundingSample(
  session: NativeInteractionSession,
  tree: A11yTree,
  capture: NativeCaptureResult,
  node: A11yNode,
): Promise<GroundingTargetSample> {
  const scale = capture.scale;
  const bbox = {
    x: node.rect.left * scale,
    y: node.rect.top * scale,
    width: node.rect.width * scale,
    height: node.rect.height * scale,
  };
  const painted = intersect(bbox, capture.framePixels.width, capture.framePixels.height);
  const clickPoint = {
    x: painted.x + painted.width / 2,
    y: painted.y + painted.height / 2,
  };
  let centreHit = false;
  let interceptedBy: string | undefined;
  let reachable: GroundingTargetSample["reachable"];
  if (painted.width > 0 && painted.height > 0) {
    try {
      const hit = await session.hitTest({ xPx: Math.round(clickPoint.x), yPx: Math.round(clickPoint.y) });
      const same = nativeHitTargetsNode(hit, node);
      centreHit = !!same;
      if (!same) interceptedBy = hit.node.identifier ?? hit.node.path;
    } catch {
      centreHit = false;
    }
    if (!centreHit) {
      const probes = [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
        [0.5, 0.5],
      ] as const;
      for (const [fx, fy] of probes) {
        const x = painted.x + painted.width * fx;
        const y = painted.y + painted.height * fy;
        try {
          const hit = await session.hitTest({ xPx: Math.round(x), yPx: Math.round(y) });
          const same = nativeHitTargetsNode(hit, node);
          if (same) {
            reachable = {
              x,
              y,
              room: Math.min(
                x - painted.x,
                painted.x + painted.width - x,
                y - painted.y,
                painted.y + painted.height - y,
              ),
              sampled: probes.length,
              clear: 1,
            };
            break;
          }
        } catch {
          // Keep the target fail-closed: no successful hit means unreachable.
        }
      }
    }
  }
  return {
    selector: nativeSelectorForNode(node),
    tag: node.platformRole ?? node.role,
    role: node.role,
    name: node.name ?? "",
    visibleText: node.name ?? "",
    // AX does not expose whether an icon paints pixels. Treat named controls as
    // visibly labelled; unnamed controls are left glyph-capable rather than
    // inventing an unlabeled screenshot finding without OCR/pixel evidence.
    hasGlyph: !node.name,
    bbox,
    clickPoint,
    hitFraction: centreHit ? 1 : reachable ? 0.2 : 0,
    centreHit,
    ...(interceptedBy ? { interceptedBy } : {}),
    ...(reachable ? { reachable } : {}),
    disabled: !!node.states?.disabled,
    inFrame: painted.width > 0 && painted.height > 0 && !node.states?.hidden,
    clipped:
      painted.x !== bbox.x || painted.y !== bbox.y || painted.width !== bbox.width || painted.height !== bbox.height,
    ...(painted.width > 0 && painted.height > 0 ? { painted } : {}),
    ancestorTexts: ancestorNames(tree, node),
  };
}

function modelToRaw(point: { x: number; y: number }, frameScale: number) {
  return {
    xPx: Math.round(point.x / frameScale),
    yPx: Math.round(point.y / frameScale),
  };
}

export async function runNativeGrounding(
  options: GroundingScanOptions & NativeSurfaceOptions,
): Promise<GroundingScanReport> {
  if (options.html !== undefined || options.storageState || options.har) {
    throw new UsageError("Native grounding does not accept browser HTML/storage/HAR options.");
  }
  const dir = await mkdtemp(join(tmpdir(), "vlmkit-native-grounding-"));
  const session = await openNativeInteractionSession({
    source: options.source,
    agent: options.nativeAgent,
    launch: options.launch,
    window: options.window,
    timeout: options.timeout,
  });
  try {
    let state = await captureNativeState(session, dir, "initial", options);
    let initial = analyzeGroundingSamples(
      {
        source: options.source,
        page: {
          viewportWidth: state.capture.framePixels.width,
          viewportHeight: state.capture.framePixels.height,
          capped: state.capture.counts.truncated,
        },
        targets: [],
      },
      options,
    );
    if (options.after?.length) {
      for (const action of options.after) {
        const raw = modelToRaw(action.at, initial.frame.scale);
        if (action.kind === "click") {
          await session.perform({ kind: "click", mode: "physical", locator: { by: "point", ...raw } });
        } else if (action.kind === "wheel") {
          await session.perform({
            kind: "scroll",
            mode: "physical",
            locator: { by: "point", ...raw },
            deltaY: action.dy / initial.frame.scale,
          });
        } else {
          throw new UsageError('Native grounding does not support --after "move"; use click or wheel.');
        }
      }
      state = await captureNativeState(session, dir, "after", options);
    }
    const candidates = state.tree.nodes.filter((node) => isInteractive(node)).slice(0, 300);
    const samples: GroundingTargetSample[] = [];
    for (const node of candidates) samples.push(await nativeGroundingSample(session, state.tree, state.capture, node));
    const report = analyzeGroundingSamples(
      {
        source: options.source,
        page: {
          viewportWidth: state.capture.framePixels.width,
          viewportHeight: state.capture.framePixels.height,
          capped:
            state.capture.counts.truncated +
            Math.max(0, state.tree.nodes.filter(isInteractive).length - candidates.length),
        },
        targets: samples,
      },
      options,
    );
    if (options.after?.length) report.after = options.after.map((action) => ({ ...action, at: { ...action.at } }));
    if (options.at?.length) {
      const probes: GroundingProbe[] = [];
      for (const point of options.at) {
        if (point.x < 0 || point.y < 0 || point.x >= report.frame.width || point.y >= report.frame.height) {
          probes.push({ point: { ...point }, cssPoint: { ...point }, hit: null, offFrame: true });
          continue;
        }
        const raw = modelToRaw(point, report.frame.scale);
        try {
          const hit = await session.hitTest(raw);
          const selector = nativeSelectorForNode(hit.node);
          const target = report.targets.find((candidate) => candidate.selector === selector);
          probes.push({
            point: { ...point },
            cssPoint: { x: raw.xPx, y: raw.yPx },
            hit: selector,
            ...(target ? { targetId: target.id } : {}),
          });
        } catch {
          probes.push({ point: { ...point }, cssPoint: { x: raw.xPx, y: raw.yPx }, hit: null });
        }
      }
      report.probes = probes;
    }
    if (options.markPath) {
      await writeMarkedScreenshot(options.markPath, await readFile(state.pngPath), report);
    }
    return report;
  } finally {
    await session.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function boolText(value: boolean | undefined): string | null {
  return value === undefined ? null : value ? "true" : "false";
}

function stateSnapshot(node: A11yNode | undefined) {
  return {
    expanded: boolText(node?.states?.expanded),
    selected: boolText(node?.states?.selected),
    checked: boolText(node?.states?.checked),
    pressed: null,
  };
}

function activationDelta(before: A11yNode | undefined, after: A11yNode | undefined): ActivationResult["ariaDelta"] {
  const a = stateSnapshot(before);
  const b = stateSnapshot(after);
  const out: ActivationResult["ariaDelta"] = {};
  for (const key of ["expanded", "selected", "checked", "pressed"] as const) {
    if (a[key] !== b[key]) out[key] = [a[key], b[key]];
  }
  if ((before?.value ?? null) !== (after?.value ?? null)) out.value = [before?.value ?? null, after?.value ?? null];
  return out;
}

async function focusChangedPixels(
  beforePath: string,
  afterPath: string,
  node: A11yNode,
  scale: number,
): Promise<boolean> {
  const before = await decodePng(beforePath);
  const after = await decodePng(afterPath);
  if (before.width !== after.width || before.height !== after.height) return true;
  const x0 = Math.max(0, Math.floor(node.rect.left * scale) - 3);
  const y0 = Math.max(0, Math.floor(node.rect.top * scale) - 3);
  const x1 = Math.min(before.width, Math.ceil((node.rect.left + node.rect.width) * scale) + 3);
  const y1 = Math.min(before.height, Math.ceil((node.rect.top + node.rect.height) * scale) + 3);
  let changed = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * before.width + x) * 4;
      if (
        before.data[i] !== after.data[i] ||
        before.data[i + 1] !== after.data[i + 1] ||
        before.data[i + 2] !== after.data[i + 2] ||
        before.data[i + 3] !== after.data[i + 3]
      ) {
        changed++;
        if (changed >= 2) return true;
      }
    }
  }
  return false;
}

function elementKey(node: A11yNode) {
  return `${node.role}|${(node.name ?? "").replace(/\s+/g, " ").trim().toLowerCase()}`;
}

function focusedPath(tree: A11yTree): string | undefined {
  return tree.nodes.find((node) => node.states?.focused)?.path;
}

function focusBelongsToTarget(focused: string | undefined, targetPath: string): boolean {
  return !!focused && (focused === targetPath || focused.startsWith(`${targetPath}>`));
}

function interactionKeyCode(key: string): number {
  switch (key) {
    case "Enter":
      return 36;
    case " ":
      return 49;
    case "ArrowRight":
      return 124;
    case "ArrowDown":
      return 125;
    default:
      throw new UsageError(`Native interaction probe has no CoreGraphics key code for ${JSON.stringify(key)}.`);
  }
}

function focusedInteractive(all: A11yNode[], focused: string | undefined): A11yNode | undefined {
  if (!focused) return undefined;
  return [...all]
    .filter((node) => focusBelongsToTarget(focused, node.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

async function collectNativeTabStops(
  session: NativeInteractionSession,
  state: NativeCapturedState,
  dir: string,
  options: NativeSurfaceOptions,
  all: A11yNode[],
): Promise<{ state: NativeCapturedState; focusIndicators: Map<string, boolean> }> {
  const focusIndicators = new Map<string, boolean>();
  if (all.length === 0) return { state, focusIndicators };
  const seenFocusPaths = new Set<string>();
  const limit = Math.min(96, all.length * 3 + 8);
  for (let step = 0; step < limit; step++) {
    const before = state;
    await session.perform({ kind: "key", mode: "physical", keyCode: 48 });
    const after = await captureNativeState(session, dir, `tab-${step}`, options);
    state = after;
    const focused = focusedPath(after.tree);
    if (!focused) continue;
    if (seenFocusPaths.has(focused)) break;
    seenFocusPaths.add(focused);
    const target = focusedInteractive(all, focused);
    if (!target || focusIndicators.has(target.path)) continue;
    const currentTarget = after.tree.nodes.find((node) => node.path === target.path) ?? target;
    focusIndicators.set(
      target.path,
      await focusChangedPixels(before.pngPath, after.pngPath, currentTarget, after.capture.scale),
    );
  }
  return { state, focusIndicators };
}

async function focusNativeTargetWithTab(
  session: NativeInteractionSession,
  state: NativeCapturedState,
  dir: string,
  options: NativeSurfaceOptions,
  targetPath: string,
  interactiveCount: number,
  label: string,
): Promise<{ state: NativeCapturedState; reached: boolean }> {
  if (focusBelongsToTarget(focusedPath(state.tree), targetPath)) return { state, reached: true };
  const seenFocusPaths = new Set<string>();
  const limit = Math.min(96, interactiveCount * 3 + 8);
  for (let step = 0; step < limit; step++) {
    await session.perform({ kind: "key", mode: "physical", keyCode: 48 });
    state = await captureNativeState(session, dir, `${label}-tab-${step}`, options);
    const focused = focusedPath(state.tree);
    if (focusBelongsToTarget(focused, targetPath)) return { state, reached: true };
    if (!focused) continue;
    if (seenFocusPaths.has(focused)) break;
    seenFocusPaths.add(focused);
  }
  return { state, reached: false };
}

export async function buildNativeInteractionMap(
  options: NativeSurfaceOptions & { maxElements: number },
): Promise<InteractionMapResult> {
  const dir = await mkdtemp(join(tmpdir(), "vlmkit-native-interactions-"));
  const session = await openNativeInteractionSession({
    source: options.source,
    agent: options.nativeAgent,
    launch: options.launch,
    window: options.window,
    timeout: options.timeout,
  });
  try {
    let state = await captureNativeState(session, dir, "base", options);
    const all = state.tree.nodes.filter(isInteractive);
    const picked = all.slice(0, options.maxElements);
    const tabWalk = await collectNativeTabStops(session, state, dir, options, all);
    state = tabWalk.state;
    const elements: InteractionElement[] = [];

    for (let index = 0; index < picked.length; index++) {
      const original = picked[index]!;
      const tabReachable = tabWalk.focusIndicators.has(original.path);
      const focusIndicator = tabReachable ? tabWalk.focusIndicators.get(original.path)! : null;
      let activation: ActivationResult | undefined;
      const key = activationKeyForRole(original.role);

      if (key && tabReachable) {
        const focused = await focusNativeTargetWithTab(
          session,
          state,
          dir,
          options,
          original.path,
          all.length,
          `activate-${index}`,
        );
        state = focused.state;
        if (focused.reached) {
          const currentOriginal = state.tree.nodes.find((node) => node.path === original.path) ?? original;
          const locator = nativeProbeLocatorForNode(state.tree, currentOriginal);
          const beforeNode = nativeNodesForLocator(state.tree, locator)[0] ?? currentOriginal;
          const beforePng = await readFile(state.pngPath);
          await session.perform({
            kind: "key",
            mode: "physical",
            keyCode: interactionKeyCode(key),
          });
          const afterKey = await captureNativeState(session, dir, `activate-${index}-after`, options);
          const afterNode =
            afterKey.tree.nodes.find((node) => node.path === original.path) ??
            nativeNodesForLocator(afterKey.tree, locator)[0];
          const afterPng = await readFile(afterKey.pngPath);
          const afterFocused = focusedPath(afterKey.tree);
          const movedTo = focusedInteractive(all, afterFocused);
          activation = {
            key: key === " " ? "Space" : key,
            ariaDelta: activationDelta(beforeNode, afterNode),
            controlsBecameVisible: null,
            layoutChanged: !beforePng.equals(afterPng),
            focusMovedTo:
              movedTo && movedTo.path !== original.path ? all.findIndex((node) => node.path === movedTo.path) : null,
          };
          state = afterKey;
        }
      }

      elements.push({
        index,
        key: elementKey(original),
        role: original.role,
        name: original.name ?? "",
        path: original.path,
        hasAriaExpanded: original.states?.expanded !== undefined,
        hasPopup: false,
        ...(original.states?.disabled ? { declaresNoOp: true } : {}),
        tabReachable,
        focusIndicator,
        ...(activation ? { activation } : {}),
      });
    }
    return { source: options.source, elements, capped: Math.max(0, all.length - picked.length) };
  } finally {
    await session.close();
    await rm(dir, { recursive: true, force: true });
  }
}
