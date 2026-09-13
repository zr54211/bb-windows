# Google Antigravity (ACP) for bb

Run bb threads on Google Antigravity through its official ACP server
(agy_acp_server.par).

## What it does

Registers the provider `acp-antigravity` in bb with full ACP support: dynamic
model catalog with per-model reasoning effort, session resume, in-band Google
authentication (account, Gemini API key, or Agent Platform), and health-gated
visibility — the provider only appears on machines where the server binary is
installed and the probe passes.

On macOS, a wrapper around the official binary reports exact token usage to
bb, so native context tracking and context-meter plugins show live usage for
Antigravity threads.

Install the plugin:

```sh
bb plugin install git:github.com/rawizhere/bb-plugin-antigravity-acp --yes
```

## Machine install

`bb google-antigravity-acp install` downloads the official zip, extracts it
without `tar` (validates zip entries against `../`/absolute paths), links the
server binary and sandbox helper onto PATH per machine, and can update PATH
on Windows with `--update-path`.
`bb google-antigravity-acp status` shows the resolved binary and provider
state. Installs run via host RPC on the machine where the daemon executes.

## Links

- Repository: https://github.com/rawizhere/bb-plugin-antigravity-acp
- bb: https://github.com/get-bb/bb
