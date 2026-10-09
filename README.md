# vm-ssh-mcp

vm-ssh-mcp is a Model Context Protocol (MCP) stdio server that lets an AI agent check whether the local Alpine Linux VirtualBox VM is running and run allowlisted shell commands on it over SSH. It is built with Node.js (ESM) using `@modelcontextprotocol/sdk` and `ssh2`, and is intended to be registered in opencode under the name `alpine-vm`. The server is status-only: it never starts or stops the VM.

## Table of contents

- [Table of contents](#table-of-contents)
- [Prerequisites](#prerequisites)
- [How it works](#how-it-works)
- [Tools](#tools)
- [Configuration](#configuration)
- [Running with opencode](#running-with-opencode)
- [Tests](#tests)
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
- One fresh SSH connection per command (`pty: false`), so stdout and stderr stay on separate channels; both are always captured — stderr is read from ssh2's dedicated stderr stream, not the stdout channel. Each channel is capped at `VM_OUTPUT_LIMIT_CHARS` (10000) characters with `… [truncated at <limit> chars]` appended when cut, and the process timeout defaults to 30000 ms per command. A timeout returns the partial output captured so far instead of an empty result.
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

**Result contract.** Every completed execution returns a `structuredContent` object alongside a matching `content[0].text` rendering. The structured fields are always present (empty string when a channel produced nothing):

| Field | Type | Meaning |
|---|---|---|
| `exitCode` | number \| null | Process exit code; `null` on timeout. Authoritative. |
| `stdout` | string | Captured stdout. |
| `stderr` | string | Captured stderr. |
| `combinedOutput` | string | stdout + stderr interleaved in arrival (stream) order. |
| `stdoutTruncated` | boolean | stdout reached the capture cap and was cut. |
| `stderrTruncated` | boolean | stderr reached the capture cap and was cut. |
| `outputLimitChars` | number | Active per-channel capture cap. |
| `timedOut` | boolean | The per-command timeout fired; `exitCode` is `null` and captured output is partial. |

The result is flagged as an error (`isError: true`) whenever `exitCode` is not `0`, including a timeout. In the text rendering an empty channel shows as `<empty>` and a cut channel ends with `… [truncated at <limit> chars]`. Gate failures (VM off, SSH down, policy rejection) are text-only errors — the command never executes; a failure after the channel started returns `Command failed after start: <error.message>`.

**Composing more than one step.** The prefix allowlist forces every command to start with an allowed prefix (`docker`, `sh`, …), so to run several steps pass a single `sh -c "<command string>"` — that is the sanctioned composition form; do not rely on unquoted shell chains.

Allowed command `uname -a`. The exit code and the Alpine kernel version `6.12.8-0-virt` were observed live; the block is representative — `...` abbreviates the hostname and build fields of the kernel line, which vary with the VM. Text rendering:

```text
exit code: 0
stdout:
Linux ... 6.12.8-0-virt ...
stderr:
<empty>
combined output:
Linux ... 6.12.8-0-virt ...
```

The same call's `structuredContent`:

```json
{
  "exitCode": 0,
  "stdout": "Linux ... 6.12.8-0-virt ...\n",
  "stderr": "",
  "combinedOutput": "Linux ... 6.12.8-0-virt ...\n",
  "stdoutTruncated": false,
  "stderrTruncated": false,
  "outputLimitChars": 10000,
  "timedOut": false
}
```

A stderr-only command now reports its output instead of appearing fully silent (verified live with `sh -c "echo err 1>&2; exit 3"`):

```text
exit code: 3
stdout:
<empty>
stderr:
err
combined output:
err
```

Allowed command `docker ps`. The exit code 0 and the standard `docker ps` header were observed live; the block is representative — `...` stands for the live container table, one row per running container at execution time, not reproduced here to avoid inventing container names:

```text
exit code: 0
stdout:
CONTAINER ID   IMAGE   COMMAND   CREATED   STATUS   PORTS   NAMES
...
stderr:
<empty>
combined output:
CONTAINER ID   IMAGE   COMMAND   CREATED   STATUS   PORTS   NAMES
...
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
| `VM_OUTPUT_LIMIT_CHARS` | `10000` | Per-channel capture cap (characters) for stdout and stderr |

- Validation: `VM_SSH_PORT`, `VM_COMMAND_TIMEOUT_MS`, `VM_SSH_READY_TIMEOUT_MS` and `VM_OUTPUT_LIMIT_CHARS` must be positive integers, otherwise the server exits with `<VAR> must be a positive integer, received '<value>'`.
- Password: `VM_SSH_PASSWORD` has no default and the process refuses to start without it (`VM_SSH_PASSWORD is required — set it in the MCP environment configuration`).
- Allowlist: for example, `VM_ALLOWED_PREFIXES=docker,sh,apk` restricts agents to those three prefixes; matching is case-sensitive and prefix-based (see [Security notes](#security-notes)).

## Running with opencode (example)

1. The server is registered in the global opencode config at `C:\Users\<user-name>\.config\opencode\opencode.jsonc`, inside the existing `mcp` object, under the name `alpine-vm`. It ships **disabled**.
2. Registration block (the optional `VM_OUTPUT_LIMIT_CHARS` line may be omitted to use the `10000` default):

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
    "VM_ALLOWED_PREFIXES": "docker,sh,apk,ls,cat,ps,df,free,uname,pwd,whoami",
    "VM_OUTPUT_LIMIT_CHARS": "10000"
  }
}
```

3. To enable it: open the file, change `"enabled": false` to `"enabled": true` inside this block only, save, and restart opencode (the config is read at startup; `experimental.mcp_timeout` is already set globally).
4. With the server enabled, the agent sees the two tools described in [Tools](#tools) and should call `vm_status` before `vm_run_command`.

## Tests

### Unit tests

Command (no VM required): `npm test`. Runs Node's built-in test runner over `tests/**/*.test.mjs` — a fake ssh2 client feeds stdout/stderr/close events (plus timeout, connection-refused and exec-failure paths), and `vm_run_command` is exercised with injected VM-state, SSH-probe and runner dependencies. Covers per-channel capture, stream-order `combinedOutput`, truncation flags, timeout partial capture, the gate order (VM off → SSH down → policy) and both the structured and text result shapes.

### Regression test

Command (VM running): `npm run regression`. Spawns `node src/server.mjs` and drives JSON-RPC like the smoke test, then asserts three `vm_run_command` cases against `structuredContent`:

| Command | Expectation |
|---|---|
| `sh -c "echo err 1>&2; exit 3"` | `exitCode` 3, `stderr` `err`, `isError` true |
| `sh -c "echo out; echo err 1>&2"` | `stdout` and `stderr` both non-empty, `exitCode` 0 |
| `sh -c "seq 1 5000"` | `stdoutTruncated` true, `stdout.length === outputLimitChars` |

When the VM is off or SSH is unreachable it prints `REGRESSION TEST SKIPPED` and exits 0 — it reports on output capture, not on VM availability. Expected output — VM running:

```text
initialize -> serverInfo.name "vm-ssh-mcp" [PASS]
tools/list -> [vm_status, vm_run_command] [PASS]
vm_status  -> vmState: running | sshReachable: true | SSH reachable on 127.0.0.1:3022 — ready for commands. [PASS]
regression stderr-only (exit 3)       [PASS]
regression stdout + stderr (exit 0)   [PASS]
regression long output (truncated)    [PASS]
REGRESSION TEST PASS
```

### Smoke test

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
- **Future hardening path.** Switch to SSH key authentication (ssh2 `privateKey`) and drop `VM_SSH_PASSWORD`; not implemented at version 0.2.0.

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
| `vm_run_command` returns `timedOut: true`, `exitCode` `null` (`exit code: none`) | The command exceeded `timeoutMs`/`VM_COMMAND_TIMEOUT_MS`; the partial output captured so far is included. Raise `timeoutMs` for that call or `VM_COMMAND_TIMEOUT_MS`. |
| A result channel shows `<empty>` | That channel genuinely produced nothing (for example a stderr-only command); the other channel and `combinedOutput` carry the output. Capture is per-channel, so an empty stdout no longer hides stderr. |
| A channel ends with `… [truncated at N chars]` and `stdoutTruncated`/`stderrTruncated` is `true` | Output hit `VM_OUTPUT_LIMIT_CHARS`; raise it or narrow the command's output. |

## Project layout

```text
C:\repo\vm-ssh-mcp\
├── package.json
├── package-lock.json
├── .gitignore
├── README.md
├── scripts\
│   ├── smoke-test.mjs
│   └── regression-test.mjs
├── tests\
│   ├── ssh-command-runner.test.mjs
│   └── vm-tools.test.mjs
└── src\
    ├── server.mjs
    ├── vm-connection-config.mjs
    ├── vm-state-probe.mjs
    ├── ssh-command-runner.mjs
    ├── command-policy.mjs
    └── vm-tools.mjs
```

- `package.json` — npm manifest: `vm-ssh-mcp` 0.2.0, `type: module`; scripts `start`, `test` (`node --test "tests/**/*.test.mjs"`), `smoke-test`, `regression`; dependencies `@modelcontextprotocol/sdk`, `ssh2`, `zod`.
- `package-lock.json` — locked dependency versions for in-project installs.
- `.gitignore` — ignores `node_modules/`.
- `README.md` — this document.
- `scripts/smoke-test.mjs` — JSON-RPC-over-stdio smoke test (spawns the server, checks handshake + `vm_status`).
- `scripts/regression-test.mjs` — JSON-RPC-over-stdio regression test for output capture (spawns the server, asserts `structuredContent` for stderr-only, mixed and truncated commands; skips when the VM is unreachable).
- `tests/` — Node built-in unit tests with a fake ssh2 client and injected tool dependencies (no VM required).
- `src/server.mjs` — entrypoint: `McpServer` + `StdioServerTransport`; registers both tools (`vm_run_command` declares an output schema); startup and errors are logged to stderr only.
- `src/vm-connection-config.mjs` — reads and validates the ten `VM_*` environment variables into a frozen config object; throws early on a missing password or an invalid integer.
- `src/vm-state-probe.mjs` — Layer-1 probe: `VBoxManage` `showvminfo --machinereadable` → `running` | `poweroff` | `unknown` (never throws).
- `src/ssh-command-runner.mjs` — Layer-2 SSH: one `ssh2` client per command; `exec` (`pty: false`) → `{exitCode, timedOut, stdout, stderr, combinedOutput, stdoutTruncated, stderrTruncated, outputLimitChars}`, capturing stdout and ssh2's stderr stream separately with per-channel caps and partial capture on timeout; exports the `echo ok` probe used for SSH reachability.
- `src/command-policy.mjs` — pure prefix-allowlist matcher (equal to a prefix, or prefix immediately followed by a space; case-sensitive; trimmed command).
- `src/vm-tools.mjs` — the two tool handlers: state gate → SSH gate → policy gate → execute; `vm_run_command` returns `structuredContent` plus a text fallback (`<empty>` markers, `… [truncated at <limit> chars]` notes, `combined output:` section).

## Verification record

Verified on 2026-10-04 against commit `8f602f1` (branch `feat/mcp-server`), server `vm-ssh-mcp` version 0.1.0. The evidence below comes from the Task 2 verification run only:

- Offline smoke test PASS: JSON-RPC `initialize`, `tools/list`, and `tools/call vm_status` with the VM off; exit code 0.
- Live pass with the Alpine VM running: `vm_status` reported `vmState: running | sshReachable: true`; `uname -a` returned the Alpine kernel line (`6.12.8-0-virt`); `docker ps` returned Docker's container table with exit code 0; the disallowed `reboot` was rejected with the byte-exact policy string shown in [Tools](#tools) and never executed.
- Negative checks: no password leakage in any tool output or stderr, and the server stdout carried only JSON-RPC lines.

### 0.2.0 output-capture verification (2026-10-09)

Verified with the Alpine VM running (`127.0.0.1:3022`, user/password `alpine`):

- `npm test` — 19 unit tests PASS with no VM, covering per-channel capture, truncation flags, timeout partial capture, connection/exec error mapping and the gate order.
- `npm run smoke-test` — PASS, unchanged behaviour from 0.1.0.
- `npm run regression` — PASS. `sh -c "echo err 1>&2; exit 3"` returned `exitCode` 3 with a non-empty `stderr`; `sh -c "echo out; echo err 1>&2"` returned both `stdout` and `stderr`; `sh -c "seq 1 5000"` returned `stdoutTruncated: true` with `stdout.length === outputLimitChars`. Before this change the first two appeared fully silent because stderr was never read from ssh2's separate stderr stream.
- Indirection check (TODO Notes): `docker run --rm alpine:latest sh -c "echo out; echo err 1>&2; exit 7"` returned `exitCode` 7 with `stdout` `out` and `stderr` `err`; `docker compose -f /rust-youtube-streamer/docker-compose.yml run --rm rust sh -c "echo composed-out; echo composed-err 1>&2; exit 0"` returned both channels and `exitCode` 0 — confirming capture through SSH → docker (compose) → container child process.
- `vm_status` output is byte-identical to 0.1.0; the structured rework touches `vm_run_command` only.
