import { Client } from "ssh2";

const buildConnectOptions = (config) => ({
  host: config.sshHost,
  port: config.sshPort,
  username: config.sshUser,
  password: config.sshPassword,
  readyTimeout: config.sshReadyTimeoutMs,
});

const mapConnectionError = (error, config) => {
  if (error.code === "ECONNREFUSED") {
    return new Error(`SSH not reachable on ${config.sshHost}:${config.sshPort}`);
  }
  return new Error(`SSH connection failed: ${error.message}`);
};

const resolveExitCode = (code) => (code === null ? 1 : code);

const createSettlers = ({ guard, resolve, reject }) => ({
  resolve: (value) => {
    clearTimeout(guard);
    resolve(value);
  },
  reject: (reason) => {
    clearTimeout(guard);
    reject(reason);
  },
});

const buildOutcome = ({ buffers, code }) => ({
  stdout: Buffer.concat(buffers.stdout).toString("utf8"),
  stderr: Buffer.concat(buffers.stderr).toString("utf8"),
  exitCode: resolveExitCode(code),
});

const handleExecOpened = ({ connection, settlers, config, error, stream }) => {
  if (error) {
    connection.end();
    settlers.reject(mapConnectionError(error, config));
    return;
  }
  const buffers = { stdout: [], stderr: [] };
  stream.on("data", (chunk) => buffers.stdout.push(chunk));
  stream.on("stderr", (chunk) => buffers.stderr.push(chunk));
  stream.on("close", (code) => {
    connection.end();
    settlers.resolve(buildOutcome({ buffers, code }));
  });
};

const startExec = (context) => {
  context.connection.exec(context.command, { pty: false }, (error, stream) =>
    handleExecOpened({ ...context, error, stream }),
  );
};

const rejectConnection = (context) => {
  context.connection.end();
  context.settlers.reject(mapConnectionError(context.error, context.config));
};

const attachConnectionHandlers = (context) => {
  context.connection.on("ready", () => startExec(context));
  context.connection.on("error", (error) => rejectConnection({ ...context, error }));
};

export const runSshCommand = (config, command) =>
  new Promise((resolve, reject) => {
    const connection = new Client();
    const guard = setTimeout(() => {
      connection.end();
      reject(new Error(`Command timed out after ${config.commandTimeoutMs} ms`));
    }, config.commandTimeoutMs);
    const settlers = createSettlers({ guard, resolve, reject });
    attachConnectionHandlers({ connection, config, command, settlers });
    connection.connect(buildConnectOptions(config));
  });

const isCleanEcho = (outcome) => outcome.exitCode === 0 && outcome.stdout.trim() === "ok";

export const probeSsh = async (config) => {
  try {
    const outcome = await runSshCommand(config, "echo ok");
    return isCleanEcho(outcome);
  } catch {
    return false;
  }
};
