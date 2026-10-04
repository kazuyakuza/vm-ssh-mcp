#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createVmConnectionConfig } from "./vm-connection-config.mjs";
import { createVmStatusTool, createVmRunCommandTool } from "./vm-tools.mjs";

const registerTools = (server, config) => {
  const statusToolResult = createVmStatusTool(config);
  const runCommandToolResult = createVmRunCommandTool(config);
  server.registerTool(
    "vm_status",
    {
      description:
        "Check whether the Alpine VirtualBox VM is running and SSH reachable. ALWAYS call this before vm_run_command.",
    },
    statusToolResult,
  );
  server.registerTool(
    "vm_run_command",
    {
      description:
        "Run one allowlisted shell command on the Alpine VM. The command must start with an allowed prefix (docker, sh, apk, ls, cat, ps, df, free, uname, pwd, whoami). Check vm_status first.",
      inputSchema: z.object({
        command: z.string().min(1),
        timeoutMs: z.number().int().positive().optional(),
      }),
    },
    runCommandToolResult,
  );
};

const startServer = async () => {
  const config = createVmConnectionConfig();
  const server = new McpServer({ name: "vm-ssh-mcp", version: "0.1.0" });
  registerTools(server, config);
  console.error("vm-ssh-mcp ready on stdio — expect tools vm_status + vm_run_command");
  await server.connect(new StdioServerTransport());
};

startServer().catch((error) => {
  console.error(`vm-ssh-mcp failed to start: ${error.message}`);
  process.exit(1);
});
