import { spawn } from "node:child_process";

const GUARD_TIMEOUT_MS = 20000;

const STATUS_TEXT_PATTERN = /not running|Could not determine|SSH reachable/;

const EXPECTED_TOOL_NAMES = ["vm_status", "vm_run_command"];

const buildChildEnvironment = () => ({
  ...process.env,
  VM_SSH_PASSWORD: process.env.VM_SSH_PASSWORD ?? "alpine",
  VM_SSH_READY_TIMEOUT_MS: process.env.VM_SSH_READY_TIMEOUT_MS ?? "4000",
});

const createHandshakeMessages = () => [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vm-ssh-mcp-smoke", version: "0.1.0" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "vm_status", arguments: {} } },
];

const parseJsonLine = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

const recordResponse = (results, message) => {
  if (message?.id === undefined) {
    return;
  }
  if (message.error !== undefined) {
    results.set(message.id, { jsonRpcError: message.error });
    return;
  }
  if (message.result === undefined) {
    return;
  }
  results.set(message.id, message.result);
};

const recordIfNonEmpty = (results, line) => {
  if (line.trim().length > 0) {
    recordResponse(results, parseJsonLine(line));
  }
};

const processLines = (results, lines) => {
  for (const line of lines) {
    recordIfNonEmpty(results, line);
  }
};

const createLineProcessor = (results) => {
  let remainder = "";
  return (chunk) => {
    const lines = (remainder + chunk).split(/\r?\n/);
    remainder = lines.pop() ?? "";
    processLines(results, lines);
  };
};

const spawnServer = () =>
  spawn(process.execPath, ["src/server.mjs"], {
    cwd: process.cwd(),
    env: buildChildEnvironment(),
    stdio: ["pipe", "pipe", "inherit"],
  });

const sendHandshake = (child) => {
  child.stdin.on("error", () => undefined);
  for (const message of createHandshakeMessages()) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
};

const completeWhenStatusReceived = (results, waiter) => {
  if (results.has(3)) {
    clearTimeout(waiter.guard);
    waiter.resolve(results);
  }
};

const exchangeMessages = (child) =>
  new Promise((resolve, reject) => {
    const results = new Map();
    const guard = setTimeout(() => reject(new Error("SMOKE TEST TIMED OUT")), GUARD_TIMEOUT_MS);
    const processChunk = createLineProcessor(results);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      processChunk(chunk);
      completeWhenStatusReceived(results, { guard, resolve });
    });
    sendHandshake(child);
  });

const readToolNames = (toolsListResult) =>
  (toolsListResult?.tools ?? []).map((tool) => tool.name);

const hasExpectedTools = (toolNames) =>
  EXPECTED_TOOL_NAMES.every((expected) => toolNames.includes(expected));

const isStatusTextAcceptable = (statusText) =>
  statusText.length > 0 && STATUS_TEXT_PATTERN.test(statusText);

const findJsonRpcError = (results) =>
  [...results.values()].find((value) => value?.jsonRpcError !== undefined)?.jsonRpcError;

const evaluateResults = (results) => {
  const serverName = results.get(1)?.serverInfo?.name ?? "";
  const toolNames = readToolNames(results.get(2));
  const statusText = results.get(3)?.content?.[0]?.text ?? "";
  return {
    serverName,
    toolNames,
    statusText,
    jsonRpcError: findJsonRpcError(results),
    initializePassed: serverName === "vm-ssh-mcp",
    toolsPassed: hasExpectedTools(toolNames),
    statusPassed: isStatusTextAcceptable(statusText),
  };
};

const allChecksPassed = (report) =>
  [
    report.initializePassed,
    report.toolsPassed,
    report.statusPassed,
    report.jsonRpcError === undefined,
  ].every(Boolean);

const formatVerdict = (passed) => (passed ? "PASS" : "FAIL");

const printReport = (report) => {
  console.log(
    `initialize -> serverInfo.name "${report.serverName}" [${formatVerdict(report.initializePassed)}]`,
  );
  console.log(
    `tools/list -> [${report.toolNames.join(", ")}] [${formatVerdict(report.toolsPassed)}]`,
  );
  console.log(
    `vm_status  -> ${report.statusText.split("\n").join(" | ")} [${formatVerdict(report.statusPassed)}]`,
  );
  if (report.jsonRpcError !== undefined) {
    console.log(`jsonrpc error -> ${JSON.stringify(report.jsonRpcError)} [FAIL]`);
  }
  console.log(allChecksPassed(report) ? "SMOKE TEST PASS" : "SMOKE TEST FAIL");
};

const main = async () => {
  const child = spawnServer();
  let exitCode = 1;
  try {
    const results = await exchangeMessages(child);
    const report = evaluateResults(results);
    printReport(report);
    exitCode = allChecksPassed(report) ? 0 : 1;
  } catch (error) {
    console.log(error.message);
    exitCode = 1;
  } finally {
    child.kill();
  }
  process.exit(exitCode);
};

main();
