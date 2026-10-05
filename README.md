# vm-ssh-mcp

vm-ssh-mcp is a Model Context Protocol (MCP) stdio server that lets an AI agent check whether the local Alpine Linux VirtualBox VM is running and run allowlisted shell commands on it over SSH. It is built with Node.js (ESM) using `@modelcontextprotocol/sdk` and `ssh2`, and is intended to be registered in opencode under the name `alpine-vm`. The server is status-only: it never starts or stops the VM.

## Table of contents

- [Table of contents](#table-of-contents)
- [Prerequisites](#prerequisites)
- [How it works](#how-it-works)
- [Tools](#tools)
- [Configuration](#configuration)
- [Running with opencode](#running-with-opencode)
- [Smoke test](#smoke-test)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
- [Verification record](#verification-record)

## Prerequisites

- Node.js ≥ 20 (plain `.mjs` ESM — no build step)
- npm (dependencies install in-project: `npm install`; `node_modules/` is gitignored)
- Oracle VirtualBox installed so that `VBoxManage` is reachable (the server checks `C:\Program Files\Oracle\VirtualBox\VBoxManage.exe` first, then PATH; override with `VM_VBOX_MANAGE_PATH`)
- The target Alpine VM, running in VirtualBox, with sshd enabled and SSH port-forwarded to `127.0.0.1:3022`, user `alpine` (default VM name `alpine-virt-3.21.2-x86_64`; all of this is overridable via the environment variables in [Configuration](#configuration))
- Docker installed inside the VM only if the agent should run `docker ...` commands (the allowlist contains `docker` by default)

## How it works

The server answers two questions — is the VM up, and, if it is, may this command run — through a strict layered pipeline:

- **Two-layer state check.**
  - Layer 1 asks VirtualBox itself: `VBoxManage showvminfo <name> --machinereadable` (5 s timeout, hidden window), parses the `VMState=` line, and maps it to `running`, `poweroff` (any of `poweroff`, `saved`, `aborted`, `paused`), or `unknown` when the probe fails or is skipped — a probe failure never crashes the server.
  - Layer 2 opens a short SSH connection and runs `echo ok`, expecting clean output; it is executed only when Layer 1 reports the VM as running.
- **`vm_status`** combines both layers into a single status report (see [Tools](#tools)). **`vm_run_command`** applies three gates in order before anything executes: VM running → SSH reachable → command starts with an allowed prefix.
- **Status-only.** There is no `VBoxManage startvm` and no auto-start anywhere in the code; when the VM is off the tools return a clear result and the human starts the VM in VirtualBox.
- One fresh SSH connection per command (`pty: false`), stdout and stderr capped at 10000 characters each with `… [truncated]` appended when cut, and the process timeout defaults to 30000 ms per command.
- **stdout purity.** stdout carries only the MCP JSON-RPC channel; all human logging (the single "ready" line and startup failures) goes to stderr.

## Tools

### vm_status

Checks VM state; takes no arguments. Every result starts with the combined status line, followed by a message chosen by state.

| State | Reported text |
|---|---|
| `poweroff` | `VM 'alpine-virt-3.21.2-x86_64' is not running — start it in VirtualBox first.` |
| `unknown` | `Could not determine VM state — VBoxManage probe failed or was skipped.` |
| `running`, SSH up | `SSH reachable on 127.0.0.1:3022 — ready for commands.` |
| `running`, SSH down | `VM 'alpine-virt-3.21.2-x86_64' is running but SSH is not reachable on 127.0.0.1:3022.` |

VM off (verified live with the VM powered off):

```text
vmState: poweroff | sshReachable: false
VM 'alpine-virt-3.21.2-x86_64' is not running — start it in VirtualBox first.
```

VM ready (verified live with the VM running):

```text
vmState: running | sshReachable: true
SSH reachable on 127.0.0.1:3022 — ready for commands.
```

### vm_run_command

Runs one allowlisted shell command on the VM.

| Argument | Type | Required | Default |
|---|---|---|---|
| `command` | string, minimum length 1 | yes | — |
| `timeoutMs` | positive integer | no | `VM_COMMAND_TIMEOUT_MS` (30000) |

Gate order: VM running → SSH reachable → prefix allowlist.

A completed execution returns a report starting with `exit code: <code>`, followed by a `stdout:` section and a `stderr:` section; the result is flagged as an error only when the exit code is not 0. A failure after the channel started returns `Command failed after start: <error.message>`; an expired per-command guard returns `Command timed out after <ms> ms`.

Allowed command `uname -a`. The exit code and the Alpine kernel version `6.12.8-0-virt` were observed live; the block is representative — `...` abbreviates the hostname and build fields of the kernel line, which vary with the VM:

```text
exit code: 0
stdout:
Linux ... 6.12.8-0-virt ...
stderr:
```

Allowed command `docker ps`. The exit code 0 and the standard `docker ps` header were observed live; the block is representative — `...` stands for the live container table, one row per running container at execution time, not reproduced here to avoid inventing container names:

```text
exit code: 0
stdout:
CONTAINER ID   IMAGE   COMMAND   CREATED   STATUS   PORTS   NAMES
...
stderr:
```

Disallowed command `reboot`. The rejection text is byte-exact as verified live, and this response arrives BEFORE execution — the command never reaches the VM:

```text
Command rejected: 'reboot' does not match allowed prefixes [docker, sh, apk, ls, cat, ps, df, free, uname, pwd, whoami].
```

## Configuration

All configuration is read from environment variables at startup.

| Environment variable | Default | Purpose |
|---|---|---|
| `VM_SSH_HOST` | `127.0.0.1` | Host of the port-forwarded SSH endpoint |
| `VM_SSH_PORT` | `3022` | Port-forwarded SSH port of the VM |
| `VM_SSH_USER` | `alpine` | SSH user name |
| `VM_SSH_PASSWORD` | none — **required** | SSH password; without it the server refuses to start |
| `VM_VBOX_NAME` | `alpine-virt-3.21.2-x86_64` | VM name passed to `VBoxManage showvminfo` |
| `VM_VBOX_MANAGE_PATH` | unset (auto-resolve) | `VBoxManage` location; resolution order: env value if set → `C:\Program Files\Oracle\VirtualBox\VBoxManage.exe` when that path exists → `VBoxManage` resolved from PATH |
| `VM_ALLOWED_PREFIXES` | `docker,sh,apk,ls,cat,ps,df,free,uname,pwd,whoami` | Comma-separated command allowlist; each entry is trimmed, empty entries are dropped, matching is case-sensitive |
| `VM_COMMAND_TIMEOUT_MS` | `30000` | Per-command execution timeout in milliseconds |
| `VM_SSH_READY_TIMEOUT_MS` | `5000` | SSH connection ready timeout in milliseconds |

- Validation: `VM_SSH_PORT`, `VM_COMMAND_TIMEOUT_MS` and `VM_SSH_READY_TIMEOUT_MS` must be positive integers, otherwise the server exits with `<VAR> must be a positive integer, received '<value>'`.
- Password: `VM_SSH_PASSWORD` has no default and the process refuses to start without it (`VM_SSH_PASSWORD is required — set it in the MCP environment configuration`).
- Allowlist: for example, `VM_ALLOWED_PREFIXES=docker,sh,apk` restricts agents to those three prefixes; matching is case-sensitive and prefix-based (see [Security notes](#security-notes)).

## Running with opencode

1. The server is registered in the global opencode config at `C:\Users\ibej_\.config\opencode\opencode.jsonc`, inside the existing `mcp` object, under the name `alpine-vm`. It ships **disabled**.
2. The registered block, verbatim:

```jsonc
"alpine-vm": {
  "type": "local",
  "command": ["node", "C:\\repo\\vm-ssh-mcp\\src\\server.mjs"],
  "enabled": false,
  "environment": {
    "VM_SSH_HOST": "127.0.0.1",
    "VM_SSH_PORT": "3022",
    "VM_SSH_USER": "alpine",
    "VM_SSH_PASSWORD": "alpine",
    "VM_VBOX_NAME": "alpine-virt-3.21.2-x86_64",
    "VM_ALLOWED_PREFIXES": "docker,sh,apk,ls,cat,ps,df,free,uname,pwd,whoami"
  }
}
```

3. To enable it: open the file, change `"enabled": false` to `"enabled": true` inside this block only, save, and restart opencode (the config is read at startup; `experimental.mcp_timeout` is already set globally).
4. With the server enabled, the agent sees the two tools described in [Tools](#tools) and should call `vm_status` before `vm_run_command`.

## Smoke test

Command (PowerShell or cmd, workdir `C:\repo\vm-ssh-mcp`): `npm run smoke-test`. The script spawns `node src/server.mjs` and speaks newline-delimited JSON-RPC over stdio — `initialize` → `notifications/initialized` → `tools/list` → `tools/call vm_status` — under a 20 s guard.

Expected output — VM running:

```text
initialize -> serverInfo.name "vm-ssh-mcp" [PASS]
tools/list -> [vm_status, vm_run_command] [PASS]
vm_status  -> vmState: running | sshReachable: true | SSH reachable on 127.0.0.1:3022 — ready for commands. [PASS]
SMOKE TEST PASS
```

Expected output — VM off:

```text
initialize -> serverInfo.name "vm-ssh-mcp" [PASS]
tools/list -> [vm_status, vm_run_command] [PASS]
vm_status  -> vmState: poweroff | sshReachable: false | VM 'alpine-virt-3.21.2-x86_64' is not running — start it in VirtualBox first. [PASS]
SMOKE TEST PASS
```

A pass means: exit code 0, the three `[PASS]` verdicts, and the final `SMOKE TEST PASS` line. Note that some Windows console codepages render the em dash as mojibake — that is harmless; judge by the `[PASS]` verdicts and the final line.

The server can also be run by hand: `npm start` works once `VM_SSH_PASSWORD` is set in the environment (opencode supplies it via the registration block; interactive users must set it themselves).

## Security notes

- **Plaintext password rationale.** The password lives in plaintext inside the global opencode config. That is acceptable for a disposable local development VM that never leaves the machine; it is knowingly NOT hardened — do not reuse this pattern on shared or production hosts.
- **Prefix allowlist behavior.** A command is allowed only if its trimmed form equals a configured prefix or starts with `<prefix> ` (prefix immediately followed by a space). Matching is case-sensitive. Consequence: `dockera` / `dockerx` variants are rejected, while a bare prefix with no arguments (`docker`) is allowed and `dockerX` is not. `reboot`, `rm`, `wget` and the like die at the policy gate BEFORE any execution (proven live with `reboot`).
- **Disposable-VM context.** The VM is a throwaway dev box; the allowlist limits the blast radius, but the box is treated as replaceable.
- **No auto privileges.** The server is status-only: it cannot start, reboot, or stop the VM, and it proxies nothing outside the allowlist.
- **Output hygiene.** The password is passed only to the ssh2 connect options — it never appears in tool results or logs (verified: zero leak hits), and stdout stays protocol-pure.
- **Future hardening path.** Switch to SSH key authentication (ssh2 `privateKey`) and drop `VM_SSH_PASSWORD`; not implemented at version 0.1.0.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `vm_run_command` returns `VM not running — run vm_status for details and start the VM in VirtualBox first.` | Start the VM in VirtualBox, then re-check with `vm_status`. |
| `vm_status` returns `vmState: poweroff \| sshReachable: false` with `VM 'alpine-virt-3.21.2-x86_64' is not running — start it in VirtualBox first.` | The VM is powered off (or saved/aborted/paused). |
| `vm_status` returns `vmState: running \| sshReachable: false` with `VM 'alpine-virt-3.21.2-x86_64' is running but SSH is not reachable on 127.0.0.1:3022.`, and `vm_run_command` returns `SSH not reachable on 127.0.0.1:3022.` | sshd is down or the port forwarding changed — check the sshd service in the VM and the `127.0.0.1:3022` forward rule. |
| Server exits immediately; stderr shows `vm-ssh-mcp failed to start: VM_SSH_PASSWORD is required — set it in the MCP environment configuration` | Set the password in the environment (the registered opencode block already carries it). |
| Server exits with `<VAR> must be a positive integer, received '<value>'` | Fix the numeric environment value. |
| `vm_status` returns `vmState: unknown \| sshReachable: false` with `Could not determine VM state — VBoxManage probe failed or was skipped.` | VBoxManage not found or VM name wrong: set `VM_VBOX_MANAGE_PATH` and/or `VM_VBOX_NAME`. |
| `Command rejected: '...' does not match allowed prefixes [...].` | The command's first word is not an allowed prefix — extend `VM_ALLOWED_PREFIXES` deliberately, or pick an allowed command. |
| `Command timed out after <ms> ms` | Pass a larger `timeoutMs` for that call, or raise `VM_COMMAND_TIMEOUT_MS`. |

## Project layout

```text
C:\repo\vm-ssh-mcp\
├── package.json
├── package-lock.json
├── .gitignore
├── README.md
├── scripts\
│   └── smoke-test.mjs
└── src\
    ├── server.mjs
    ├── vm-connection-config.mjs
    ├── vm-state-probe.mjs
    ├── ssh-command-runner.mjs
    ├── command-policy.mjs
    └── vm-tools.mjs
```

- `package.json` — npm manifest: `vm-ssh-mcp` 0.1.0, `type: module`; scripts `start` (`node src/server.mjs`) and `smoke-test`; dependencies `@modelcontextprotocol/sdk`, `ssh2`, `zod`.
- `package-lock.json` — locked dependency versions for in-project installs.
- `.gitignore` — ignores `node_modules/`.
- `README.md` — this document.
- `scripts/smoke-test.mjs` — JSON-RPC-over-stdio smoke test (spawns the server).
- `src/server.mjs` — entrypoint: `McpServer` + `StdioServerTransport`; registers both tools; startup and errors are logged to stderr only.
- `src/vm-connection-config.mjs` — reads and validates the nine `VM_*` environment variables into a frozen config object; throws early on a missing password or an invalid integer.
- `src/vm-state-probe.mjs` — Layer-1 probe: `VBoxManage` `showvminfo --machinereadable` → `running` | `poweroff` | `unknown` (never throws).
- `src/ssh-command-runner.mjs` — Layer-2 SSH: one `ssh2` client per command; `exec` → `{stdout, stderr, exitCode}`; exports the `echo ok` probe used for SSH reachability.
- `src/command-policy.mjs` — pure prefix-allowlist matcher (equal to a prefix, or prefix immediately followed by a space; case-sensitive; trimmed command).
- `src/vm-tools.mjs` — the two tool handlers: state gate → SSH gate → policy gate → execute and format (10000-character truncation).

## Verification record

Verified on 2026-10-04 against commit `8f602f1` (branch `feat/mcp-server`), server `vm-ssh-mcp` version 0.1.0. The evidence below comes from the Task 2 verification run only:

- Offline smoke test PASS: JSON-RPC `initialize`, `tools/list`, and `tools/call vm_status` with the VM off; exit code 0.
- Live pass with the Alpine VM running: `vm_status` reported `vmState: running | sshReachable: true`; `uname -a` returned the Alpine kernel line (`6.12.8-0-virt`); `docker ps` returned Docker's container table with exit code 0; the disallowed `reboot` was rejected with the byte-exact policy string shown in [Tools](#tools) and never executed.
- Negative checks: no password leakage in any tool output or stderr, and the server stdout carried only JSON-RPC lines.