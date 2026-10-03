import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compareScreenshots, generateDiffReport } from "@mizchi/vlmkit-core/heatmap.ts";
import { appendRunLedger } from "@mizchi/vlmkit-core/run-ledger.ts";
import { diffA11yTrees } from "@mizchi/vlmkit-core/a11y-semantic.ts";
import type { A11yNode as CoreA11yNode, A11ySnapshot, VrtSnapshot } from "@mizchi/vlmkit-core/types.ts";
import { UsageError } from "@mizchi/vlmkit-core/cli-error.ts";
import { parseA11yTree, type A11yTree } from "@mizchi/vlmkit-judge/a11y-tree.ts";
import { captureNativeA11y } from "@mizchi/vlmkit-markup/a11y-tree/native-agent.ts";
import { determineSnapshotExitCode } from "../../cli/commands/snapshot.ts";

export interface NativeSnapshotArgs {
  source: string;
  outputDir: string;
  label: string;
  threshold: number;
  failOnDiff: boolean;
  failOnNewBaseline: boolean;
  maxDiffRatio?: number;
  nativeAgent?: string;
  launch: boolean;
  window?: string;
  maxDepth?: number;
  maxNodes?: number;
  timeout?: number;
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) throw new UsageError(`Missing value for ${flag}`);
  return value;
}

function numberAfter(
  argv: readonly string[],
  flag: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  const raw = valueAfter(argv, flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    (options.min !== undefined && value < options.min) ||
    (options.max !== undefined && value > options.max)
  ) {
    throw new UsageError(`Invalid ${flag} value: ${raw}`);
  }
  return value;
}

