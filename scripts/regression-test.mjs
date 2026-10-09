import { spawn } from "node:child_process";

const REQUEST_TIMEOUT_MS = 30000;

const EXPECTED_TOOL_NAMES = ["vm_status", "vm_run_command"];

const buildChildEnvironment = () => ({
  ...process.env,
  VM_SSH_PASSWORD: process.env.VM_SSH_PASSWORD ?? "alpine",
  VM_SSH_READY_TIMEOUT_MS: process.env.VM_SSH_READY_TIMEOUT_MS ?? "4000",
});

const spawnServer = () =>
  spawn(process.execPath, ["src/server.mjs"], {
    cwd: process.cwd(),
    env: buildChildEnvironment(),
    stdio: ["pipe", "pipe", "inherit"],
  });

const createRpcClient = (child) => {
  const results = new Map();
  const waiters = new Map();
  let remainder = "";
  child.stdout.setEncoding("utf8");
  child.stdin.on("error", () => undefined);
  const settle = (id, value) => {
    const waiter = waiters.get(id);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiters.delete(id);
      waiter.resolve(value);
    }
  };
  child.stdout.on("data", (chunk) => {
    const lines = (remainder + chunk).split(/\r?\n/);
    remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === undefined) {
        continue;
      }
      const value =
        message.error !== undefined ? { jsonRpcError: message.error } : (message.result ?? {});
      results.set(message.id, value);
      settle(message.id, value);
    }
  });
  const request = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`request ${id} (${method}) timed out after ${REQUEST_TIMEOUT_MS} ms`));
      }, REQUEST_TIMEOUT_MS);
      waiters.set(id, { resolve, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  return { request, notify, results };
};

const readText = (result) => result?.content?.[0]?.text ?? "";
const readStructured = (result) => result?.structuredContent;

const REGRESSION_COMMANDS = [
  {
    id: 4,
    label: "stderr-only (exit 3)      ",
    args: { command: 'sh -c "echo err 1>&2; exit 3"' },
    verify: (result) => {
      const outcome = readStructured(result);
      const failures = [];
      if (outcome === undefined) {
        return ["no structuredContent"];
      }
      if (outcome.exitCode !== 3) failures.push(`exitCode ${outcome.exitCode} !== 3`);
      if (outcome.stderr.trim() !== "err") failures.push(`stderr ${JSON.stringify(outcome.stderr)}`);
      if (outcome.combinedOutput.trim() !== "err") {
        failures.push(`combinedOutput ${JSON.stringify(outcome.combinedOutput)}`);
      }
      if (result.isError !== true) failures.push("isError not true");
      return failures;
    },
  },
  {
    id: 5,
    label: "stdout + stderr (exit 0)  ",
    args: { command: 'sh -c "echo out; echo err 1>&2"' },
    verify: (result) => {
      const outcome = readStructured(result);
      const failures = [];
      if (outcome === undefined) {
        return ["no structuredContent"];
      }
      if (outcome.exitCode !== 0) failures.push(`exitCode ${outcome.exitCode} !== 0`);
      if (outcome.stdout.trim() !== "out") failures.push(`stdout ${JSON.stringify(outcome.stdout)}`);
      if (outcome.stderr.trim() !== "err") failures.push(`stderr ${JSON.stringify(outcome.stderr)}`);
      if (!outcome.combinedOutput.includes("out") || !outcome.combinedOutput.includes("err")) {
        failures.push(`combinedOutput ${JSON.stringify(outcome.combinedOutput)}`);
      }
      if (result.isError === true) failures.push("unexpected isError");
      return failures;
    },
  },
  {
    id: 6,
    label: "long output (truncated)   ",
    args: { command: 'sh -c "seq 1 5000"' },
    verify: (result) => {
      const outcome = readStructured(result);
      const failures = [];
      if (outcome === undefined) {
        return ["no structuredContent"];
      }
      if (outcome.exitCode !== 0) failures.push(`exitCode ${outcome.exitCode} !== 0`);
      if (outcome.stdoutTruncated !== true) failures.push("stdoutTruncated not true");
      if (outcome.stdout.length !== outcome.outputLimitChars) {
        failures.push(`stdout length ${outcome.stdout.length} !== limit ${outcome.outputLimitChars}`);
      }
      if (outcome.combinedOutput.length === 0) failures.push("combinedOutput empty");
      return failures;
    },
  },
];

const verdict = (passed) => (passed ? "PASS" : "FAIL");

const reportHandshake = (init, toolNames, statusText) => {
  const serverName = init?.serverInfo?.name ?? "";
  const toolsPassed = EXPECTED_TOOL_NAMES.every((name) => toolNames.includes(name));
  const statusPassed = statusText.length > 0;
  console.log(`initialize -> serverInfo.name "${serverName}" [${verdict(serverName === "vm-ssh-mcp")}]`);
  console.log(`tools/list -> [${toolNames.join(", ")}] [${verdict(toolsPassed)}]`);
  console.log(`vm_status  -> ${statusText.split("\n").join(" | ")} [${verdict(statusPassed)}]`);
  return toolsPassed;
};

const runRegressions = async (client) => {
  const outstanding = REGRESSION_COMMANDS.map((spec) =>
    client
      .request(spec.id, "tools/call", { name: "vm_run_command", arguments: spec.args })
      .then((result) => ({ spec, result })),
  );
  const settled = await Promise.all(outstanding);
  return settled.map(({ spec, result }) => {
    if (result?.jsonRpcError !== undefined) {
      return { label: spec.label, failures: [`jsonrpc error ${JSON.stringify(result.jsonRpcError)}`] };
    }
    return { label: spec.label, failures: spec.verify(result) };
  });
};

const main = async () => {
  const child = spawnServer();
  let exitCode = 1;
  try {
    const client = createRpcClient(child);
    const init = await client.request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vm-ssh-mcp-regression", version: "0.2.0" },
    });
    client.notify("notifications/initialized", {});
    const toolsList = await client.request(2, "tools/list", {});
    const statusResult = await client.request(3, "tools/call", {
      name: "vm_status",
      arguments: {},
    });
    const toolNames = (toolsList?.tools ?? []).map((tool) => tool.name);
    const statusText = readText(statusResult);
    const toolsPassed = reportHandshake(init, toolNames, statusText);

    if (!toolsPassed) {
      console.log("REGRESSION TEST FAIL");
    } else if (!/SSH reachable on /.test(statusText)) {
      console.log("regression -> vm_run_command [SKIP] VM not reachable; start it and rerun.");
      console.log("REGRESSION TEST SKIPPED");
      exitCode = 0;
    } else {
      const verdicts = await runRegressions(client);
      for (const { label, failures } of verdicts) {
        const suffix = failures.length === 0 ? "" : ` ${failures.join("; ")}`;
        console.log(`regression ${label} [${verdict(failures.length === 0)}]${suffix}`);
      }
      const allPassed = verdicts.every(({ failures }) => failures.length === 0);
      console.log(allPassed ? "REGRESSION TEST PASS" : "REGRESSION TEST FAIL");
      exitCode = allPassed ? 0 : 1;
    }
  } catch (error) {
    console.log(error.message);
    exitCode = 1;
  } finally {
    child.kill();
  }
  process.exit(exitCode);
};

main();
