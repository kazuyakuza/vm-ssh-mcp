import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runSshCommand } from "../src/ssh-command-runner.mjs";

class FakeStderr extends EventEmitter {
  setEncoding() {}
}

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new FakeStderr();
  }
  setEncoding() {}
}

class FakeClient {
  constructor(script) {
    this.script = script;
    this.handlers = new Map();
    this.ended = false;
  }
  on(event, handler) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }
  emit(event, ...args) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }
  connect() {
    queueMicrotask(() => {
      if (this.script.connectionError) {
        this.emit("error", this.script.connectionError);
      } else {
        this.emit("ready");
      }
    });
  }
  exec(command, options, callback) {
    this.command = command;
    this.options = options;
    if (this.script.execError) {
      queueMicrotask(() => callback(this.script.execError));
      return;
    }
    const stream = new FakeStream();
    queueMicrotask(() => {
      callback(null, stream);
      this.script.drive?.(stream);
    });
  }
  end() {
    this.ended = true;
  }
}

const baseConfig = (overrides = {}) => ({
  sshHost: "127.0.0.1",
  sshPort: 3022,
  sshUser: "alpine",
  sshPassword: "alpine",
  sshReadyTimeoutMs: 5000,
  commandTimeoutMs: 1000,
  outputLimitChars: 10000,
  ...overrides,
});

const runWith = (script, config = baseConfig()) => {
  const client = new FakeClient(script);
  const promise = runSshCommand(config, "test command", { clientFactory: () => client });
  return { client, promise };
};

test("captures stdout, stderr and exit code", async () => {
  const script = {
    drive: (stream) => {
      stream.stderr.emit("data", "err line\n");
      stream.emit("data", "out line\n");
      stream.emit("close", 0);
    },
  };
  const { promise } = runWith(script);
  const outcome = await promise;
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.stdout, "out line\n");
  assert.equal(outcome.stderr, "err line\n");
  assert.equal(outcome.combinedOutput, "err line\nout line\n");
  assert.equal(outcome.stdoutTruncated, false);
  assert.equal(outcome.stderrTruncated, false);
  assert.equal(outcome.outputLimitChars, 10000);
});

test("captures stderr-only output (the regression this fix targets)", async () => {
  const script = {
    drive: (stream) => {
      stream.stderr.emit("data", "err 1>&2\n");
      stream.emit("close", 3);
    },
  };
  const { promise } = runWith(script);
  const outcome = await promise;
  assert.equal(outcome.exitCode, 3);
  assert.equal(outcome.stdout, "");
  assert.equal(outcome.stderr, "err 1>&2\n");
  assert.equal(outcome.combinedOutput, "err 1>&2\n");
});

test("caps each channel at outputLimitChars and flags truncation", async () => {
  const script = {
    drive: (stream) => {
      stream.emit("data", "abcdef");
      stream.stderr.emit("data", "ghijkl");
      stream.emit("close", 0);
    },
  };
  const { promise } = runWith(script, baseConfig({ outputLimitChars: 4 }));
  const outcome = await promise;
  assert.equal(outcome.stdout, "abcd");
  assert.equal(outcome.stdoutTruncated, true);
  assert.equal(outcome.stderr, "ghij");
  assert.equal(outcome.stderrTruncated, true);
  assert.equal(outcome.combinedOutput, "abcdghij");
  assert.equal(outcome.outputLimitChars, 4);
});

test("resolves partial capture on timeout instead of rejecting", async () => {
  const script = {
    drive: (stream) => {
      stream.emit("data", "partial");
    },
  };
  const { client, promise } = runWith(script, baseConfig({ commandTimeoutMs: 25 }));
  const outcome = await promise;
  assert.equal(outcome.exitCode, null);
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.stdout, "partial");
  assert.equal(client.ended, true);
});

test("rejects with the mapped message when the connection is refused", async () => {
  const script = { connectionError: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) };
  const { promise } = runWith(script);
  await assert.rejects(promise, /SSH not reachable on 127\.0\.0\.1:3022/);
});

test("rejects with the mapped message when exec fails after connect", async () => {
  const script = { execError: new Error("exec boom") };
  const { promise } = runWith(script);
  await assert.rejects(promise, /SSH connection failed: exec boom/);
});

test("maps a null exit code to 1 (killed by signal)", async () => {
  const script = {
    drive: (stream) => {
      stream.emit("close", null);
    },
  };
  const { promise } = runWith(script);
  const outcome = await promise;
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.timedOut, false);
});

test("runs the exec channel without a PTY", async () => {
  const script = {
    drive: (stream) => {
      stream.emit("close", 0);
    },
  };
  const { client, promise } = runWith(script);
  await promise;
  assert.equal(client.command, "test command");
  assert.deepEqual(client.options, { pty: false });
});
