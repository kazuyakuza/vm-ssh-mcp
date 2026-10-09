import { test } from "node:test";
import assert from "node:assert/strict";
import { createVmRunCommandTool, createVmStatusTool } from "../src/vm-tools.mjs";

const baseConfig = () => ({
  sshHost: "127.0.0.1",
  sshPort: 3022,
  sshUser: "alpine",
  sshPassword: "alpine",
  sshReadyTimeoutMs: 5000,
  commandTimeoutMs: 30000,
  outputLimitChars: 10000,
  vboxName: "alpine-virt-3.21.2-x86_64",
  vboxManagePath: "",
  allowedPrefixes: ["docker", "sh", "uname"],
});

const outcome = (overrides = {}) => ({
  exitCode: 0,
  timedOut: false,
  stdout: "out\n",
  stderr: "",
  combinedOutput: "out\n",
  stdoutTruncated: false,
  stderrTruncated: false,
  outputLimitChars: 10000,
  ...overrides,
});

const deps = (overrides = {}) => ({
  queryVmState: async () => "running",
  probeSsh: async () => true,
  runSshCommand: async () => outcome(),
  ...overrides,
});

test("returns structuredContent plus a text fallback on a successful command", async () => {
  const tool = createVmRunCommandTool(baseConfig(), deps());
  const result = await tool({ command: "uname -a" });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, {
    exitCode: 0,
    stdout: "out\n",
    stderr: "",
    combinedOutput: "out\n",
    stdoutTruncated: false,
    stderrTruncated: false,
    outputLimitChars: 10000,
    timedOut: false,
  });
  const text = result.content[0].text;
  assert.match(text, /^exit code: 0\nstdout:\nout\n\nstderr:\n<empty>/);
  assert.match(text, /combined output:\nout/);
});

test("flags isError and keeps structured output when the exit code is non-zero", async () => {
  const tool = createVmRunCommandTool(
    baseConfig(),
    deps({ runSshCommand: async () => outcome({ exitCode: 3, stderr: "err\n", combinedOutput: "err\n" }) }),
  );
  const result = await tool({ command: "sh -c echo" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.exitCode, 3);
  assert.equal(result.structuredContent.stderr, "err\n");
  assert.match(result.content[0].text, /exit code: 3/);
});

test("renders a truncation notice inside the affected channel", async () => {
  const tool = createVmRunCommandTool(
    baseConfig(),
    deps({
      runSshCommand: async () =>
        outcome({ stdout: "abcd", stdoutTruncated: true, combinedOutput: "abcd" }),
    }),
  );
  const result = await tool({ command: "uname" });
  assert.match(result.content[0].text, /abcd… \[truncated at 10000 chars\]/);
});

test("renders a timeout notice with a null exit code and partial output", async () => {
  const tool = createVmRunCommandTool(
    baseConfig(),
    deps({
      runSshCommand: async () => outcome({ exitCode: null, timedOut: true, stdout: "partial" }),
    }),
  );
  const result = await tool({ command: "uname" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.timedOut, true);
  assert.equal(result.structuredContent.exitCode, null);
  const text = result.content[0].text;
  assert.match(text, /exit code: none/);
  assert.match(text, /command timed out after 30000 ms/);
});

test("passes a per-call timeoutMs override to the runner", async () => {
  let captured;
  const tool = createVmRunCommandTool(
    baseConfig(),
    deps({
      runSshCommand: async (config) => {
        captured = config;
        return outcome();
      },
    }),
  );
  await tool({ command: "uname", timeoutMs: 1234 });
  assert.equal(captured.commandTimeoutMs, 1234);
});

test("rejects when the VM is not running, before executing", async () => {
  let executed = false;
  const tool = createVmRunCommandTool(
    baseConfig(),
    deps({
      queryVmState: async () => "poweroff",
      runSshCommand: async () => {
        executed = true;
        return outcome();
      },
    }),
  );
  const result = await tool({ command: "uname" });
  assert.equal(executed, false);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.equal(
    result.content[0].text,
    "VM not running — run vm_status for details and start the VM in VirtualBox first.",
  );
});

test("rejects when SSH is not reachable, before executing", async () => {
  const tool = createVmRunCommandTool(
    baseConfig(),
    deps({ probeSsh: async () => false }),
  );
  const result = await tool({ command: "uname" });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "SSH not reachable on 127.0.0.1:3022.");
});

test("rejects a command outside the allowlist, before executing", async () => {
  let executed = false;
  const tool = createVmRunCommandTool(
    baseConfig(),
    deps({
      runSshCommand: async () => {
        executed = true;
        return outcome();
      },
    }),
  );
  const result = await tool({ command: "reboot" });
  assert.equal(executed, false);
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "Command rejected: 'reboot' does not match allowed prefixes [docker, sh, uname].",
  );
});

test("reports a failure that happens after the channel started", async () => {
  const tool = createVmRunCommandTool(
    baseConfig(),
    deps({
      runSshCommand: async () => {
        throw new Error("socket closed");
      },
    }),
  );
  const result = await tool({ command: "uname" });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "Command failed after start: socket closed");
});

test("vm_status formats the running/SSH-up report", async () => {
  const tool = createVmStatusTool(baseConfig(), deps());
  const result = await tool();
  assert.equal(
    result.content[0].text,
    "vmState: running | sshReachable: true\nSSH reachable on 127.0.0.1:3022 — ready for commands.",
  );
});

test("vm_status formats the powered-off report", async () => {
  const tool = createVmStatusTool(baseConfig(), deps({ queryVmState: async () => "poweroff" }));
  const result = await tool();
  assert.equal(
    result.content[0].text,
    "vmState: poweroff | sshReachable: false\nVM 'alpine-virt-3.21.2-x86_64' is not running — start it in VirtualBox first.",
  );
});
