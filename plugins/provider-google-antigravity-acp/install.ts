// Install logic for the Antigravity ACP server, runs on the target machine from the host entry or directly in the server process.
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants as fsConstants, createWriteStream } from "node:fs";
import { access, chmod, copyFile, mkdir, open, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import * as readline from "node:readline";
import { renderWrapperScript } from "./wrapper-script.ts";

const execFileAsync = promisify(execFile);

function stderrTail(stderr: string): string {
  return stderr.slice(-500).trim();
}

async function terminateChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      resolve();
    };
    child.once("close", done);
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      done();
    }, 2_000);
    killTimer.unref();
  });
}

export async function verifyAcpHandshake(
  command: string,
  args: string[],
  timeoutMs = 20_000,
): Promise<{ ok: boolean; error: string | null }> {
  const handshakeEnv = { ...process.env };
  delete handshakeEnv.ANTIGRAVITY_REAL_SERVER_PATH;
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: handshakeEnv });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr = stderrTail(stderr + chunk.toString());
  });

  const result = await new Promise<{ ok: boolean; reason: string | null }>((resolveResult) => {
    let settled = false;
    const rl = child.stdout ? readline.createInterface({ input: child.stdout, crlfDelay: Infinity }) : null;
    let timer: NodeJS.Timeout;

    const settle = (ok: boolean, reason: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl?.close();
      void terminateChild(child).finally(() => resolveResult({ ok, reason }));
    };

    timer = setTimeout(() => settle(false, "ACP initialize handshake timed out"), timeoutMs);
    timer.unref();

    rl?.on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        settle(false, "ACP initialize handshake returned invalid JSON");
        return;
      }
      if (
        message &&
        typeof message === "object" &&
        (message as { id?: unknown }).id === 1 &&
        (message as { result?: { protocolVersion?: unknown } }).result?.protocolVersion !== undefined
      ) {
        settle(true, null);
      }
    });
    child.once("error", (error) => settle(false, `Could not start ACP server: ${error.message}`));
    child.once("close", () => {
      if (!settled) settle(false, "ACP server exited before completing initialize");
    });

    child.stdin?.on("error", (error) => {
      if (!settled) settle(false, `Could not write ACP initialize request: ${error.message}`);
    });
    child.stdin?.end(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    }) + "\n");
  });

  if (result.ok) return { ok: true, error: null };
  const tail = stderrTail(stderr);
  return { ok: false, error: [result.reason, tail].filter(Boolean).join(" — stderr: ") };
}

export interface DistEntry {
  archive: string;
  cmd: string;
  args?: string[];
}

export type DistMap = Record<string, DistEntry>;

// Pinned ACP registry commit. Bump when tracking newer releases.
export const REGISTRY_COMMIT = "81bf71b55e15f630c4fb8a86d20d3088071d2071";
const REGISTRY_URL = `https://raw.githubusercontent.com/agentclientprotocol/registry/${REGISTRY_COMMIT}/antigravity-acp/agent.json`;

// Copy of the ACP registry entry for when the pinned registry fetch fails.
export const FALLBACK_DIST: DistMap = {
  "darwin-aarch64": {
    archive:
      "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip",
    cmd: "./agy_acp_server.par",
  },
  "linux-x86_64": {
    archive:
      "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-x86_64.zip",
    cmd: "./agy_acp_server.par",
    args: ["--uid="],
  },
  "linux-aarch64": {
    archive:
      "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-arm64.zip",
    cmd: "./agy_acp_server.par",
    args: ["--uid="],
  },
  "windows-x86_64": {
    archive:
      "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-x86_64.zip",
    cmd: "./agy_acp_server.exe",
  },
  "windows-aarch64": {
    archive:
      "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-arm64.zip",
    cmd: "./agy_acp_server.exe",
  },
};

export interface InstallOptions {
  installDir: string;
  binDir: string;
  force: boolean;
  /**
   * Windows only: when true, append binDir to the user PATH via setx
   * (permanent HKCU\Environment mutation) after linking. Defaults to false —
   * prefer an explicit opt-in over a silent persistent PATH edit.
   */
  updatePath?: boolean;
  /** Optional explicit source: a zip URL or a local zip path. Skips the ACP registry lookup. */
  source?: string;
}

