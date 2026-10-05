/** Native observer transport. Capture-only Linux extensions preserve the macOS protocol. */
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
export function linuxTarget(source: string, launch = false): { by: "pid"; pid: number } {
  if (launch) throw new UsageError("Linux observer is attach-only; --launch is not supported.");
  if (!/^linux:pid=[1-9]\d*$/.test(source)) throw new UsageError("Expected linux:pid=N (attach-only X11 observer).");
  const pid = Number(source.slice("linux:pid=".length));
  if (!Number.isSafeInteger(pid) || pid > 2147483647) throw new UsageError("linux:pid= needs a positive process ID.");
  return { by: "pid", pid };
}
export type WindowSelector =
  | { by: "window-id"; windowId: string }
  | { by: "main" | "focused" }
  | { by: "index"; index: number };
export interface NativeCaptureResult {
  treePath: string;
  pngPath: string;
  viewport: { width: number; height: number };
  framePixels: { width: number; height: number };
  scale: number;
  counts: { nodes: number; truncated: number; attributeErrors: number };
  transform: { globalWindowOriginPoints: { x: number; y: number }; logicalToPixelScale: number };
  /** Linux v0 explicitly captures the X11 client window, not WM decorations. */
  backend?: "x11";
  frameKind?: "client-window";
  identity?: { pid: number; windowId: string; [key: string]: unknown };
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
  const linux = options.source.startsWith("linux:");
  if (process.platform !== (linux ? "linux" : "darwin"))
    throw new UsageError(
      linux ? "Native Linux scan requires a Linux host." : "Native macOS scan requires a macOS host.",
    );
  const executable = options.agent ?? process.env.VLMKIT_NATIVE_AGENT;
  if (!executable)
    throw new UsageError(
      linux
        ? "Set --native-agent (or VLMKIT_NATIVE_AGENT) to native/linux/observer.py. See native/linux/README.md for runtime dependencies."
        : "Set --native-agent (or VLMKIT_NATIVE_AGENT) to VLMKitNativeAgent.app/Contents/MacOS/VLMKitNativeAgent. Build with native/macos/script/build_and_run.sh --build-only.",
    );
  const target = linux ? linuxTarget(options.source, options.launch) : macTarget(options.source, options.launch);
  const selector = macWindow(options.window);
  const client = new NativeAgentClient(executable, options.timeout);
  let sessionId: string | undefined;
  try {
    const hello = await client.request<{
      protocol: number;
      platform?: string;
      backend?: string;
      capabilities?: {
        accessibility?: boolean;
        screenCapture?: boolean;
        physicalPointer?: boolean;
        physicalKeyboard?: boolean;
      };
    }>("hello");
    if (hello.protocol !== 1)
      throw new NativeAgentError("NATIVE_PROTOCOL_MISMATCH", "agent does not support protocol 1");
    if (
      linux &&
      (hello.platform !== "linux" ||
        hello.backend !== "x11" ||
        hello.capabilities?.physicalPointer !== false ||
        hello.capabilities?.physicalKeyboard !== false)
    )
      throw new NativeAgentError("NATIVE_PROTOCOL_MISMATCH", "Expected Linux X11 observer-only capabilities.");
    const doctor = await client.request<{
      accessibility: { trusted?: boolean; available?: boolean };
      screenCapture: { authorized?: boolean; available?: boolean };
    }>("doctor", { prompt: false });
    if (!(linux ? doctor.accessibility.available : doctor.accessibility.trusted))
      throw new NativeAgentError(
        "NATIVE_PERMISSION_ACCESSIBILITY",
        linux
          ? "Linux AT-SPI is unavailable. Run the observer in the target app’s accessible desktop session; see native/linux/README.md."
          : "Allow the observer in System Settings > Privacy & Security > Accessibility.",
      );
    if (!(linux ? doctor.screenCapture.available : doctor.screenCapture.authorized))
      throw new NativeAgentError(
        "NATIVE_PERMISSION_SCREEN_CAPTURE",
        linux
          ? "Linux X11 selected-window capture is unavailable; Wayland is not admitted by this observer."
          : "Allow the observer in System Settings > Privacy & Security > Screen Recording.",
      );
    ({ sessionId } = await client.request<{ sessionId: string }>("target.open", { target }));
    const deadline = Date.now() + (options.timeout ?? 30000);
    let window: { windowId: string };
    while (true) {
      try {
        window = await client.request<{ windowId: string }>("window.select", { sessionId, selector });
        break;
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
    const agentCapture = await client.request<Omit<NativeCaptureResult, "contentPolicy">>("snapshot.capture", {
      sessionId,
      windowId: window.windowId,
      outputTreePath: resolve(options.out),
      outputPngPath: resolve(options.frame),
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
      tree.platform !== (linux ? "linux" : "macos") ||
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
    if (
      linux &&
      (capture.backend !== "x11" ||
        capture.frameKind !== "client-window" ||
        target.by !== "pid" ||
        capture.identity?.pid !== target.pid ||
        capture.identity?.windowId !== window.windowId)
    )
      throw new NativeAgentError(
        "NATIVE_TARGET_MISMATCH",
        "Linux capture must retain the selected process/window identity.",
      );
    return { tree, capture };
  } finally {
    if (sessionId) await client.request("session.close", { sessionId }).catch(() => {});
    client.close();
  }
}
