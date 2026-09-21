#!/usr/bin/env node
import readline from "node:readline";

const sessionId = "session-123";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
  } else if (message.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      method: "session/request_permission",
      params: { sessionId, permission: "test" },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "tool_call", title: "test" } },
    });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    process.stderr.write(`PROMPT_RESPONSE_SENT:${Date.now()}\n`);
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "tool_call", title: "after-prompt" } },
    });
  }
});

rl.on("close", () => process.exit(0));
