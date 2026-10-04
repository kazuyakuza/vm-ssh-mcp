import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WINDOWS_DEFAULT_VBOXMANAGE_PATH =
  "C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe";

const POWEROFF_STATE_TOKENS = ["poweroff", "saved", "aborted", "paused"];

const VM_STATE_LINE_PREFIX = "vmstate=";

export const VBOX_PROBE_TIMEOUT_MS = 5000;

export const resolveVBoxManagePath = (config) => {
  if (config.vboxManagePath) {
    return config.vboxManagePath;
  }
  if (existsSync(WINDOWS_DEFAULT_VBOXMANAGE_PATH)) {
    return WINDOWS_DEFAULT_VBOXMANAGE_PATH;
  }
  return "VBoxManage";
};

const parseVmStateToken = (output) => {
  const vmStateLine = output
    .split(/\r?\n/)
    .find((line) => line.toLowerCase().startsWith(VM_STATE_LINE_PREFIX));
  if (vmStateLine === undefined) {
    return "";
  }
  return vmStateLine.slice(VM_STATE_LINE_PREFIX.length).replaceAll('"', "").trim();
};

const mapVmStateToken = (token) => {
  if (token === "running") {
    return "running";
  }
  if (POWEROFF_STATE_TOKENS.includes(token)) {
    return "poweroff";
  }
  return "unknown";
};

const queryVmStateToken = async (config) => {
  const args = ["showvminfo", config.vboxName, "--machinereadable"];
  const { stdout } = await execFileAsync(resolveVBoxManagePath(config), args, {
    timeout: VBOX_PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  return parseVmStateToken(stdout);
};

export const queryVmState = async (config) => {
  if (!config.vboxName) {
    return "unknown";
  }
  try {
    return mapVmStateToken(await queryVmStateToken(config));
  } catch {
    return "unknown";
  }
};
