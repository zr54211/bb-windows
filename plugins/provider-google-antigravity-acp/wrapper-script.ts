export interface WrapperScriptOptions {
  nodePath: string | null;
  realBinaryPath: string | null;
}

export function renderWrapperScript(opts: WrapperScriptOptions): string {
  const shebang = opts.nodePath ? `#!${opts.nodePath}` : "#!/usr/bin/env node";
  return `${shebang}

// agy-acp-wrapper
/**
 * Antigravity ACP usage proxy. The installer pins both the Node interpreter
 * and the real server path so this file remains self-contained on PATH.
 */
const INSTALLED_REAL_BINARY = ${JSON.stringify(opts.realBinaryPath)};

process.removeAllListeners("warning");

const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { existsSync, realpathSync } = require("node:fs");
const { constants: { signals } } = require("node:os");
const { homedir } = require("node:os");
const { dirname, join } = require("node:path");
const readline = require("node:readline");

function resolveRealBinary() {
  if (process.env.ANTIGRAVITY_REAL_SERVER_PATH) {
    return process.env.ANTIGRAVITY_REAL_SERVER_PATH;
  }
  if (INSTALLED_REAL_BINARY && existsSync(INSTALLED_REAL_BINARY)) {
    return INSTALLED_REAL_BINARY;
  }

  const isWindows = process.platform === "win32";
  const binaryName = isWindows ? "agy_acp_server.exe" : "agy_acp_server.par";
  const rawBinaryName = isWindows ? "agy_acp_server_raw.exe" : "agy_acp_server_raw.par";

  let wrapperDir = null;
  try {
    wrapperDir = dirname(realpathSync(process.argv[1]));
  } catch {}
  if (wrapperDir) {
    const adjacentRaw = join(wrapperDir, rawBinaryName);
    if (existsSync(adjacentRaw)) return adjacentRaw;
  }

  const optPath = join(homedir(), ".local", "opt", "agy-acp-server", binaryName);
  if (existsSync(optPath)) return optPath;

  const rawBin = join(homedir(), ".local", "bin", rawBinaryName);
  if (existsSync(rawBin)) return rawBin;

  const pathDirs = (process.env.PATH ?? "").split(isWindows ? ";" : ":");
  let selfReal = null;
  try {
    selfReal = realpathSync(process.argv[1]);
  } catch {}
  for (const dir of pathDirs) {
    const candidate = join(dir || ".", binaryName);
    if (!existsSync(candidate)) continue;
    try {
      if (selfReal && realpathSync(candidate) === selfReal) continue;
    } catch {}
    return candidate;
  }

  throw new Error(
    \`Antigravity server binary "\${binaryName}" not found. Run "bb google-antigravity-acp install" to install it.\`,
  );
}

function parsePbVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  while (offset < buf.length) {
    const byte = BigInt(buf[offset++]);
    result |= (byte & 0x7fn) << shift;
    if (!(byte & 0x80n)) {
      const value = Number(result);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid protobuf integer");
      return [value, offset];
    }
    shift += 7n;
    if (shift > 63n) throw new Error("invalid protobuf varint");
  }
  throw new Error("truncated protobuf varint");
}

function parsePb(buf) {
  const fields = [];
  let offset = 0;
  while (offset < buf.length) {
    let tag;
    [tag, offset] = parsePbVarint(buf, offset);
    const fieldNum = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (wireType === 0) {
      let value;
      [value, offset] = parsePbVarint(buf, offset);
      fields.push({ fieldNum, wireType, value });
    } else if (wireType === 2) {
      let length;
      [length, offset] = parsePbVarint(buf, offset);
      if (offset + length > buf.length) throw new Error("truncated protobuf field");
      const value = buf.subarray(offset, offset + length);
      offset += length;
      fields.push({ fieldNum, wireType, value });
    } else if (wireType === 1) {
      if (offset + 8 > buf.length) throw new Error("truncated protobuf field");
      offset += 8;
    } else if (wireType === 5) {
      if (offset + 4 > buf.length) throw new Error("truncated protobuf field");
      offset += 4;
    } else {
      throw new Error("unsupported protobuf wire type");
    }
  }
  return fields;
}

function extractContextUsage(dbPath) {
  // Synchronous by design: local single-row indexed reads are fast and throttled, a worker thread is not worth it.
  if (!existsSync(dbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare(
        "SELECT metadata FROM steps WHERE step_type = 15 AND metadata IS NOT NULL ORDER BY idx DESC LIMIT 1",
      )
      .get();
    if (!row || !row.metadata) return null;
    const fields = parsePb(row.metadata);
    let used = null;
    let size = null;
    for (const field of fields) {
      if (field.fieldNum === 9) {
        if (field.wireType !== 2) return null;
        const usageFields = parsePb(field.value);
        let first = null;
        let second = null;
        for (const nested of usageFields) {
          if (nested.fieldNum !== 5 && nested.fieldNum !== 2) continue;
          if (nested.wireType !== 0 || !Number.isSafeInteger(nested.value) || nested.value < 0) return null;
          if (nested.fieldNum === 5) first = nested.value;
          if (nested.fieldNum === 2) second = nested.value;
        }
        // Server builds put prompt tokens in field 2 and omit field 5, so treat either as optional.
        if (first !== null || second !== null) {
          const total = (first ?? 0) + (second ?? 0);
          if (!Number.isSafeInteger(total) || total < 0) return null;
          used = total;
        }
      }
      if (field.fieldNum === 24) {
        if (field.wireType !== 2) return null;
        const sizeFields = parsePb(field.value);
        for (const nested of sizeFields) {
          if (nested.fieldNum !== 4) continue;
          if (nested.wireType !== 0 || !Number.isSafeInteger(nested.value) || nested.value < 0) return null;
          size = nested.value;
        }
      }
    }
    if (used === null || size === null || size === 0 || used > size) return null;
    return { used, size };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function signalNumber(signal) {
  return typeof signals[signal] === "number" ? signals[signal] : 1;
}

function main() {
  const realBin = resolveRealBinary();
  // Linux builds segfault without --uid=; the launch spec may come from a machine that never saw the registry args, so ensure it here.
  const childArgs = process.argv.slice(2);
  if (process.platform === "linux" && !childArgs.includes("--uid=")) childArgs.push("--uid=");
  const isScript = process.platform === "win32" && (realBin.endsWith(".mjs") || realBin.endsWith(".js"));
  const spawnBin = isScript ? process.execPath : realBin;
  const spawnArgs = isScript ? [realBin, ...childArgs] : childArgs;
  const child = spawn(spawnBin, spawnArgs, {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });
  const pendingClientRequests = new Map();
  const lastUsedBySession = new Map();
  const lastIntermediateReadAt = new Map();
  const outQueue = [];
  const outputDrainWaiters = [];
  const geminiHome = process.env.GEMINI_HOME || join(homedir(), ".gemini");
  let acceptingClientInput = true;
  let extractionErrorLogged = false;
  let rlOutClosed = false;
  let pumpBlocked = false;
  let pumping = false;
  let outputAbandoned = false;

  const errorMessage = (err) => err?.message || String(err);
  const logWrapperError = (err) => {
    process.stderr.write(\`[agy-acp-wrapper] \${errorMessage(err)}\\n\`);
  };
  const logExtractionError = (err) => {
    if (extractionErrorLogged) return;
    extractionErrorLogged = true;
    logWrapperError(err);
  };

  const isBusyError = (err) => {
    const code = err?.code;
    const message = String(err?.message || err).toLowerCase();
    return String(code).includes("SQLITE_BUSY") || String(code).includes("SQLITE_LOCKED") || message.includes("sqlite_busy") || message.includes("locked");
  };

  const getDbPath = (sessionId) => sessionId
    ? join(geminiHome, "antigravity-acp", "conversations", String(sessionId) + ".db")
    : null;

  const readUsage = (sessionId) => {
    const dbPath = getDbPath(sessionId);
    if (!dbPath) return null;
    try {
      return { usage: extractContextUsage(dbPath), busy: false };
    } catch (err) {
      if (isBusyError(err)) return { usage: null, busy: true };
      logExtractionError(err);
      return { usage: null, busy: false };
    }
  };

  const resolveOutputDrainWaiters = () => {
    if (!outputAbandoned && (!rlOutClosed || outQueue.length > 0 || pumpBlocked)) return;
    while (outputDrainWaiters.length) outputDrainWaiters.shift()();
  };

  const waitForOutputDrain = () => {
    if (outputAbandoned || (rlOutClosed && outQueue.length === 0 && !pumpBlocked)) return Promise.resolve();
    return new Promise((resolve) => outputDrainWaiters.push(resolve));
  };

  let pump = () => {};
  const pipeLine = (dest, rl, data) => {
    if (dest === process.stdout && outputAbandoned) return true;
    const written = dest.write(data);
    if (!written) {
      if (dest === process.stdout) {
        // Stop reading the child until the client drains.
        pumpBlocked = true;
        rlOut.pause();
        dest.once("drain", () => {
          pumpBlocked = false;
          rlOut.resume();
          pump();
          resolveOutputDrainWaiters();
        });
      } else {
        rl.pause();
        dest.once("drain", () => rl.resume());
      }
    }
    return written;
  };

  const emitUsageUpdate = (sessionId, usage) => {
    if (!usage || lastUsedBySession.get(sessionId)?.used === usage.used && lastUsedBySession.get(sessionId)?.size === usage.size) {
      return;
    }
    lastUsedBySession.set(sessionId, usage);
    pipeLine(
      process.stdout,
      rlOut,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "usage_update", used: usage.used, size: usage.size },
        },
      }) + "\\n",
    );
  };

  const maybeEmitUsageUpdate = (sessionId) => {
    if (!sessionId) return;
    const lastRead = lastIntermediateReadAt.get(sessionId);
    const now = Date.now();
    if (lastRead !== undefined && now - lastRead < 750) return;
    lastIntermediateReadAt.set(sessionId, now);
    const result = readUsage(sessionId);
    if (!result?.busy) {
      emitUsageUpdate(sessionId, result?.usage);
    }
  };

  const handlePromptResponse = (sessionId, line) => {
    const first = readUsage(sessionId);
    if (!first?.busy) {
      emitUsageUpdate(sessionId, first?.usage);
      pipeLine(process.stdout, rlOut, line + "\\n");
      return;
    }

    pumpBlocked = true;
    let retries = 0;
    const retry = () => {
      const next = readUsage(sessionId);
      if (!next?.busy || retries >= 2) {
        pumpBlocked = false;
        emitUsageUpdate(sessionId, next?.usage);
        pipeLine(process.stdout, rlOut, line + "\\n");
        pump();
        resolveOutputDrainWaiters();
        return;
      }
      retries += 1;
      setTimeout(retry, 50);
    };
    setTimeout(retry, 50);
  };

  const rlIn = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rlIn.on("line", (line) => {
    if (!acceptingClientInput) return;
    if (line.trim()) {
      try {
        const msg = JSON.parse(line);
        if (msg && msg.method !== undefined && msg.id !== undefined) {
          const trackedMethods = new Set(["session/prompt", "session/load", "session/resume"]);
          pendingClientRequests.set(msg.id, {
            method: msg.method,
            sessionId: trackedMethods.has(msg.method) ? msg.params?.sessionId ?? null : null,
          });
        }
      } catch {}
    }
    // The rendered source must preserve the normal child.stdin.write(line + "\\n") form.
    pipeLine(child.stdin, rlIn, line + "\\n");
  });
  rlIn.on("close", () => {
    acceptingClientInput = false;
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
  });

  const rlOut = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rlOut.on("close", () => {
    rlOutClosed = true;
    resolveOutputDrainWaiters();
  });
  rlOut.on("line", (line) => {
    outQueue.push(line);
    pump();
  });

  // Drain the queue iteratively until empty or a step blocks the pump.
  pump = () => {
    if (pumping) return;
    pumping = true;
    try {
      while (!pumpBlocked && !outputAbandoned && outQueue.length > 0) {
        processLine(outQueue.shift());
      }
    } finally {
      pumping = false;
    }
    resolveOutputDrainWaiters();
  };

  const processLine = (line) => {
    if (!line.trim()) {
      pipeLine(process.stdout, rlOut, line + "\\n");
    } else {
      let msg;
      let parseFailed = false;
      try {
        msg = JSON.parse(line);
      } catch {
        parseFailed = true;
        pipeLine(process.stdout, rlOut, line + "\\n");
      }
      if (!parseFailed && msg && typeof msg === "object") {
        const isResponse = msg && typeof msg === "object" && msg.method === undefined && ("result" in msg || "error" in msg) && pendingClientRequests.has(msg.id);
        const request = isResponse ? pendingClientRequests.get(msg.id) : null;
        if (isResponse) pendingClientRequests.delete(msg.id);

        if (isResponse && request?.method === "session/prompt") {
          handlePromptResponse(request.sessionId, line);
        } else {
          // Forward the child line before deriving any intermediate usage event.
          pipeLine(process.stdout, rlOut, line + "\\n");
          if (msg.method === "session/update") {
            const updateKind = msg.params?.update?.sessionUpdate;
            if (updateKind === "tool_call" || updateKind === "plan") {
              maybeEmitUsageUpdate(msg.params?.sessionId);
            }
          }
        }
      } else if (!parseFailed) {
        pipeLine(process.stdout, rlOut, line + "\\n");
      }
    }
  };

  child.stdin.on("close", () => {
    acceptingClientInput = false;
  });
  child.stdin.on("error", (err) => {
    acceptingClientInput = false;
    logWrapperError(err);
  });
  child.stdout.on("error", (err) => {
    logWrapperError(err);
  });
  process.stdout.on("error", (err) => {
    acceptingClientInput = false;
    if (err.code === "EPIPE") {
      // The client went away: drop pending output and stop cleanly.
      outputAbandoned = true;
      outQueue.length = 0;
      pumpBlocked = false;
      rlOut.resume();
      process.exitCode = 0;
      resolveOutputDrainWaiters();
      if (!child.killed) child.kill("SIGTERM");
    } else {
      logWrapperError(err);
    }
  });
  process.stdin.on("error", (err) => {
    logWrapperError(err);
  });

  child.on("error", (err) => {
    acceptingClientInput = false;
    logWrapperError(new Error(\`Antigravity wrapper child error: \${err.message}\`));
  });
  child.on("close", async (code, signal) => {
    acceptingClientInput = false;
    rlIn.close();
    await waitForOutputDrain();
    // A client disconnect (EPIPE) is a clean exit, not an agent failure.
    if (!outputAbandoned) process.exitCode = code ?? (signal ? 128 + signalNumber(signal) : 1);
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
}

main();
`;
}