function nativeDefaultLabel(source: string): string {
  const value = source.slice("macos:".length);
  const base = value.replace(/^pid=/, "pid-").split("/").filter(Boolean).at(-1) ?? "app";
  return (
    base
      .replace(/\.app$/i, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "native"
  );
}

export function parseNativeSnapshotArgs(argv: readonly string[], cwd = process.cwd()): NativeSnapshotArgs {
  const valueFlags = new Set([
    "--output",
    "--output-dir",
    "--label",
    "--threshold",
    "--max-diff-ratio",
    "--native-agent",
    "--window",
    "--max-depth",
    "--max-nodes",
    "--timeout",
  ]);
  const boolFlags = new Set(["--fail-on-diff", "--fail-on-new-baseline", "--launch"]);
  let source: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (valueFlags.has(arg)) {
      if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${arg}`);
      i++;
      continue;
    }
    if (boolFlags.has(arg)) continue;
    if (arg.startsWith("-")) throw new UsageError(`Unsupported native snapshot option: ${arg}`);
    if (arg.startsWith("macos:")) {
      if (source) throw new UsageError("Native snapshot currently accepts exactly one macos: target per run.");
      source = arg;
      continue;
    }
    throw new UsageError(`Unexpected native snapshot argument: ${arg}; expected a macos: target.`);
  }
  if (!source) throw new UsageError("Native snapshot requires a macos:<bundle-id|pid=N|app-path> target.");
  const threshold = numberAfter(argv, "--threshold", { min: 0, max: 1 }) ?? 0.1;
  const maxDiffRatio = numberAfter(argv, "--max-diff-ratio", { min: 0 });
  const maxDepth = numberAfter(argv, "--max-depth", { min: 1 });
  const maxNodes = numberAfter(argv, "--max-nodes", { min: 1 });
  const timeout = numberAfter(argv, "--timeout", { min: 1 });
  return {
    source,
    outputDir: resolve(
      cwd,
      valueAfter(argv, "--output") ?? valueAfter(argv, "--output-dir") ?? "test-results/snapshots",
    ),
    label: valueAfter(argv, "--label") ?? nativeDefaultLabel(source),
    threshold,
    failOnDiff: argv.includes("--fail-on-diff"),
    failOnNewBaseline: argv.includes("--fail-on-new-baseline"),
    ...(maxDiffRatio !== undefined ? { maxDiffRatio } : {}),
    ...(valueAfter(argv, "--native-agent") ? { nativeAgent: valueAfter(argv, "--native-agent") } : {}),
    launch: argv.includes("--launch"),
    ...(valueAfter(argv, "--window") ? { window: valueAfter(argv, "--window") } : {}),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
    ...(maxNodes !== undefined ? { maxNodes } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  };
}

function coreNode(node: A11yTree["nodes"][number]): CoreA11yNode {
  return {
    role: node.role,
    name: node.name ?? "",
    ...(node.identifier ? { id: node.identifier } : {}),
    ...(node.value !== undefined ? { value: node.value } : {}),
    ...(node.states?.checked !== undefined ? { checked: node.states.checked } : {}),
    ...(node.states?.disabled !== undefined ? { disabled: node.states.disabled } : {}),
    ...(node.states?.expanded !== undefined ? { expanded: node.states.expanded } : {}),
    ...(node.states?.selected !== undefined ? { selected: node.states.selected } : {}),
    children: [],
  };
}

export function nativeTreeSnapshot(tree: A11yTree, testId: string): A11ySnapshot {
  const ordered = [...tree.nodes].sort(
    (a, b) => a.path.split(">").length - b.path.split(">").length || a.path.localeCompare(b.path),
  );
  const byPath = new Map<string, CoreA11yNode>();
  const roots: CoreA11yNode[] = [];
  for (const node of ordered) {
    const projected = coreNode(node);
    byPath.set(node.path, projected);
    const cut = node.path.lastIndexOf(">");
    const parent = cut >= 0 ? byPath.get(node.path.slice(0, cut)) : undefined;
    if (parent) {
      (parent.children ??= []).push(projected);
    } else {
      roots.push(projected);
    }
  }
  const treeRoot =
    roots.length === 1 ? roots[0]! : ({ role: "window", name: testId, children: roots } satisfies CoreA11yNode);
  return { testId, testTitle: testId, tree: treeRoot };
}

export async function runNativeSnapshotCli(argv: readonly string[], options: { cwd?: string } = {}): Promise<number> {
  const parsed = parseNativeSnapshotArgs(argv, options.cwd ?? process.cwd());
  await mkdir(parsed.outputDir, { recursive: true });
  const currentPath = join(parsed.outputDir, `${parsed.label}-native-current.png`);
  const treePath = join(parsed.outputDir, `${parsed.label}-native-current.a11y.json`);
  const baselinePath = join(parsed.outputDir, `${parsed.label}-native-baseline.png`);
  const baselineTreePath = join(parsed.outputDir, `${parsed.label}-native-baseline.a11y.json`);

  const captured = await captureNativeA11y({
    source: parsed.source,
    out: treePath,
    frame: currentPath,
    agent: parsed.nativeAgent,
    launch: parsed.launch,
    window: parsed.window,
    maxDepth: parsed.maxDepth,
    maxNodes: parsed.maxNodes,
    timeout: parsed.timeout,
  });

  let hasBaseline = true;
  try {
    await access(baselinePath);
    await access(baselineTreePath);
  } catch {
    hasBaseline = false;
  }

  let diffRatio: number | undefined;
  let semanticDiff: ReturnType<typeof diffA11yTrees> | undefined;
  let globalShift: number | undefined;
  let compensatedDiffRatio: number | undefined;
  let shiftOnly: boolean | undefined;

  if (!hasBaseline) {
    await copyFile(currentPath, baselinePath);
    await copyFile(treePath, baselineTreePath);
  } else {
    const snap: VrtSnapshot = {
      testId: `${parsed.label}-native`,
      testTitle: `${parsed.label} native`,
      projectName: "snapshot-native",
      screenshotPath: currentPath,
      baselinePath,
      status: "changed",
    };
    const visual = await compareScreenshots(snap, { outputDir: parsed.outputDir, threshold: parsed.threshold });
    diffRatio = visual?.diffRatio ?? 0;
    if (diffRatio > 0) {
      const report = await generateDiffReport(snap, {
        outputDir: parsed.outputDir,
        detectShift: true,
        threshold: parsed.threshold,
      });
      if (!report) throw new Error("Native snapshot diff report requires a baseline.");
      globalShift = report.globalShift;
      compensatedDiffRatio = report.compensatedDiffCount / report.totalPixels;
      shiftOnly = report.shiftOnly;
    } else {
      globalShift = 0;
      compensatedDiffRatio = 0;
      shiftOnly = false;
    }
    const baselineTree = parseA11yTree(await readFile(baselineTreePath, "utf8"));
    semanticDiff = diffA11yTrees(
      nativeTreeSnapshot(baselineTree, `${parsed.label}-native`),
      nativeTreeSnapshot(captured.tree, `${parsed.label}-native`),
    );
  }

  const result = {
    url: parsed.source,
    label: parsed.label,
    viewport: "native",
    screenshotPath: currentPath,
    baselinePath,
    a11yPath: treePath,
    baselineA11yPath: baselineTreePath,
    ...(diffRatio !== undefined ? { diffRatio } : {}),
    isNew: !hasBaseline,
    ...(globalShift !== undefined ? { globalShift } : {}),
    ...(compensatedDiffRatio !== undefined ? { compensatedDiffRatio } : {}),
    ...(shiftOnly !== undefined ? { shiftOnly } : {}),
  };
  const exitStatus = determineSnapshotExitCode([result], {
    failOnDiff: parsed.failOnDiff,
    failOnNewBaseline: parsed.failOnNewBaseline,
    maxDiffRatio: parsed.maxDiffRatio,
  });

  appendRunLedger({
    tool: "snapshot-native",
    source: parsed.source,
    headline: {
      verdict: exitStatus.exitCode === 0 ? "clean" : "defects",
      newBaseline: !hasBaseline,
      diffRatio: diffRatio ?? 0,
      a11yChanges: semanticDiff?.changes.length ?? 0,
      a11yRegression: semanticDiff?.hasRegression ?? false,
    },
  });

  await writeFile(
    join(parsed.outputDir, "snapshot-report.json"),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        urls: [parsed.source],
        labels: [parsed.label],
        platform: "macos",
        options: {
          threshold: parsed.threshold,
          failOnDiff: parsed.failOnDiff,
          failOnNewBaseline: parsed.failOnNewBaseline,
          maxDiffRatio: parsed.maxDiffRatio ?? null,
        },
        native: captured.capture,
        a11yDiff: semanticDiff ?? null,
        results: [result],
        exitStatus,
      },
      null,
      2,
    ),
  );

  return exitStatus.exitCode;
}