export interface InstallResult {
  ok: boolean;
  platform: string;
  arch: string;
  distKey: string;
  url: string;
  args: string[];
  registryCommit: string;
  installDir: string;
  binDir: string;
  binaryPath: string | null;
  harnessPath: string | null;
  alreadyInstalled: boolean;
  error: string | null;
  notes: string[];
}

export interface ProbeResult {
  ok: boolean;
  platform: string;
  arch: string;
  binaryPath: string | null;
  harnessPath: string | null;
  error: string | null;
}

const MANIFEST = ".google-antigravity-acp.json";

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  if (p.startsWith("$HOME/")) return join(homedir(), p.slice(6));
  return p;
}

export interface TargetInfo {
  platform: string;
  arch: string;
  distKey: string;
  binaryName: string;
  isWindows: boolean;
}

// Launch specs are built on the bb server machine but spawn on a host; fix command/args for the spawning machine (env carries settings and stays untouched).
export function localizeLaunchSpec(
  spec: { command: string; args: string[] } | undefined,
  t = detectTarget(),
) {
  if (!spec) return;
  spec.command = t.binaryName;
  spec.args = FALLBACK_DIST[t.distKey]?.args ?? [];
}

export function detectTarget(): TargetInfo {
  const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return {
    platform,
    arch,
    distKey: `${platform}-${arch}`,
    binaryName: platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par",
    isWindows: platform === "win32",
  };
}

export async function fetchDistMap(): Promise<DistMap> {
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return FALLBACK_DIST;
    const json = (await res.json()) as {
      distribution?: { binary?: Record<string, { archive?: unknown; cmd?: unknown; args?: unknown }> };
    };
    const binary = json.distribution?.binary;
    if (!binary) return FALLBACK_DIST;
    const map: DistMap = {};
    for (const [key, entry] of Object.entries(binary)) {
      if (typeof entry.archive === "string" && typeof entry.cmd === "string") {
        map[key] = {
          archive: entry.archive,
          cmd: entry.cmd,
          args: Array.isArray(entry.args) ? entry.args.map((a) => String(a)) : undefined,
        };
      }
    }
    return Object.keys(map).length > 0 ? map : FALLBACK_DIST;
  } catch {
    return FALLBACK_DIST;
  }
}

