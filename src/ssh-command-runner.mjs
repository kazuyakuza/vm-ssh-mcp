import { Client } from "ssh2";

const FALLBACK_OUTPUT_LIMIT_CHARS = 10000;

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

const createCapture = (limit) => ({
  limit,
  channels: {
    stdout: { value: "", truncated: false },
    stderr: { value: "", truncated: false },
  },
  sequence: [],
});

const recordChunk = (capture, channel, chunk) => {
  const target = capture.channels[channel];
  if (target.truncated || chunk.length === 0) {
    return;
  }
  const remaining = capture.limit - target.value.length;
  const kept = chunk.length <= remaining ? chunk : chunk.slice(0, remaining);
  target.value += kept;
  if (kept.length < chunk.length) {
    target.truncated = true;
  }
  capture.sequence.push(kept);
};

const buildOutcome = (capture, { code, timedOut = false }) => ({
  exitCode: timedOut ? null : resolveExitCode(code),
  timedOut,
  stdout: capture.channels.stdout.value,
  stderr: capture.channels.stderr.value,
  combinedOutput: capture.sequence.join(""),
  stdoutTruncated: capture.channels.stdout.truncated,
  stderrTruncated: capture.channels.stderr.truncated,
  outputLimitChars: capture.limit,
});

const attachStreamCapture = (capture, stream) => {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => recordChunk(capture, "stdout", chunk));
  if (stream.stderr) {
    stream.stderr.setEncoding("utf8");
    stream.stderr.on("data", (chunk) => recordChunk(capture, "stderr", chunk));
  }
};

const handleExecOpened = ({ connection, settlers, config, capture, error, stream }) => {
  if (error) {
    connection.end();
    settlers.reject(mapConnectionError(error, config));
    return;
  }
  attachStreamCapture(capture, stream);
  stream.on("close", (code) => {
    connection.end();
    settlers.resolve(buildOutcome(capture, { code }));
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

export const runSshCommand = (config, command, { clientFactory = () => new Client() } = {}) =>
  new Promise((resolve, reject) => {
    const connection = clientFactory();
    const capture = createCapture(config.outputLimitChars ?? FALLBACK_OUTPUT_LIMIT_CHARS);
    const guard = setTimeout(() => {
      connection.end();
      settlers.resolve(buildOutcome(capture, { code: null, timedOut: true }));
    }, config.commandTimeoutMs);
    const settlers = createSettlers({ guard, resolve, reject });
    attachConnectionHandlers({ connection, config, command, capture, settlers });
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
