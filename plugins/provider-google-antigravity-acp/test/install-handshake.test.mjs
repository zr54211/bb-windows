import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { verifyAcpHandshake } from "../install.ts";

test("verifies the ACP initialize handshake and times out silent agents", async () => {
  const fake = join(process.cwd(), "test/fixtures/fake-agent.mjs");
  const never = join(process.cwd(), "test/fixtures/never-agent.mjs");
  const ok = await verifyAcpHandshake(process.execPath, [fake]);
  assert.deepEqual(ok, { ok: true, error: null });
  const started = Date.now();
  const failed = await verifyAcpHandshake(process.execPath, [never], 2_000);
  assert.equal(failed.ok, false);
  assert.ok(Date.now() - started < 5_000);
});
