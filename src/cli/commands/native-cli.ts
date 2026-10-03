import { isCliEntry } from "@mizchi/vlmkit-core/plugin/cli-entry.ts";
import { handleCliError, UsageError } from "@mizchi/vlmkit-core/cli-error.ts";
import { hasFlag, readFlag, readInt } from "@mizchi/vlmkit-core/arg-reader.ts";
import { BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW } from "@mizchi/vlmkit-core/terminal-colors.ts";
import { runNativeDoctor } from "@mizchi/vlmkit-markup/a11y-tree/native-agent.ts";

export function nativeDoctorUsage(): string {
  return [
    "Usage:",
    "  vlmkit native doctor [--native-agent path] [--prompt] [--timeout ms] [--json]",
    "",
    "Diagnose the local macOS AX / ScreenCaptureKit sidecar without opening a target app.",
    "By default this is passive and never requests TCC permission prompts.",
    "",
    "Options:",
    "  --native-agent <path>  Native agent executable (or VLMKIT_NATIVE_AGENT)",
    "  --prompt               Explicitly allow the doctor request to prompt for permissions",
    "  --timeout <ms>         Protocol timeout (default 30000)",
    "  --json                 Print the raw machine-readable result",
  ].join("\n");
}

export async function runNativeDoctorCli(argv: readonly string[]): Promise<number> {
  if (hasFlag(argv, "help") || hasFlag(argv, "h")) {
    console.log(nativeDoctorUsage());
    return 0;
  }
  const allowed = new Set(["--native-agent", "--prompt", "--timeout", "--json"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("-")) throw new UsageError(`unexpected argument: ${arg}\n\n${nativeDoctorUsage()}`);
    if (!allowed.has(arg)) throw new UsageError(`unknown option: ${arg}\n\n${nativeDoctorUsage()}`);
    if (arg === "--native-agent" || arg === "--timeout") i++;
  }
  const result = await runNativeDoctor({
    agent: readFlag(argv, "native-agent"),
    prompt: hasFlag(argv, "prompt"),
    timeout: readInt(argv, "timeout", { min: 1 }) ?? 30000,
  });
  const ok = result.doctor.accessibility.trusted && result.doctor.screenCapture.authorized;
  if (hasFlag(argv, "json")) {
    console.log(JSON.stringify({ ok, ...result }, null, 2));
    return ok ? 0 : 1;
  }

  console.log("");
  console.log(`${BOLD}${CYAN}Native Doctor${RESET}`);
  console.log(`  ${DIM}protocol ${result.hello.protocol}${result.hello.agentVersion ? ` · agent ${result.hello.agentVersion}` : ""}${RESET}`);
  const line = (label: string, pass: boolean) =>
    console.log(`  ${pass ? GREEN : RED}${pass ? "PASS" : "FAIL"}${RESET} ${label}`);
  line("Accessibility permission", result.doctor.accessibility.trusted);
  line("Screen Recording permission", result.doctor.screenCapture.authorized);
  for (const check of result.doctor.checks ?? []) {
    const color = check.status === "pass" ? GREEN : check.status === "warn" ? YELLOW : RED;
    console.log(`  ${color}${check.status.toUpperCase()}${RESET} ${check.id}: ${check.message}`);
  }
  console.log("");
  return ok ? 0 : 1;
}

if (isCliEntry(import.meta.url, "native-doctor")) {
  runNativeDoctorCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(handleCliError);
}
