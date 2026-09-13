import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import test from "node:test";
import { renderWrapperScript } from "../wrapper-script.ts";

function varint(value) {
  const bytes = [];
  while (value >= 128) {
    bytes.push((value & 127) | 128);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return bytes;
}

function field(fieldNumber, wireType, value) {
  return [...varint((fieldNumber << 3) | wireType), ...value];
}

function usageMetadata() {
  const usage = [
    ...field(5, 0, varint(1200)),
    ...field(2, 0, varint(300)),
  ];
  const size = [...field(4, 0, varint(1_000_000))];
  return Buffer.from([
    ...field(9, 2, [...varint(usage.length), ...usage]),
    ...field(24, 2, [...varint(size.length), ...size]),
  ]);
}

// Regression guard: current server builds omit field 5 and only send field 2.
function usageMetadataOnlyUncached() {
  const usage = [
    ...field(2, 0, varint(11_452)),
  ];
  const size = [...field(4, 0, varint(1_000_000))];
  return Buffer.from([
    ...field(9, 2, [...varint(usage.length), ...usage]),
    ...field(24, 2, [...varint(size.length), ...size]),
  ]);
}

function collectLines(child) {
  const events = [];
  const waiters = [];
  let error = "";
  child.stderr.on("data", (chunk) => { error += chunk.toString(); });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const event = { line: JSON.parse(line), emittedAt: Date.now() };
    events.push(event);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].predicate(event.line)) waiters.splice(i, 1)[0].resolve(event);
    }
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, error, events, lines: events.map(({ line }) => line) });
    });
  });
  return {
    done,
    waitFor(predicate) {
      const event = events.find(({ line }) => predicate(line));
      if (event) return Promise.resolve(event);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
  };
}

test("proxies ACP lines and emits usage for the matching prompt session", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-wrapper-test-"));
  const geminiHome = join(root, "gemini");
  const conversations = join(geminiHome, "antigravity-acp", "conversations");
  await mkdir(conversations, { recursive: true });
  const db = new DatabaseSync(join(conversations, "session-123.db"));
  db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE steps (idx INTEGER, step_type INTEGER, metadata BLOB)");
  db.prepare("INSERT INTO steps VALUES (?, ?, ?)").run(1, 15, usageMetadata());
  db.close();

  const wrapper = join(root, "agy_acp_server.par");
  await writeFile(wrapper, renderWrapperScript({ nodePath: process.execPath, realBinaryPath: null }), { mode: 0o755 });
  const fake = join(root, "fake-agent.mjs");
  await copyFile(join(process.cwd(), "test/fixtures/fake-agent.mjs"), fake);
  await chmod(fake, 0o755);
  const child = spawn(
    process.platform === "win32" ? process.execPath : wrapper,
    process.platform === "win32" ? [wrapper] : [],
    {
      env: { ...process.env, ANTIGRAVITY_REAL_SERVER_PATH: fake, GEMINI_HOME: geminiHome },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const collector = collectLines(child);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }) + "\r\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} }) + "\r\n");
  await collector.waitFor((line) => line.id === 2 && line.result?.sessionId === "session-123");
  const lockDb = new DatabaseSync(join(conversations, "session-123.db"));
  lockDb.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
  let lockReleased = false;
  const releaseLock = setTimeout(() => {
    lockDb.exec("ROLLBACK");
    lockDb.close();
    lockReleased = true;
  }, 80);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "session-123" } }));
  child.stdin.end();

  const result = await collector.done;
  clearTimeout(releaseLock);
  if (!lockReleased) {
    lockDb.exec("ROLLBACK");
    lockDb.close();
  }
  assert.equal(result.code, 0, `${result.signal ?? "no signal"}: ${result.error}`);
  const permissionIndex = result.lines.findIndex((line) => line.method === "session/request_permission");
  assert.notEqual(permissionIndex, -1);
  assert.deepEqual(result.lines[permissionIndex], {
    jsonrpc: "2.0",
    id: 3,
    method: "session/request_permission",
    params: { sessionId: "session-123", permission: "test" },
  });
  assert.notEqual(result.lines[permissionIndex + 1]?.params?.update?.sessionUpdate, "usage_update");
  const usageLines = result.lines.filter((line) => line.params?.update?.sessionUpdate === "usage_update");
  assert.equal(usageLines.length, 1);
  assert.deepEqual(usageLines[0].params, {
    sessionId: "session-123",
    update: { sessionUpdate: "usage_update", used: 1500, size: 1_000_000 },
  });
  const promptResponseIndex = result.lines.findIndex((line) => line.id === 3 && line.result);
  assert.equal(usageLines[0].params.sessionId, "session-123");
  assert.equal(result.lines.filter((line, index) => index < promptResponseIndex && line.params?.update?.sessionUpdate === "usage_update").length, 1);
  assert.equal(usageLines[0] === result.lines[promptResponseIndex - 1], true);
  const responseEvent = result.events[promptResponseIndex];
  const sentAt = Number(/PROMPT_RESPONSE_SENT:(\d+)/u.exec(result.error)?.[1]);
  assert.ok(Number.isFinite(sentAt));
  assert.ok(responseEvent.emittedAt - sentAt >= 50, `response was delayed only ${responseEvent.emittedAt - sentAt}ms`);
  const afterPromptIndex = result.lines.findIndex((line) => line.params?.update?.title === "after-prompt");
  assert.ok(afterPromptIndex > promptResponseIndex);
});

test("emits usage when the server omits cached-token field 5", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-wrapper-test-"));
  const geminiHome = join(root, "gemini");
  const conversations = join(geminiHome, "antigravity-acp", "conversations");
  await mkdir(conversations, { recursive: true });
  const db = new DatabaseSync(join(conversations, "session-123.db"));
  db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE steps (idx INTEGER, step_type INTEGER, metadata BLOB)");
  db.prepare("INSERT INTO steps VALUES (?, ?, ?)").run(1, 15, usageMetadataOnlyUncached());
  db.close();

  const wrapper = join(root, "agy_acp_server.par");
  await writeFile(wrapper, renderWrapperScript({ nodePath: process.execPath, realBinaryPath: null }), { mode: 0o755 });
  const fake = join(root, "fake-agent.mjs");
  await copyFile(join(process.cwd(), "test/fixtures/fake-agent.mjs"), fake);
  await chmod(fake, 0o755);
  const child = spawn(
    process.platform === "win32" ? process.execPath : wrapper,
    process.platform === "win32" ? [wrapper] : [],
    {
      env: { ...process.env, ANTIGRAVITY_REAL_SERVER_PATH: fake, GEMINI_HOME: geminiHome },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const collector = collectLines(child);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }) + "\r\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} }) + "\r\n");
  await collector.waitFor((line) => line.id === 2 && line.result?.sessionId === "session-123");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "session-123" } }));
  child.stdin.end();

  const result = await collector.done;
  assert.equal(result.code, 0, `${result.signal ?? "no signal"}: ${result.error}`);
  const usageLines = result.lines.filter((line) => line.params?.update?.sessionUpdate === "usage_update");
  assert.equal(usageLines.length, 1);
  assert.deepEqual(usageLines[0].params.update, { sessionUpdate: "usage_update", used: 11_452, size: 1_000_000 });
  assert.equal(usageLines[0].params.sessionId, "session-123");
});