async function findOnPath(name: string): Promise<string | null> {
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(process.platform === "win32" ? ";" : ":");
  const patterns = process.platform === "win32"
    ? [name, ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean).map((ext) => name + ext)]
    : [name];
  for (const dir of dirs) {
    for (const candidate of patterns) {
      try {
        const full = join(dir || ".", candidate);
        const s = await stat(full);
        if (s.isFile()) return full;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (HTTP ${res.status}) from ${url}`);
  }
  // undici and node type the ReadableStream differently; same object at runtime.
  await pipeline(
    Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
    createWriteStream(dest),
  );
}

// Python extraction that validates entry names, then extracts with zipfile.
const PYTHON_EXTRACT = String.raw`
import sys, zipfile
path, dest = sys.argv[1], sys.argv[2]
zf = zipfile.ZipFile(path)
for name in zf.namelist():
    if name.startswith(("/", "\\")) or ":" in name.split("/", 1)[0]:
        print("unsafe zip entry: " + name, file=sys.stderr)
        sys.exit(1)
    parts = name.replace("\\", "/").split("/")
    if any(p in ("..", "") for p in parts[:-1]):
        print("unsafe zip entry: " + name, file=sys.stderr)
        sys.exit(1)
zf.extractall(dest)
`;

async function extractZip(zipPath: string, destDir: string, isWindows: boolean): Promise<void> {
  if (isWindows) {
    // Expand-Archive rejects entries that escape the destination; bsdtar does not.
    await execFileAsync(
      "powershell",
      [
        "-NoProfile", "-NonInteractive", "-Command",
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
      ],
      { windowsHide: true },
    );
    return;
  }
  // Prefer unzip, fall back to python3 zipfile. Never tar: it does not sanitize ../ entries.
  const attempts: Array<[string, string[]]> = [
    ["unzip", ["-oq", zipPath, "-d", destDir]],
    ["python3", ["-c", PYTHON_EXTRACT, zipPath, destDir]],
  ];
  let lastError: Error | null = null;
  for (const [cmd, args] of attempts) {
    try {
      await execFileAsync(cmd, args);
      return;
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw lastError ?? new Error(`No safe extractor found for ${zipPath}`);
}

async function helperNameIn(installDir: string, isWindows: boolean): Promise<string | null> {
  const expected = isWindows ? /^localharness[^/\\]*\.exe$/i : /^localharness[^/\\]*$/i;
  const entries = await readdir(installDir).catch(() => [] as string[]);
  return entries.find((name) => expected.test(name)) ?? null;
}

async function ensureLinked(
  installDir: string,
  binDir: string,
  name: string,
  isWindows: boolean,
  notes: string[],
  sourceName = name,
): Promise<string> {
  const target = join(installDir, sourceName);
  const link = join(binDir, name);
  if (isWindows) {
    await copyFile(target, link);
    return link;
  }
  try {
    await rm(link, { force: true });
    await symlink(target, link);
    return link;
  } catch (err) {
    notes.push(`Symlink ${name} failed in ${binDir}: ${(err as Error).message}. Copied instead.`);
    await copyFile(target, link);
    return link;
  }
}

async function installWrapper(
  binDir: string,
  binaryName: string,
  nodePath: string,
  realBinaryPath: string,
  args: string[],
  notes: string[],
): Promise<string> {
  const wrapperTarget = join(binDir, binaryName);
  const stagedTarget = join(
    binDir,
    `.agy_acp_server.par.staging-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  try {
    await rm(stagedTarget, { force: true });
    await writeFile(stagedTarget, renderWrapperScript({ nodePath, realBinaryPath }), { mode: 0o755 });
    const handshake = await verifyAcpHandshake(stagedTarget, args);
    if (!handshake.ok) {
      throw new Error(handshake.error ?? "unknown error");
    }
    await rename(stagedTarget, wrapperTarget);
  } catch (err) {
    await rm(stagedTarget, { force: true }).catch(() => {});
    throw new Error(`ACP wrapper handshake/install failed: ${(err as Error).message}`);
  }
  notes.push(`Installed ACP context usage proxy wrapper: ${wrapperTarget}`);
  return wrapperTarget;
}

// The host entry runs under Electron, so probe real node candidates instead of process.execPath.
async function nodeCandidates(): Promise<string[]> {
  const out: string[] = [];
  const push = (p: string | null | undefined) => {
    if (p && !out.includes(p)) out.push(p);
  };
  push(process.env.ANTIGRAVITY_NODE_PATH?.trim());
  if (/^node(\.exe)?$/iu.test(basename(process.execPath))) push(process.execPath);
  push(await findOnPath("node"));
  const home = homedir();
  for (const dir of [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".volta", "bin"),
    join(home, ".fnm", "aliases", "default", "bin"),
    join(home, ".nvm", "versions", "node"),
  ]) {
    if (dir.endsWith(join(".nvm", "versions", "node"))) {
      const versions = await readdir(dir).catch(() => [] as string[]);
      for (const v of versions.sort().reverse()) push(join(dir, v, "bin", "node"));
      continue;
    }
    push(join(dir, "node"));
  }
  return out;
}

async function verifyNodeInterpreter(): Promise<{ path: string; version: string }> {
  const check = "require('node:sqlite'); process.stdout.write(process.versions.node + '\\n' + process.execPath)";
  const failures: string[] = [];
  for (const candidate of await nodeCandidates()) {
    if (!(await stat(candidate).catch(() => null))?.isFile()) continue;
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(candidate, ["-e", check], { timeout: 10_000 }));
    } catch (err) {
      failures.push(`${candidate}: ${(err as Error).message.split("\n")[0]}`);
      continue;
    }
    const [version = "", execPath = ""] = stdout.trim().split(/\r?\n/u);
    const match = /^(\d+)\.(\d+)\./u.exec(version);
    const major = match ? Number(match[1]) : NaN;
    const minor = match ? Number(match[2]) : NaN;
    if (!match || major < 22 || (major === 22 && minor < 13)) {
      failures.push(`${candidate}: Node ${version || "unknown"} (need 22.13+)`);
      continue;
    }
    const pinned = (await stat(execPath).catch(() => null))?.isFile() ? execPath : candidate;
    return { path: pinned, version };
  }
  throw new Error(
    "No Node 22.13+ interpreter with node:sqlite found for the usage wrapper. " +
    "Install Node or set ANTIGRAVITY_NODE_PATH." +
    (failures.length ? " Tried: " + failures.join("; ") : ""),
  );
}

