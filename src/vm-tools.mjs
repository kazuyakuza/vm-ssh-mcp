import { isCommandAllowed } from "./command-policy.mjs";
import { queryVmState } from "./vm-state-probe.mjs";
import { probeSsh, runSshCommand } from "./ssh-command-runner.mjs";

const EMPTY_MARKER = "<empty>";

const DEFAULT_DEPS = Object.freeze({ queryVmState, probeSsh, runSshCommand });

const textResult = (text, isError = false) => ({
  content: [{ type: "text", text }],
  isError,
});

const structuredResult = (text, structuredContent, isError) => ({
  content: [{ type: "text", text }],
  structuredContent,
  isError,
});

const buildRunningMessage = (sshReachable, config) => {
  if (sshReachable) {
    return `SSH reachable on ${config.sshHost}:${config.sshPort} — ready for commands.`;
  }
  return `VM '${config.vboxName}' is running but SSH is not reachable on ${config.sshHost}:${config.sshPort}.`;
};

const buildStatusReport = async (config, deps) => {
  const vmState = await deps.queryVmState(config);
  if (vmState === "poweroff") {
    return {
      vmState,
      sshReachable: false,
      message: `VM '${config.vboxName}' is not running — start it in VirtualBox first.`,
    };
  }
  if (vmState === "unknown") {
    return {
      vmState,
      sshReachable: false,
      message: "Could not determine VM state — VBoxManage probe failed or was skipped.",
    };
  }
  const sshReachable = await deps.probeSsh(config);
  return { vmState, sshReachable, message: buildRunningMessage(sshReachable, config) };
};

const formatStatusText = (report) =>
  `vmState: ${report.vmState} | sshReachable: ${report.sshReachable}\n${report.message}`;

export const createVmStatusTool = (config, deps = DEFAULT_DEPS) => async () => {
  const report = await buildStatusReport(config, deps);
  return textResult(formatStatusText(report));
};

const findGateFailure = async (args, config, deps) => {
  const vmState = await deps.queryVmState(config);
  if (vmState !== "running") {
    return "VM not running — run vm_status for details and start the VM in VirtualBox first.";
  }
  const sshReachable = await deps.probeSsh(config);
  if (!sshReachable) {
    return `SSH not reachable on ${config.sshHost}:${config.sshPort}.`;
  }
  if (isCommandAllowed(args.command, config.allowedPrefixes)) {
    return undefined;
  }
  return `Command rejected: '${args.command}' does not match allowed prefixes [${config.allowedPrefixes.join(", ")}].`;
};

const renderChannel = (value, truncated, limit) => {
  if (value.length === 0) {
    return EMPTY_MARKER;
  }
  return truncated ? `${value}… [truncated at ${limit} chars]` : value;
};

const formatOutcomeText = (outcome, config) => {
  const lines = [
    `exit code: ${outcome.exitCode ?? "none"}`,
    "stdout:",
    renderChannel(outcome.stdout, outcome.stdoutTruncated, outcome.outputLimitChars),
    "stderr:",
    renderChannel(outcome.stderr, outcome.stderrTruncated, outcome.outputLimitChars),
    "combined output:",
    renderChannel(outcome.combinedOutput, false, outcome.outputLimitChars),
  ];
  if (outcome.timedOut) {
    lines.push(`command timed out after ${config.commandTimeoutMs} ms — captured partial output above`);
  }
  return lines.join("\n");
};

const buildStructuredContent = (outcome) => ({
  exitCode: outcome.exitCode,
  stdout: outcome.stdout,
  stderr: outcome.stderr,
  combinedOutput: outcome.combinedOutput,
  stdoutTruncated: outcome.stdoutTruncated,
  stderrTruncated: outcome.stderrTruncated,
  outputLimitChars: outcome.outputLimitChars,
  timedOut: outcome.timedOut,
});

const reportOutcome = (outcome, config) =>
  structuredResult(
    formatOutcomeText(outcome, config),
    buildStructuredContent(outcome),
    outcome.exitCode !== 0,
  );

const executeAllowedCommand = async (args, config, deps) => {
  const derivedConfig = { ...config, commandTimeoutMs: args.timeoutMs ?? config.commandTimeoutMs };
  try {
    const outcome = await deps.runSshCommand(derivedConfig, args.command);
    return reportOutcome(outcome, derivedConfig);
  } catch (error) {
    return textResult(`Command failed after start: ${error.message}`, true);
  }
};

export const createVmRunCommandTool = (config, deps = DEFAULT_DEPS) => async (args) => {
  const gateFailure = await findGateFailure(args, config, deps);
  if (gateFailure) {
    return textResult(gateFailure, true);
  }
  return executeAllowedCommand(args, config, deps);
};
