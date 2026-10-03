/** macOS native surface transport: observer capture plus protocol-v1 hit testing/actions. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { UsageError } from "@mizchi/vlmkit-core/cli-error.ts";
import {
  contentPolicyMetadata,
  type ContentPolicyMetadata,
  type ContentProvenance,
} from "@mizchi/vlmkit-core/content-provenance.ts";
import { decodePng } from "@mizchi/vlmkit-core/png-utils.ts";
import { parseA11yTree, type A11yTree } from "@mizchi/vlmkit-judge/a11y-tree.ts";

export type MacTarget =
  | { by: "pid"; pid: number }
  | { by: "bundle-id"; bundleId: string; launchIfNeeded?: boolean }
  | { by: "app-path"; appPath: string; launchIfNeeded?: boolean };
export type WindowSelector =
  | { by: "window-id"; windowId: string }
  | { by: "main" | "focused" }
  | { by: "index"; index: number };

export type NativeSurfaceLocator =
  | { by: "stable-id"; value: string }
  | { by: "role-name"; role: string; name: string; nth?: number }
  | { by: "path"; value: string }
  | { by: "point"; xPx: number; yPx: number };

export type NativeActionMode = "semantic" | "physical";

export type NativeSurfaceAction =
  | { kind: "press"; mode?: NativeActionMode; locator: NativeSurfaceLocator }
  | { kind: "focus"; mode?: "semantic"; locator: NativeSurfaceLocator }
  | { kind: "click"; mode?: "physical"; locator: NativeSurfaceLocator }
  | { kind: "typeText"; mode?: NativeActionMode; locator: NativeSurfaceLocator; text: string }
  | {
      kind: "key";
      mode?: "physical";
      locator?: NativeSurfaceLocator;
      keyCode: number;
      modifiers?: Array<"command" | "shift" | "option" | "control" | "fn">;
    }
  | {
      kind: "scroll";
      mode?: "physical";
      locator?: NativeSurfaceLocator;
      deltaX?: number;
      deltaY?: number;
    };

export interface NativeSurfaceNodeRef {
  path: string;
  role: string;
  platformRole: string;
  identifier?: string;
  name?: string;
  value?: string;
  rect: { left: number; top: number; width: number; height: number };
  actions: string[];
  states?: Record<string, boolean>;
}

export interface NativeHitResult {
  input: { xPx: number; yPx: number };
  logical: { x: number; y: number };
  global: { x: number; y: number };
  node: NativeSurfaceNodeRef;
  ancestors: NativeSurfaceNodeRef[];
  actionable: boolean;
  exact: boolean;
  locator: Exclude<NativeSurfaceLocator, { by: "point" }>;
  transform: {
    globalWindowOriginPoints: { x: number; y: number };
    logicalToPixelScale: number;
  };
}

export interface NativeActionEvidence {
  timestamp: string;
  mode: NativeActionMode;
  action: Record<string, unknown>;
  target?: NativeSurfaceNodeRef;
  globalPoint?: { x: number; y: number };
}

export interface NativeActionResult {
  ok: true;
  mode: NativeActionMode;
  kind: NativeSurfaceAction["kind"];
  target?: NativeSurfaceNodeRef;
  evidence: NativeActionEvidence;
}

export interface NativeInteractionSession {
  readonly sessionId: string;
  readonly windowId: string;
  readonly client: NativeAgentClient;
  hitTest(point: { xPx: number; yPx: number }): Promise<NativeHitResult>;
  perform(action: NativeSurfaceAction, options?: { evidencePath?: string }): Promise<NativeActionResult>;
  capture(options: {
    treePath: string;
    pngPath: string;
    maxDepth?: number;
    maxNodes?: number;
  }): Promise<{ tree: A11yTree; capture: NativeCaptureResult }>;
  close(options?: { terminateIfLaunched?: boolean }): Promise<void>;
}
export interface NativeCaptureResult {
  treePath: string;
  pngPath: string;
  viewport: { width: number; height: number };
  framePixels: { width: number; height: number };
  scale: number;
  counts: { nodes: number; truncated: number; attributeErrors: number };
  transform: { globalWindowOriginPoints: { x: number; y: number }; logicalToPixelScale: number };
  diagnostics: Array<{ code: string; [key: string]: unknown }>;
  contentPolicy: ContentPolicyMetadata;
}
export class NativeAgentError extends UsageError {
  readonly code: string;
  readonly details: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(`${code}: ${message}`);
    this.code = code;
    this.details = details;
  }
}
export function macTarget(source: string, launch = false): MacTarget {
  const value = source.slice("macos:".length);
  if (!source.startsWith("macos:") || !value) throw new UsageError("Expected macos:<bundle-id|pid=123|/path/App.app>.");
  if (value.startsWith("pid=")) {
    const pid = Number(value.slice(4));
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647)
      throw new UsageError("macos:pid= needs a positive process ID.");
    if (launch) throw new UsageError("--launch cannot be used with a PID.");
    return { by: "pid", pid };
  }
  if (value.includes("/") || value.startsWith("."))
    return { by: "app-path", appPath: resolve(value), launchIfNeeded: launch };
  return { by: "bundle-id", bundleId: value, launchIfNeeded: launch };
}
export function macWindow(value?: string): WindowSelector | undefined {
  if (value === undefined) return undefined;
  if (value === "main" || value === "focused") return { by: value };
  if (/^index=\d+$/.test(value)) return { by: "index", index: Number(value.slice(6)) };
  if (value.startsWith("window[")) return { by: "window-id", windowId: value };
  throw new UsageError("--window expects main, focused, index=N, or a window ID from window.list.");
}

/** One process per scan; every pending request settles on timeout, malformed output or exit. */
export class NativeAgentClient {
  private process;
  private lines;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private failure?: Error;
  constructor(
    executable: string,
    private timeout = 30000,
  ) {
    this.process = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.lines = createInterface({ input: this.process.stdout });
    // Drain stderr without mixing human diagnostics into the wire protocol.
    this.process.stderr.on("data", (chunk: Buffer) => {
      if (process.env.VLMKIT_NATIVE_DEBUG === "1") process.stderr.write(chunk);
    });
    this.process.stdin.on("error", (e) => this.abort(new NativeAgentError("NATIVE_AGENT_EXITED", e.message)));
    this.process.on("error", (e) => this.abort(new NativeAgentError("NATIVE_AGENT_START_FAILED", e.message)));
    this.process.on("exit", (code, signal) =>
      this.abort(new NativeAgentError("NATIVE_AGENT_EXITED", `agent exited (${code ?? signal})`)),
    );
    this.lines.on("line", (line) => {
      try {
        const response = JSON.parse(line);
        const request = this.pending.get(response.id);
        if (
          !request ||
          typeof response.ok !== "boolean" ||
          (response.ok
            ? !("result" in response)
            : typeof response.error?.code !== "string" || typeof response.error?.message !== "string")
        ) {
          throw new Error("Invalid response envelope or unknown request ID.");
        }
        clearTimeout(request.timer);
        this.pending.delete(response.id);
        if (response.ok) request.resolve(response.result);
        else request.reject(new NativeAgentError(response.error.code, response.error.message, response.error.details));
      } catch (e) {
        this.abort(new NativeAgentError("NATIVE_PROTOCOL_MISMATCH", (e as Error).message));
      }
    });
  }
  private abort(error: Error) {
    this.failure ??= error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.process.kill();
  }
  hitTest(params: {
    sessionId: string;
    windowId: string;
    point: { xPx: number; yPx: number };
  }): Promise<NativeHitResult> {
    return this.request("hitTest", params);
  }
  perform(params: {
    sessionId: string;
    windowId: string;
    action: NativeSurfaceAction;
    evidencePath?: string;
  }): Promise<NativeActionResult> {
    return this.request("perform", params);
  }
  request<T>(method: string, params: unknown = {}): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    const payload = JSON.stringify({ id, protocol: 1, method, params }) + "\n";
    return new Promise<T>((resolveRequest, reject) => {
      const timer = setTimeout(
        () => this.abort(new NativeAgentError("NATIVE_AX_TIMEOUT", `${method} exceeded ${this.timeout}ms`)),
        this.timeout,
      );
      this.pending.set(id, { resolve: (value) => resolveRequest(value as T), reject, timer });
      this.process.stdin.write(payload, (error) => {
        if (error) this.abort(new NativeAgentError("NATIVE_AGENT_EXITED", error.message));
      });
    });
  }
  close() {
    this.lines.close();
    this.abort(new NativeAgentError("NATIVE_AGENT_CLOSED", "client closed"));
  }
}

