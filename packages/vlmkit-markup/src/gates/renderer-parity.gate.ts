/**
 * `check renderer-parity` compares a real reference renderer with a generated
 * candidate through the gallery's explicit mount contract.
 */

import { join } from "node:path";
import { readFlag } from "@mizchi/vlmkit-core/arg-reader.ts";
import { UsageError } from "@mizchi/vlmkit-core/cli-error.ts";
import { PAGE_LOAD_INPUTS, parsePageLoad } from "@mizchi/vlmkit-core/page-load.ts";
import { defineGate } from "@mizchi/vlmkit-core/plugin/contract.ts";
import type { Finding } from "@mizchi/vlmkit-core/plugin/contract.ts";
import {
  formatRendererParityReport,
  runRendererParity,
  type RendererParityOptions,
  type RendererParityReport,
} from "../component/renderer-parity.ts";

export const rendererParityGate = defineGate<RendererParityReport, RendererParityOptions>({
  id: "check.renderer-parity",
  command: ["check", "renderer-parity"],
  title: "Cross-renderer component parity",
  summary: "Compare actual reference and generated component renders across declared viewports and interactions",
  category: "behavior",
  usage: `Runs the gallery's real reference implementation and generated candidate
independently at every declared viewport and interaction state. The gallery
must expose window.mountParity({caseId,source}) / window.unmountParity(), with
one [data-parity-root][data-case-id][data-source] mounted at a time. The gate
compares exact PNG pixels, every computed style, relative layout, DOM/ARIA
semantics, and declared focus/hover/click/fill outcomes. Missing cases, empty
captures, or mismatched dimensions fail the gate.

The manifest is the scope of the guarantee: only its component cases, states,
and viewports are covered. No model API or secret is used.

  vlmkit check renderer-parity --manifest fixtures/kumo-cases.json --gallery http://localhost:4173/parity
`,
  rules: [
    {
      id: "coverage-incomplete",
      title: "Parity manifest or gallery contract is incomplete",
      severity: "suspect",
      docs: "Declare nonempty cases and viewports; the gallery must implement mountParity/unmountParity and mount the requested case/source.",
    },
    {
      id: "capture-failed",
      title: "Reference or candidate could not be captured",
      severity: "suspect",
      docs: "A missing, empty, zero-sized, or unreadable capture is a failed measurement.",
    },
    {
      id: "interaction-failed",
      title: "Declared interaction did not produce its required state",
      severity: "suspect",
      docs: "Action targets must be marked with data-parity-target and satisfy the declared expectation.",
    },
    {
      id: "renderer-drift",
      title: "Reference and candidate renderers differ",
      severity: "suspect",
      docs: "Any pixel, computed-style, layout, DOM/ARIA, or interaction-event difference fails this deterministic parity gate.",
    },
  ],
  inputs: [
    {
      name: "manifest",
      placeholder: "json",
      kind: "path",
      description: "Canonical manifest listing supported component cases, states, and viewports",
      required: true,
    },
    {
      name: "gallery",
      placeholder: "url",
      kind: "path-or-url",
      description: "Gallery URL exposing the parity mount contract",
      required: true,
    },
    {
      name: "out",
      placeholder: "dir",
      kind: "path",
      description: "Directory for per-state PNG, DOM/ARIA, diff, and JSON report artifacts",
      defaultDescription: "test-results/renderer-parity",
    },
    ...PAGE_LOAD_INPUTS,
  ],
  parse: (argv) => {
    const manifestPath = readFlag(argv, "manifest");
    if (!manifestPath) {
      throw new UsageError("--manifest <json> is required; use the gallery's canonical case manifest");
    }
    const gallery = readFlag(argv, "gallery");
    if (!gallery) throw new UsageError("--gallery <url> is required; serve the project's parity gallery first");
    return {
      manifestPath,
      gallery,
      outputDir: readFlag(argv, "out") ?? join(process.cwd(), "test-results", "renderer-parity"),
      ...parsePageLoad(argv),
    };
  },
  run: (options) => runRendererParity(options),
  findings: (report): Finding[] =>
    report.failures.map((failure) => ({
      rule: failure.rule,
      severity: "suspect",
      message: failure.message,
      ...(failure.caseId ? { selector: `[data-case-id="${failure.caseId}"]` } : {}),
      ...(failure.evidence ? { evidence: failure.evidence } : {}),
    })),
  format: (report, rules) => formatRendererParityReport(report, rules),
  ledger: (report, options) => ({
    tool: "check-renderer-parity",
    source: options.gallery,
    headline: {
      ok: report.ok,
      cases: report.cases,
      viewports: report.viewports,
      comparisons: report.comparisons.length,
      failures: report.failures.length,
      kumoVersion: report.kumoVersion ?? null,
      report: report.reportPath,
    },
  }),
});
