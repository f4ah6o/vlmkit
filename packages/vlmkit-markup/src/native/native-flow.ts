import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { UsageError } from "@mizchi/vlmkit-core/cli-error.ts";
import { appendRunLedger } from "@mizchi/vlmkit-core/run-ledger.ts";
import {
  openNativeInteractionSession,
  type NativeSurfaceLocator,
} from "../a11y-tree/native-agent.ts";
import type {
  FlowAction,
  FlowAssert,
  FlowLocator,
  FlowVerifyOptions,
  FlowVerifyReport,
  StepResult,
} from "../inspect/flow-verify.ts";
import {
  captureNativeState,
  nativeNodesForLocator,
} from "./native-surface.ts";

function locatorOf(value: { locator?: FlowLocator; selector?: string }, where: string): NativeSurfaceLocator {
  if (value.locator) return value.locator;
  throw new UsageError(`${where}: native flows require "locator", not CSS "selector".`);
}

function keyCode(key: string): number {
  const normalized = key.toLowerCase();
  const codes: Record<string, number> = {
    enter: 36,
    return: 36,
    tab: 48,
    space: 49,
    escape: 53,
    esc: 53,
    backspace: 51,
    delete: 117,
    arrowleft: 123,
    arrowright: 124,
    arrowdown: 125,
    arrowup: 126,
    home: 115,
    end: 119,
    pageup: 116,
    pagedown: 121,
  };
  const value = codes[normalized];
  if (value === undefined) {
    throw new UsageError(
      `native flow key ${JSON.stringify(key)} is not in the portable key map; use Enter/Tab/Space/Escape/arrows/navigation keys.`,
    );
  }
  return value;
}

async function runNativeAction(
  session: Awaited<ReturnType<typeof openNativeInteractionSession>>,
  action: FlowAction,
  evidencePath: string,
): Promise<void> {
  switch (action.action) {
    case "click":
      await session.perform(
        { kind: "click", mode: "physical", locator: locatorOf(action, "click") },
        { evidencePath },
      );
      return;
    case "focus":
      await session.perform(
        { kind: "focus", mode: "semantic", locator: locatorOf(action, "focus") },
        { evidencePath },
      );
      return;
    case "fill":
      await session.perform(
        { kind: "typeText", mode: "semantic", locator: locatorOf(action, "fill"), text: action.value },
        { evidencePath },
      );
      return;
    case "type":
      await session.perform(
        { kind: "typeText", mode: "physical", locator: locatorOf(action, "type"), text: action.text },
        { evidencePath },
      );
      return;
    case "press": {
      if (action.locator) {
        await session.perform({ kind: "focus", mode: "semantic", locator: action.locator });
      } else if (action.selector) {
        throw new UsageError('press: native flows require "locator", not CSS "selector".');
      }
      await session.perform(
        { kind: "key", mode: "physical", keyCode: keyCode(action.key) },
        { evidencePath },
      );
      return;
    }
    case "hover":
      throw new UsageError("hover is browser-only; macOS AX protocol v1 has no pointer-move action.");
    case "wait":
      await new Promise((resolveWait) => setTimeout(resolveWait, action.ms));
      return;
  }
}

function isVisible(
  node: ReturnType<typeof nativeNodesForLocator>[number],
  viewport: { width: number; height: number },
): boolean {
  if (node.states?.hidden) return false;
  const right = node.rect.left + node.rect.width;
  const bottom = node.rect.top + node.rect.height;
  return node.rect.width > 0 && node.rect.height > 0 && right > 0 && bottom > 0 && node.rect.left < viewport.width && node.rect.top < viewport.height;
}

function attrValue(
  node: ReturnType<typeof nativeNodesForLocator>[number] | undefined,
  name: string,
): string | null {
  if (!node) return null;
  if (name === "role") return node.role;
  if (name === "name") return node.name ?? null;
  if (name === "value") return node.value ?? null;
  if (name === "identifier" || name === "id") return node.identifier ?? null;
  if (name.startsWith("state.")) {
    const key = name.slice("state.".length) as keyof NonNullable<typeof node.states>;
    const value = node.states?.[key];
    return value === undefined ? null : String(value);
  }
  return null;
}