// setx truncates PATH at 1024 chars, so skip the edit when it gets too long.
async function appendUserPathWindows(binDir: string, updatePath: boolean, notes: string[]): Promise<void> {
  if (!updatePath) {
    notes.push(
      `Not modifying the user PATH. Add ${binDir} to the user PATH manually (or re-run with --update-path).`,
    );
    return;
  }
  try {
    const { stdout } = await execFileAsync("reg", ["query", "HKCU\\Environment", "/v", "Path"], { windowsHide: true });
    const current = stdout.split(/\r?\n/u).find((l) => /^\s*Path\s+REG/i.test(l))?.replace(/^\s*Path\s+REG[A-Z_]*\s+/i, "").trim() ?? "";
    const parts = current.split(";").filter(Boolean);
    if (parts.includes(binDir)) return;
    const next = [...parts, binDir].join(";");
    if (next.length > 1024) {
      notes.push(
        `User PATH would exceed setx's 1024-char limit after adding ${binDir}; skipping the mutation. Add it manually.`,
      );
      return;
    }
    await execFileAsync("setx", ["Path", next], { windowsHide: true });
    notes.push(`Added ${binDir} to the user PATH (setx). Restart the bb daemon so it takes effect.`);
  } catch (err) {
    notes.push(`Could not update the user PATH: ${(err as Error).message}. Add ${binDir} to PATH manually.`);
  }
}

