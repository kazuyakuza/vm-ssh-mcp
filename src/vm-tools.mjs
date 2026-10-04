import { isCommandAllowed } from "./command-policy.mjs";
import { queryVmState } from "./vm-state-probe.mjs";
import { probeSsh, runSshCommand } from "./ssh-command-runner.mjs";

const OUTPUT_LIMIT = 10000;

const textResult = (text, isError = false) => ({
  content: [{ type: "text", text }],
  isError,
});

const buildRunningMessage = (sshReachable, config) => {
  if (sshReachable) {
    return `SSH reachable on ${config.sshHost}:${config.sshPort} — ready for commands.`;
  }
  return `VM '${config.vboxName}' is running but SSH is not reachable on ${config.sshHost}:${config.sshPort}.`;
};

const buildStatusReport = async (config) => {
  const vmState = await queryVmState(config);
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
  const sshReachable = await probeSsh(config);
  return { vmState, sshReachable, message: buildRunningMessage(sshReachable, config) };
};

const formatStatusText = (report) =>
  `vmState: ${report.vmState} | sshReachable: ${report.sshReachable}\n${report.message}`;

export const createVmStatusTool = (config) => async () => {
  const report = await buildStatusReport(config);
  return textResult(formatStatusText(report));
};

const findGateFailure = async (args, config) => {
  const vmState = await queryVmState(config);
  if (vmState !== "running") {
    return "VM not running — run vm_status for details and start the VM in VirtualBox first.";
  }
  const sshReachable = await probeSsh(config);
  if (!sshReachable) {
    return `SSH not reachable on ${config.sshHost}:${config.sshPort}.`;
  }
  if (isCommandAllowed(args.command, config.allowedPrefixes)) {
    return undefined;
  }
  return `Command rejected: '${args.command}' does not match allowed prefixes [${config.allowedPrefixes.join(", ")}].`;
};

const truncateOutput = (output) => {
  if (output.length <= OUTPUT_LIMIT) {
    return output;
  }
  return `${output.slice(0, OUTPUT_LIMIT)}… [truncated]`;
};

const reportOutcome = (outcome) => {
  const text = [
    `exit code: ${outcome.exitCode}`,
    "stdout:",
    truncateOutput(outcome.stdout),
    "stderr:",
    truncateOutput(outcome.stderr),
  ].join("\n");
  return textResult(text, outcome.exitCode !== 0);
};

const executeAllowedCommand = async (args, config) => {
  const derivedConfig = { ...config, commandTimeoutMs: args.timeoutMs ?? config.commandTimeoutMs };
  try {
    const outcome = await runSshCommand(derivedConfig, args.command);
    return reportOutcome(outcome);
  } catch (error) {
    return textResult(`Command failed after start: ${error.message}`, true);
  }
};

export const createVmRunCommandTool = (config) => async (args) => {
  const gateFailure = await findGateFailure(args, config);
  if (gateFailure) {
    return textResult(gateFailure, true);
  }
  return executeAllowedCommand(args, config);
};