function evalNativeAssertion(
  tree: Parameters<typeof nativeNodesForLocator>[0],
  spec: FlowAssert,
): [boolean, string] {
  const locator = locatorOf(spec, `assert ${spec.assert}`);
  const nodes = nativeNodesForLocator(tree, locator);
  switch (spec.assert) {
    case "attr": {
      const actual = attrValue(nodes[0], spec.name);
      return [actual === spec.equals, actual ?? "(null)"];
    }
    case "visible": {
      const pass = nodes.some((node) => isVisible(node, tree.viewport));
      return [pass, pass ? "visible" : "hidden/absent"];
    }
    case "hidden": {
      const pass = nodes.length === 0 || nodes.every((node) => !isVisible(node, tree.viewport));
      return [pass, pass ? "hidden/absent" : "visible"];
    }
    case "focused": {
      const pass = nodes.some((node) => !!node.states?.focused);
      return [pass, pass ? "focused" : "not focused"];
    }
    case "text": {
      const actual = nodes.map((node) => [node.name, node.value].filter(Boolean).join(" ")).join(" ").trim();
      return [actual.includes(spec.contains), actual.slice(0, 160)];
    }
    case "count":
      return [nodes.length === spec.equals, String(nodes.length)];
  }
}

function nativeActionLabel(action: FlowAction): string {
  if (action.action === "wait") return `wait ${action.ms}ms`;
  const target =
    "locator" in action && action.locator ? JSON.stringify(action.locator) :
    "selector" in action && action.selector ? action.selector : "(focused target)";
  if (action.action === "press") return `press ${action.key} on ${target}`;
  return `${action.action} ${target}`;
}

export async function runNativeFlowVerify(options: FlowVerifyOptions): Promise<FlowVerifyReport> {
  if (options.storageState || options.har || options.waitUntil) {
    throw new UsageError("Native flow does not accept browser storage-state/HAR/wait-until options.");
  }
  const artifactDir = resolve(options.artifactDir ?? ".vlmkit/native-flow");
  await mkdir(artifactDir, { recursive: true });
  const session = await openNativeInteractionSession({
    source: options.source,
    agent: options.nativeAgent,
    launch: options.launch,
    window: options.window,
    timeout: options.timeout,
  });
  const steps: StepResult[] = [];
  try {
    for (let i = 0; i < options.flow.steps.length; i++) {
      const step = options.flow.steps[i]!;
      const number = String(i + 1).padStart(3, "0");
      const actionPath = joinArtifact(artifactDir, `step-${number}-action.json`);
      const result: StepResult = {
        index: i,
        label: step.label ?? nativeActionLabel(step.do),
        action: nativeActionLabel(step.do),
        assertions: [],
        passed: true,
      };
      try {
        await runNativeAction(session, step.do, actionPath);
      } catch (error) {
        result.actionError = error instanceof Error ? error.message : String(error);
        result.passed = false;
      }

      const captured = await captureNativeState(session, artifactDir, `step-${number}`, {
        maxDepth: options.maxDepth,
        maxNodes: options.maxNodes,
      });
      result.evidence = {
        screenshotPath: captured.pngPath,
        treePath: captured.treePath,
        actionPath,
      };

      if (!result.actionError) {
        for (const spec of step.expect ?? []) {
          const [passed, actual] = evalNativeAssertion(captured.tree, spec);
          result.assertions.push({ assert: spec, passed, actual });
          if (!passed) result.passed = false;
        }
      }
      steps.push(result);
      if (!result.passed) break;
    }
  } finally {
    await session.close();
  }

  const passed = steps.filter((step) => step.passed).length;
  const done = steps.length === options.flow.steps.length && steps.every((step) => step.passed);
  appendRunLedger({
    tool: "verify-flow-native",
    source: options.source,
    headline: { done, passed, total: options.flow.steps.length, artifactDir },
  });
  return {
    source: options.source,
    steps,
    passed,
    total: options.flow.steps.length,
    done,
    artifactDir,
  };
}

function joinArtifact(dir: string, name: string): string {
  return resolve(dir, name);
}