function nativeAgentExecutable(agent?: string): string {
  const executable = agent ?? process.env.VLMKIT_NATIVE_AGENT;
  if (!executable)
    throw new UsageError(
      "Set --native-agent (or VLMKIT_NATIVE_AGENT) to VLMKitNativeAgent.app/Contents/MacOS/VLMKitNativeAgent. Build with native/macos/script/build_and_run.sh --build-only.",
    );
  return executable;
}

export interface NativeDoctorResult {
  hello: {
    protocol: number;
    agentVersion?: string;
    bundleId?: string;
    macOSVersion?: string;
    arch?: string;
    capabilities?: Record<string, boolean>;
    build?: Record<string, unknown>;
  };
  doctor: {
    accessibility: { trusted: boolean };
    screenCapture: { authorized: boolean };
    agent?: Record<string, unknown>;
    checks?: Array<{ id: string; status: "pass" | "fail" | "warn"; message: string }>;
  };
}

export async function runNativeDoctor(
  options: {
    agent?: string;
    prompt?: boolean;
    timeout?: number;
  } = {},
): Promise<NativeDoctorResult> {
  if (process.platform !== "darwin") throw new UsageError("Native macOS doctor requires a macOS host.");
  const client = new NativeAgentClient(nativeAgentExecutable(options.agent), options.timeout);
  try {
    const hello = await client.request<NativeDoctorResult["hello"]>("hello");
    if (hello.protocol !== 1)
      throw new NativeAgentError("NATIVE_PROTOCOL_MISMATCH", "agent does not support protocol 1");
    const doctor = await client.request<NativeDoctorResult["doctor"]>("doctor", { prompt: options.prompt ?? false });
    return { hello, doctor };
  } finally {
    client.close();
  }
}

