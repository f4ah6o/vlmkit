#!/usr/bin/env node

/**
 * Exercise the renderer-parity CLI against real gallery mounts that have one
 * deliberate defect injected into the generated candidate. Every control must
 * exit nonzero and report the specific measurement category it damaged.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    cli: { type: "string" },
    manifest: { type: "string" },
    gallery: { type: "string" },
    out: { type: "string" },
  },
});

for (const option of ["cli", "manifest", "gallery", "out"]) {
  assert.equal(typeof values[option], "string", `--${option} is required`);
}

const cli = resolve(values.cli);
const manifestPath = resolve(values.manifest);
const outputDir = resolve(values.out);
const upstream = new URL(values.gallery);
const canonical = JSON.parse(await readFile(manifestPath, "utf8"));
const button = canonical.cases.find(
  (item) =>
    item.component === "button" &&
    item.props?.disabled !== true &&
    item.interactions?.some((interaction) => interaction.type === "click"),
);
assert.ok(button, "canonical manifest must include an enabled interactive button case");
const input = canonical.cases.find(
  (item) => item.component === "input" && item.interactions?.some((interaction) => interaction.type === "focus"),
);
assert.ok(input, "canonical manifest must include a focusable input case");
const desktop = canonical.viewports.find((viewport) => viewport.id === "desktop") ?? canonical.viewports[0];
assert.ok(desktop, "canonical manifest must include a viewport");

const controls = [
  { name: "style", category: "styleDiffs" },
  { name: "layout", category: "layoutDiffs" },
  { name: "aria", category: "semanticDiffs" },
  { name: "behavior", category: "behaviorDiffs" },
  { name: "caret-style", category: "styleDiffs" },
  { name: "missing-case", rule: "capture-failed" },
  { name: "missing-resource", rule: "capture-failed" },
  { name: "version-mismatch", rule: "coverage-incomplete" },
  { name: "mount-timeout", rule: "capture-failed", timeoutMs: 5_000 },
  { name: "unmount-timeout", rule: "capture-failed", timeoutMs: 5_000 },
  { name: "font-timeout", rule: "capture-failed", timeoutMs: 8_000 },
];

const inlineMutation = (mode, caseId) => `
  (() => {
    const mode = ${JSON.stringify(mode)};
    const caseId = ${JSON.stringify(caseId)};
    const wrapMount = (mount) => {
      if (mount.__rendererParityNegativeControl) return mount;
      const wrapped = async function (request) {
        if (mode === "mount-timeout" && request?.source === "react" && request.caseId === caseId) {
          return await new Promise(() => {});
        }
        const result = await mount.call(this, request);
        if (request?.source !== "moonbit" || request.caseId !== caseId) return result;
        const root = [...document.querySelectorAll("[data-parity-root][data-case-id][data-source]")]
          .find((node) => node.getAttribute("data-case-id") === caseId && node.getAttribute("data-source") === "moonbit");
        const target = root?.querySelector("[data-parity-target]");
        if (!target) throw new Error("negative control could not find the mounted MoonBit target");
        if (mode === "style") target.style.setProperty("color", "rgb(1, 2, 3)", "important");
        if (mode === "layout") target.style.setProperty("transform", "translateY(7px)", "important");
        if (mode === "aria") target.setAttribute("aria-label", "negative control");
        if (mode === "behavior") {
          target.addEventListener("click", () => target.dispatchEvent(new Event("change", { bubbles: true })));
        }
        if (mode === "caret-style" && globalThis.__vlmkitParityCapturePlane === "author-styles") {
          target.style.setProperty("caret-color", "rgb(1, 2, 3)", "important");
        }
        return result;
      };
      Object.defineProperty(wrapped, "__rendererParityNegativeControl", { value: true });
      return wrapped;
    };
    const installWrapper = (name, wrap) => {
      let current = window[name];
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get: () => current,
        set: (callback) => { current = typeof callback === "function" ? wrap(callback) : callback; },
      });
      if (typeof current === "function") current = wrap(current);
    };
    installWrapper("mountParity", wrapMount);
    installWrapper("unmountParity", (unmount) => {
      if (unmount.__rendererParityNegativeControl) return unmount;
      const wrapped = async function (...args) {
        if (mode === "unmount-timeout") return await new Promise(() => {});
        return await unmount.apply(this, args);
      };
      Object.defineProperty(wrapped, "__rendererParityNegativeControl", { value: true });
      return wrapped;
    });
  })();
`;

const server = createServer(async (request, response) => {
  try {
    const requested = new URL(request.url ?? "/", "http://127.0.0.1");
    const mode = requested.searchParams.get("parityNegative");
    if (requested.pathname === "/__renderer_parity_missing__.css") {
      response.writeHead(404, { "content-type": "text/css" });
      response.end("/* deliberate missing-resource control */");
      return;
    }
    requested.searchParams.delete("parityNegative");
    const destination = new URL(`${requested.pathname}${requested.search}`, upstream.origin);
    const upstreamResponse = await fetch(destination, { method: request.method ?? "GET" });
    const headers = new Headers(upstreamResponse.headers);
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    headers.delete("content-encoding");
    const body = Buffer.from(await upstreamResponse.arrayBuffer());
    const contentType = headers.get("content-type") ?? "application/octet-stream";
    if (mode && requested.pathname === upstream.pathname && contentType.includes("text/html")) {
      const html = body.toString("utf8");
      const injected =
        mode === "missing-resource"
          ? '<link rel="stylesheet" href="/__renderer_parity_missing__.css">'
          : mode === "font-timeout"
            ? '<script>Object.defineProperty(document.fonts,"ready",{configurable:true,get(){return new Promise(()=>{});}})</script>'
            : `<script>${inlineMutation(mode, mode === "caret-style" ? input.id : button.id)}</script>`;
      const updated = html.includes("</head>")
        ? html.replace("</head>", `${injected}</head>`)
        : html.replace(/<body(?:\s[^>]*)?>/i, (opening) => `${opening}${injected}`);
      headers.set("content-type", "text/html; charset=utf-8");
      response.writeHead(upstreamResponse.status, Object.fromEntries(headers));
      response.end(updated);
      return;
    }
    response.writeHead(upstreamResponse.status, Object.fromEntries(headers));
    response.end(body);
  } catch (error) {
    response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : String(error));
  }
});