async function writeManifest(
  installDir: string,
  url: string,
  binaryName: string,
  helper: string | null,
  wrapper: string | null,
  nodePath: string | null,
  args: string[],
  registryCommit: string,
): Promise<void> {
  await writeFile(
    join(installDir, MANIFEST),
    JSON.stringify({ url, binaryName, helper, wrapper, nodePath, args, registryCommit, installedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
}

export async function runInstall(options: InstallOptions): Promise<InstallResult> {
  const notes: string[] = [];
  const target = detectTarget();
  const installDir = expandHome(options.installDir);
  const binDir = expandHome(options.binDir);
  const binaryName = target.binaryName;
  const binaryPath = join(installDir, binaryName);
  const fail = (error: string): InstallResult => ({
    ok: false, platform: target.platform, arch: target.arch, distKey: target.distKey,
    url: "", args: [], registryCommit: REGISTRY_COMMIT, installDir, binDir,
    binaryPath: null, harnessPath: null, alreadyInstalled: false, error, notes,
  });

  const distMap = await fetchDistMap();
  const entry = distMap[target.distKey];
  if (!entry) {
    return fail(
      `No Antigravity ACP distribution for ${target.platform} ${target.arch} in the ACP registry ` +
      `(agentclientprotocol/registry → antigravity-acp). Supported: ${Object.keys(distMap).join(", ")}.`,
    );
  }

  try {
    await mkdir(installDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
  } catch (err) {
    return fail(`Could not create directories: ${(err as Error).message}`);
  }

  // Already installed and not forced: just make sure the links and wrapper are in place.
  const existing = await stat(binaryPath).catch(() => null);
  if (existing?.isFile() && !options.force) {
    try {
      const helper = await helperNameIn(installDir, target.isWindows);
      let link: string;
      let wrapper: string | null = null;
      let nodePath: string | null = null;
      if (target.isWindows) {
        link = await ensureLinked(installDir, binDir, binaryName, true, notes, binaryName);
        notes.push("Context usage injection is not available on Windows yet.");
      } else {
        const node = await verifyNodeInterpreter();
        nodePath = node.path;
        notes.push(`Using verified Node ${node.version} at ${node.path}.`);
        await ensureLinked(installDir, binDir, "agy_acp_server_raw.par", false, notes, binaryName);
        wrapper = await installWrapper(binDir, binaryName, node.path, resolve(installDir, binaryName), entry.args ?? [], notes);
        link = wrapper;
      }
      if (helper) await ensureLinked(installDir, binDir, helper, target.isWindows, notes);
      if (target.isWindows) await appendUserPathWindows(binDir, options.updatePath === true, notes);
      await writeManifest(installDir, entry.archive, binaryName, helper, wrapper, nodePath, entry.args ?? [], REGISTRY_COMMIT);
      notes.push("Binary already present; refreshed symlinks and context usage wrapper without re-downloading.");
      return {
        ok: true, platform: target.platform, arch: target.arch, distKey: target.distKey, url: entry.archive,
        args: entry.args ?? [], registryCommit: REGISTRY_COMMIT,
        installDir, binDir, binaryPath: link, harnessPath: helper ? join(installDir, helper) : null,
        alreadyInstalled: true, error: null, notes,
      };
    } catch (err) {
      return fail(`Binary exists but links could not be refreshed: ${(err as Error).message}`);
    }
  }

  // Explicit --from only; an env-var redirect would silently change what gets downloaded.
  const sourceOverride = options.source?.trim();
  let sourceLabel: string = entry.archive;
  try {
    const zipPath = join(tmpdir(), `agy-acp-${Date.now()}.zip`);
    try {
      if (sourceOverride) {
        sourceLabel = sourceOverride;
        if (/^https?:\/\//i.test(sourceOverride)) {
          notes.push(`Downloading ${sourceOverride}`);
          await downloadTo(sourceOverride, zipPath);
        } else {
          notes.push(`Using local archive ${sourceOverride}`);
          await copyFile(sourceOverride, zipPath);
        }
      } else {
        sourceLabel = entry.archive;
        notes.push(`Downloading ${entry.archive}`);
        await downloadTo(entry.archive, zipPath);
      }
      await extractZip(zipPath, installDir, target.isWindows);
    } finally {
      await rm(zipPath, { force: true });
    }
  } catch (err) {
    return fail(`Download or extraction failed: ${(err as Error).message}`);
  }

  const installed = await stat(binaryPath).catch(() => null);
  if (!installed?.isFile()) {
    return fail(`Extraction finished but ${binaryName} was not found in ${installDir}.`);
  }

  let helper: string | null = null;
  let link: string | null = null;
  let wrapper: string | null = null;
  let nodePath: string | null = null;
  try {
    if (!target.isWindows) {
      await chmod(binaryPath, 0o755);
    }
    helper = await helperNameIn(installDir, target.isWindows);
    if (helper) {
      const full = join(installDir, helper);
      if (!target.isWindows) await chmod(full, 0o755);
      notes.push(`Sandbox helper: ${full}`);
    }
    if (!target.isWindows) {
      const node = await verifyNodeInterpreter();
      nodePath = node.path;
      notes.push(`Using verified Node ${node.version} at ${node.path}.`);
    }
  } catch (err) {
    return fail(`Post-install verification failed: ${(err as Error).message}`);
  }

  try {
    if (target.isWindows) {
      link = await ensureLinked(installDir, binDir, binaryName, true, notes, binaryName);
      notes.push("Context usage injection is not available on Windows yet.");
    } else {
      await ensureLinked(installDir, binDir, "agy_acp_server_raw.par", false, notes, binaryName);
      wrapper = await installWrapper(binDir, binaryName, nodePath!, resolve(installDir, binaryName), entry.args ?? [], notes);
      link = wrapper;
    }
  } catch (err) {
    return fail(`Could not install the ${target.isWindows ? "binary" : "raw link or wrapper"}: ${(err as Error).message}`);
  }
  if (link && helper) {
    await ensureLinked(installDir, binDir, helper, target.isWindows, notes).catch((err) => {
      notes.push(`Linking ${helper} failed: ${(err as Error).message}`);
    });
  }
  if (target.isWindows) {
    await appendUserPathWindows(binDir, options.updatePath === true, notes);
  }
  const harnessPath = helper ? join(installDir, helper) : null;

  const pathDirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  if (!pathDirs.includes(binDir)) {
    notes.push(
      `${binDir} is not on this machine's PATH. Add it, e.g. export PATH="$PATH:${binDir}" in your shell profile.`,
    );
  }

  try {
    await writeManifest(installDir, sourceLabel, binaryName, helper, wrapper, nodePath, entry.args ?? [], REGISTRY_COMMIT);
  } catch (err) {
    notes.push(`Manifest write failed: ${(err as Error).message}`);
  }
  return {
    ok: true, platform: target.platform, arch: target.arch, distKey: target.distKey, url: sourceLabel,
    args: entry.args ?? [], registryCommit: REGISTRY_COMMIT,
    installDir, binDir, binaryPath: link, harnessPath,
    alreadyInstalled: false, error: null, notes,
  };
}

export async function probeLocal(): Promise<ProbeResult> {
  const target = detectTarget();
  const binaryName = target.binaryName;
  const binaryPath = await findOnPath(binaryName);
  let harnessPath: string | null = null;
  const envHarness = process.env.ANTIGRAVITY_HARNESS_PATH?.trim();
  if (envHarness) {
    harnessPath = envHarness;
  } else {
    const probable = join(homedir(), ".local", "opt", "agy-acp-server");
    const helper = await helperNameIn(probable, target.isWindows).catch(() => null);
    if (helper) {
      const candidate = join(probable, helper);
      if ((await stat(candidate).catch(() => null))?.isFile()) harnessPath = candidate;
    }
    if (!harnessPath) harnessPath = await findOnPath("localharness_external" + (target.isWindows ? ".exe" : ""));
  }
  let error: string | null = binaryPath
    ? null
    : `\`${binaryName}\` was not found on PATH. Install it with \`bb google-antigravity-acp install\`.`;
  if (binaryPath && target.isWindows && !(await stat(binaryPath).catch(() => null))?.isFile()) {
    error = `Antigravity launch target ${binaryPath} is not a file.`;
  }
  if (binaryPath && !target.isWindows) {
    try {
      try {
        await access(binaryPath, fsConstants.X_OK);
      } catch {
        error = `Antigravity launch target ${binaryPath} is not executable.`;
      }
      const file = await open(binaryPath, "r");
      let prefix: Buffer;
      try {
        prefix = Buffer.alloc(4096);
        const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
        prefix = prefix.subarray(0, bytesRead);
      } finally {
        await file.close();
      }
      // Install already verified the wrapper end to end, so just check the real binary it points at.
      const prefixText = prefix.toString("utf8");
      const firstLine = prefixText.split(/\r?\n/u, 1)[0];
      if (firstLine.startsWith("#!") && prefixText.includes("agy-acp-wrapper")) {
        const content = await readFile(binaryPath, "utf8");
        const match = /const\s+INSTALLED_REAL_BINARY\s*=\s*(null|"(?:\\.|[^"\\])*")\s*;/u.exec(content);
        if (!match) {
          error = `Antigravity wrapper at ${binaryPath} has no INSTALLED_REAL_BINARY path.`;
        } else {
          const installedPath = JSON.parse(match[1]) as string | null;
          if (!installedPath) {
            error = `Antigravity wrapper at ${binaryPath} has no installed real binary path.`;
          } else {
            if (!(await stat(installedPath).catch(() => null))?.isFile()) {
              error = `Antigravity wrapper at ${binaryPath} points to missing real binary ${installedPath}.`;
            } else {
              try {
                await access(installedPath, fsConstants.X_OK);
              } catch {
                error = `Antigravity wrapper at ${binaryPath} points to non-executable real binary ${installedPath}.`;
              }
            }
          }
        }
      }
    } catch (err) {
      error = `Could not inspect ${binaryPath}: ${(err as Error).message}`;
    }
  }
  return {
    ok: error === null,
    platform: target.platform,
    arch: target.arch,
    binaryPath,
    harnessPath,
    error,
  };
}
