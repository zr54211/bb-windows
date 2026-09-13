# bb-plugin-google-antigravity-acp

Google Antigravity as a first-class bb agent provider through Antigravity's
official **ACP** server (`agy_acp_server.par`).

Registers the `acp-antigravity` provider (family `acp`), exactly like bb's
builtin ACP agents:

- `server.ts` — `bb.providers.register` with the launch spec in
  `experimental_bridgeOptions.acpLaunchSpec`; plugin settings for install
  paths; the `bb google-antigravity-acp status` and
  `bb google-antigravity-acp install` commands.
- `host.ts` — re-exports the canonical ACP provider bridge
  (`@get-bb/plugin-sdk/provider-bridge/acp`, the same bridge the builtin
  `provider-acp` plugin uses) and implements the host RPC the install/status
  commands call, so installs run on the target machine, not on the bb server.
- `install.ts` — shared install logic: resolves the official distribution
  from the ACP registry (pinned to a commit SHA), downloads, safely extracts,
  and links the server binary, usage proxy wrapper, and sandbox helper onto PATH
  (no environment variables needed).
- `icons/google-antigravity.svg` — provider mark (path-shaped, theme-tinted).

## Install the plugin

```sh
bb plugin install git:github.com/rawizhere/bb-plugin-antigravity-acp --yes
```

For development, install from a checkout instead:

```sh
bb plugin install .                  # from this directory
bb plugin reload google-antigravity-acp
```

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `installDir` | `~/.local/opt/agy-acp-server` | Where the downloaded server binaries are extracted. `~` expands per machine. |
| `binDir` | `~/.local/bin` | Where the server binary and sandbox helper are linked; must be on the machine's PATH. |
| `defaultModel` | *(empty — latest Flash)* | Default model family for new threads, e.g. `gemini-3.8-flash` or `gemini-3.1-pro`. |
| `defaultReasoningEffort` | *(empty — model default)* | Preferred effort variant for the default model: `low`, `medium`, or `high`. |

## Install the server binary

```sh
bb google-antigravity-acp install
```

The command runs on the machine that will launch the agent (the current
thread's host, or `--machine <id-or-name>` to pick another enrolled machine):

- detects the platform/arch and takes the official zip URL for it from the
  ACP registry (`agentclientprotocol/registry` → `antigravity-acp`, pinned to
  `REGISTRY_COMMIT` in `install.ts`), falling back to a pinned copy embedded
  in the plugin;
- downloads and extracts into `~/.local/opt/agy-acp-server` (configurable via
  `--install-dir`, or the `installDir` plugin setting). Extraction never uses
  `tar` (bsdtar does not sanitize `../` zip entries); it uses `unzip` or a
  validated `python3` zipfile extraction, and PowerShell's `Expand-Archive`
  on Windows;
- symlinks the raw binary `agy_acp_server_raw.par` and sandbox helper `localharness_external`
  into `~/.local/bin` (configurable via `--bin-dir` / `binDir`), and installs the
  lightweight ACP context usage proxy wrapper as `agy_acp_server.par`; on Windows it
  copies them and only appends the dir to the user PATH when you pass
  `--update-path` (setx permanently edits `HKCU\Environment` — opt in
  explicitly, and be aware of its 1024-character truncation limit);
- makes the binaries executable and records the install in a manifest.

Install once per machine that should run Antigravity threads. The provider
only appears on a machine where the health probe finds `agy_acp_server.par`
on PATH; the ACP server finds the sandbox helper on PATH too (the install
links both into `binDir`), so no per-machine environment variables are
needed.

```sh
bb google-antigravity-acp install --machine macbook        # this machine
```

The machine's daemon shell must have `binDir` on PATH. The command warns
when it is not; pick a dir that is (e.g. `/usr/local/bin`) with `--bin-dir`.

Useful flags:

```sh
bb google-antigravity-acp install --machine macbook        # install on a specific machine
bb google-antigravity-acp install --force                  # re-download even if already installed
bb google-antigravity-acp install --from ./agy-acp.zip     # explicit source (URL or local file)
bb google-antigravity-acp install --update-path            # also append binDir to the user PATH (Windows)
bb google-antigravity-acp install --json                   # machine-readable output
```

`~/.local/bin` must be on the machine's PATH for the provider health probe to
find the server. The command warns when it is not.

## Verify

```sh
bb google-antigravity-acp status        # where the server is, per machine
bb provider list                        # acp-antigravity appears (visibility: installed)
bb provider models acp-antigravity
bb thread spawn --provider acp-antigravity --prompt 'hi'
```

## Model and reasoning selection

Antigravity exposes effort variants as separate models (`... Low`, `... Medium`,
and `... High`). Select the desired variant in the model picker. BB reasoning
remains `Medium` because Antigravity's ACP server manages it internally; Fast
mode is unavailable.

## Context window usage reporting

Google's official `agy_acp_server.par` tracks exact token usage inside its local conversation database (`~/.gemini/antigravity-acp/conversations/<sessionId>.db`), but omits emitting `usage_update` over the ACP stdio bridge.

The POSIX install renders a lightweight transparent proxy wrapper as `agy_acp_server.par`, pinning the verified Node interpreter and installed real-binary path while keeping the official raw binary intact (`agy_acp_server_raw.par`). Installation verifies an ACP `initialize` handshake before succeeding. Windows currently runs the raw binary without context usage injection. The POSIX wrapper reads token usage metadata in real time from the session database and injects standard ACP `session/update` (`usage_update`) events with `used` and `size` before turn completion.

This enables BB's native context window tracking and context meter plugins (such as `context-meter`) to display live token usage for Antigravity threads.

## Security notes

- The ACP registry is fetched from a **pinned commit** (`REGISTRY_COMMIT`),
  never from an unpinned branch, so a registry compromise cannot inject an
  arbitrary binary onto PATH.
- The download source is explicit: the pinned registry URL, or an explicit
  `--from` flag. There is no environment-variable redirect.
- Extraction validates archive entries and refuses `../`/absolute paths.
- No code from this plugin executes the downloaded file except impossible —
  the server binary itself (`agy_acp_server.par`), which is Google's official
  release, is what the provider runs.

## Auth

Auth is handled in-band by the ACP server (Google account OAuth, Gemini API
key, Agent Platform). First run surfaces a login flow in the thread. State
lives under `~/.gemini/antigravity-acp/settings.json`.