async function assertNativePermissions(client: NativeAgentClient): Promise<void> {
  const hello = await client.request<{ protocol: number }>("hello");
  if (hello.protocol !== 1) throw new NativeAgentError("NATIVE_PROTOCOL_MISMATCH", "agent does not support protocol 1");
  const doctor = await client.request<{
    accessibility: { trusted: boolean };
    screenCapture: { authorized: boolean };
  }>("doctor", { prompt: false });
  if (!doctor.accessibility.trusted)
    throw new NativeAgentError(
      "NATIVE_PERMISSION_ACCESSIBILITY",
      "Allow the observer in System Settings > Privacy & Security > Accessibility.",
    );
  if (!doctor.screenCapture.authorized)
    throw new NativeAgentError(
      "NATIVE_PERMISSION_SCREEN_CAPTURE",
      "Allow the observer in System Settings > Privacy & Security > Screen Recording.",
    );
}

async function selectNativeWindow(options: {
  client: NativeAgentClient;
  sessionId: string;
  selector?: WindowSelector;
  launch?: boolean;
  timeout?: number;
}): Promise<{ windowId: string }> {
  const deadline = Date.now() + (options.timeout ?? 30000);
  while (true) {
    try {
      return await options.client.request<{ windowId: string }>("window.select", {
        sessionId: options.sessionId,
        selector: options.selector,
      });
    } catch (error) {
      if (
        !options.launch ||
        !(error instanceof NativeAgentError) ||
        !["NATIVE_WINDOW_NOT_FOUND", "NATIVE_AX_CANNOT_COMPLETE"].includes(error.code) ||
        Date.now() >= deadline
      )
        throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
}

export async function captureNativeSession(
  client: NativeAgentClient,
  sessionId: string,
  windowId: string,
  options: {
    treePath: string;
    pngPath: string;
    maxDepth?: number;
    maxNodes?: number;
    provenance?: ContentProvenance;
  },
): Promise<{ tree: A11yTree; capture: NativeCaptureResult }> {
  const agentCapture = await client.request<Omit<NativeCaptureResult, "contentPolicy">>("snapshot.capture", {
    sessionId,
    windowId,
    outputTreePath: resolve(options.treePath),
    outputPngPath: resolve(options.pngPath),
    maxDepth: options.maxDepth,
    maxNodes: options.maxNodes,
  });
  const capture: NativeCaptureResult = {
    ...agentCapture,
    contentPolicy: contentPolicyMetadata(options.provenance ?? "unclassified", "capture"),
  };
  const tree = parseA11yTree(await readFile(capture.treePath, "utf8"));
  const pixels = await decodePng(capture.pngPath);
  if (
    tree.platform !== "macos" ||
    tree.scale !== capture.scale ||
    tree.viewport.width !== capture.viewport.width ||
    tree.viewport.height !== capture.viewport.height ||
    tree.nodes.length !== capture.counts.nodes ||
    pixels.width !== capture.framePixels.width ||
    pixels.height !== capture.framePixels.height ||
    Math.abs(capture.framePixels.width - tree.viewport.width * capture.scale) > 1 ||
    Math.abs(capture.framePixels.height - tree.viewport.height * capture.scale) > 1
  ) {
    throw new NativeAgentError("NATIVE_COORDINATE_MISMATCH", "capture metadata and tree disagree");
  }
  return { tree, capture };
}

export async function openNativeInteractionSession(options: {
  source: string;
  agent?: string;
  launch?: boolean;
  window?: string;
  timeout?: number;
}): Promise<NativeInteractionSession> {
  if (process.platform !== "darwin") throw new UsageError("Native macOS interaction requires a macOS host.");
  const client = new NativeAgentClient(nativeAgentExecutable(options.agent), options.timeout);
  let sessionId: string | undefined;
  try {
    await assertNativePermissions(client);
    const target = macTarget(options.source, options.launch);
    ({ sessionId } = await client.request<{ sessionId: string }>("target.open", { target }));
    const window = await selectNativeWindow({
      client,
      sessionId,
      selector: macWindow(options.window),
      launch: options.launch,
      timeout: options.timeout,
    });
    let closed = false;
    return {
      sessionId,
      windowId: window.windowId,
      client,
      hitTest: (point) => client.hitTest({ sessionId: sessionId!, windowId: window.windowId, point }),
      perform: (action, performOptions) =>
        client.perform({
          sessionId: sessionId!,
          windowId: window.windowId,
          action,
          ...(performOptions?.evidencePath ? { evidencePath: resolve(performOptions.evidencePath) } : {}),
        }),
      capture: (captureOptions) => captureNativeSession(client, sessionId!, window.windowId, captureOptions),
      async close(closeOptions) {
        if (closed) return;
        closed = true;
        await client
          .request("session.close", {
            sessionId: sessionId!,
            terminateIfLaunched: closeOptions?.terminateIfLaunched ?? false,
          })
          .catch(() => {});
        client.close();
      },
    };
  } catch (error) {
    if (sessionId) await client.request("session.close", { sessionId }).catch(() => {});
    client.close();
    throw error;
  }
}

export async function captureNativeA11y(options: {
  source: string;
  out: string;
  frame: string;
  agent?: string;
  launch?: boolean;
  window?: string;
  maxDepth?: number;
  maxNodes?: number;
  timeout?: number;
  /** Local policy label attached to the produced semantic tree + screenshot. */
  provenance?: ContentProvenance;
}): Promise<{ tree: A11yTree; capture: NativeCaptureResult }> {
  if (process.platform !== "darwin") throw new UsageError("Native macOS scan requires a macOS host.");
  const executable = nativeAgentExecutable(options.agent);
  const target = macTarget(options.source, options.launch);
  const selector = macWindow(options.window);
  const client = new NativeAgentClient(executable, options.timeout);
  let sessionId: string | undefined;
  try {
    await assertNativePermissions(client);
    ({ sessionId } = await client.request<{ sessionId: string }>("target.open", { target }));
    const window = await selectNativeWindow({
      client,
      sessionId,
      selector,
      launch: options.launch,
      timeout: options.timeout,
    });
    return await captureNativeSession(client, sessionId, window.windowId, {
      treePath: options.out,
      pngPath: options.frame,
      maxDepth: options.maxDepth,
      maxNodes: options.maxNodes,
      provenance: options.provenance,
    });
  } finally {
    if (sessionId) await client.request("session.close", { sessionId }).catch(() => {});
    client.close();
  }
}
