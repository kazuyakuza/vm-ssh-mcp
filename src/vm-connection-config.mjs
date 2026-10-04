const DEFAULTS = Object.freeze({
  sshHost: "127.0.0.1",
  sshPort: 3022,
  sshUser: "alpine",
  vboxName: "alpine-virt-3.21.2-x86_64",
  vboxManagePath: "",
  allowedPrefixes: "docker,sh,apk,ls,cat,ps,df,free,uname,pwd,whoami",
  commandTimeoutMs: 30000,
  sshReadyTimeoutMs: 5000,
});

const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;

const parsePositiveInteger = (value, variableName) => {
  const parsed = Number(value);
  if (isPositiveInteger(parsed)) {
    return parsed;
  }
  throw new Error(`${variableName} must be a positive integer, received '${value}'`);
};

const requireSshPassword = (environment) => {
  const password = environment.VM_SSH_PASSWORD;
  if (password) {
    return password;
  }
  throw new Error("VM_SSH_PASSWORD is required — set it in the MCP environment configuration");
};

const parseAllowedPrefixes = (rawPrefixes) =>
  rawPrefixes
    .split(",")
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix.length > 0);

export const createVmConnectionConfig = (environment = process.env) =>
  Object.freeze({
    sshHost: environment.VM_SSH_HOST ?? DEFAULTS.sshHost,
    sshPort: parsePositiveInteger(environment.VM_SSH_PORT ?? DEFAULTS.sshPort, "VM_SSH_PORT"),
    sshUser: environment.VM_SSH_USER ?? DEFAULTS.sshUser,
    sshPassword: requireSshPassword(environment),
    vboxName: environment.VM_VBOX_NAME ?? DEFAULTS.vboxName,
    vboxManagePath: environment.VM_VBOX_MANAGE_PATH ?? DEFAULTS.vboxManagePath,
    allowedPrefixes: Object.freeze(
      parseAllowedPrefixes(environment.VM_ALLOWED_PREFIXES ?? DEFAULTS.allowedPrefixes),
    ),
    commandTimeoutMs: parsePositiveInteger(
      environment.VM_COMMAND_TIMEOUT_MS ?? DEFAULTS.commandTimeoutMs,
      "VM_COMMAND_TIMEOUT_MS",
    ),
    sshReadyTimeoutMs: parsePositiveInteger(
      environment.VM_SSH_READY_TIMEOUT_MS ?? DEFAULTS.sshReadyTimeoutMs,
      "VM_SSH_READY_TIMEOUT_MS",
    ),
  });