await mkdir(outputDir, { recursive: true });
await new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
assert.ok(address && typeof address === "object", "negative-control proxy failed to bind");
const proxyOrigin = `http://127.0.0.1:${address.port}`;
const galleryPath = upstream.pathname;

function minimalManifest(control) {
  const caseInfo = structuredClone(control.name === "caret-style" ? input : button);
  if (control.name === "missing-case") caseInfo.id = "renderer-parity-intentionally-missing-case";
  if (control.name !== "behavior") caseInfo.interactions = [];
  if (control.name === "behavior") {
    caseInfo.interactions = [
      {
        ...caseInfo.interactions.find((interaction) => interaction.type === "click"),
        expect: { clickCount: 1 },
      },
    ];
  }
  if (control.name === "caret-style") {
    caseInfo.interactions = [input.interactions.find((interaction) => interaction.type === "focus")];
  }
  return {
    schemaVersion: canonical.schemaVersion,
    kumoVersion:
      control.name === "version-mismatch" ? `${canonical.kumoVersion}-negative-control` : canonical.kumoVersion,
    viewports: [desktop],
    cases: [caseInfo],
  };
}

async function runGate(name, manifestFile, controlOutput, expectFailure = true) {
  const gallery = `${proxyOrigin}${galleryPath}?parityNegative=${name}`;
  const result = await new Promise((resolveResult, rejectResult) => {
    const args = [
      cli,
      "check",
      "renderer-parity",
      "--manifest",
      manifestFile,
      "--gallery",
      gallery,
      "--out",
      controlOutput,
    ];
    const selectedControl = controls.find((control) => control.name === name);
    if (selectedControl?.timeoutMs) args.push("--timeout", String(selectedControl.timeoutMs));
    const child = spawn(process.execPath, args, {
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 120_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectResult(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolveResult({ status, signal, stdout, stderr, timedOut });
    });
  });
  await writeFile(`${controlOutput}.stdout.txt`, `${result.stdout}${result.stderr}`);
  assert.equal(result.timedOut, false, `${name}: CLI exceeded the 120-second timeout`);
  assert.equal(result.signal, null, `${name}: CLI was terminated by ${result.signal}`);
  if (expectFailure) {
    assert.notEqual(result.status, 0, `${name}: renderer-parity unexpectedly passed a deliberate mutation`);
  } else {
    assert.equal(result.status, 0, `${name}: renderer-parity unexpectedly rejected a valid navigation trace`);
  }
  return result;
}

try {
  for (const control of controls) {
    const manifestFile = resolve(outputDir, `${control.name}.manifest.json`);
    await writeFile(manifestFile, JSON.stringify(minimalManifest(control), null, 2));
    const controlOutput = resolve(outputDir, control.name);
    await runGate(control.name, manifestFile, controlOutput);
    const report = JSON.parse(await readFile(resolve(controlOutput, "report.json"), "utf8"));
    assert.equal(report.ok, false, `${control.name}: expected a failed report`);
    if (control.category) {
      const values = report.comparisons.flatMap((comparison) => comparison[control.category] ?? []);
      assert.ok(values.length > 0, `${control.name}: report did not record ${control.category}`);
      if (control.name === "caret-style") {
        assert.ok(
          report.comparisons.every((comparison) => comparison.pixel.differentPixels === 0),
          "caret-style: screenshots must remain pixel-identical while original computed caret-color changes",
        );
      }
      console.log(`PASS negative control ${control.name}: ${control.category} detected`);
    } else {
      const failures = report.failures ?? [];
      assert.ok(
        failures.some((failure) => failure.rule === control.rule),
        `${control.name}: expected ${control.rule}`,
      );
      if (control.timeoutMs) {
        assert.ok(
          failures.some(
            (failure) =>
              failure.message.includes(`exceeded its ${control.timeoutMs}ms host deadline`) &&
              failure.evidence?.timeoutMs === control.timeoutMs,
          ),
          `${control.name}: expected a specific host-deadline failure in the report`,
        );
      }
      console.log(`PASS negative control ${control.name}: ${control.rule} detected`);
    }
  }

  const inputTarget = input.interactions.find((interaction) => interaction.type === "focus")?.target;
  assert.ok(inputTarget, "canonical input case must expose a focus target");
  for (const [name, key] of [
    ["key-tab", "Tab"],
    ["key-shift-tab", "Shift+Tab"],
  ]) {
    const navigationCase = structuredClone(input);
    navigationCase.interactions = [
      { type: "focus", target: inputTarget },
      { type: "press", target: inputTarget, value: key },
    ];
    const navigationManifestPath = resolve(outputDir, `${name}.manifest.json`);
    await writeFile(
      navigationManifestPath,
      JSON.stringify(
        {
          schemaVersion: canonical.schemaVersion,
          kumoVersion: canonical.kumoVersion,
          viewports: [desktop],
          cases: [navigationCase],
        },
        null,
        2,
      ),
    );
    const navigationOutput = resolve(outputDir, name);
    await runGate(name, navigationManifestPath, navigationOutput, false);
    const navigationReport = JSON.parse(await readFile(resolve(navigationOutput, "report.json"), "utf8"));
    assert.equal(navigationReport.ok, true, `${key} must compare the full-document keyboard trace`);
    assert.equal(navigationReport.comparisons.length, 3, `${key} control must cover initial, focus, and key states`);
    const keyState = navigationReport.comparisons.find((comparison) => comparison.state.startsWith("step-02-"));
    assert.ok(keyState, `${key} control must record its keyboard state`);
    const domCapture = JSON.parse(await readFile(keyState.referencePath.replace(/\.png$/, ".dom.json"), "utf8"));
    assert.ok(
      domCapture.action.events.some((event) => event.type === "keyup" && event.target.startsWith("document/")),
      `${key}: must retain the off-root keyup target in the event trace`,
    );
    console.log(`PASS positive control ${name}: full-document key trace includes the off-root keyup`);
  }
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

console.log(
  `All ${controls.length} browser-backed negative controls failed closed as expected; Tab and Shift+Tab positive controls passed. Artifacts: ${outputDir}`,
);
