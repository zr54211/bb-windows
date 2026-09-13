import assert from "node:assert/strict";
import test from "node:test";
import { FALLBACK_DIST, localizeLaunchSpec } from "../install.ts";

const targets = {
  darwin: { platform: "darwin", arch: "aarch64", distKey: "darwin-aarch64", binaryName: "agy_acp_server.par", isWindows: false },
  linux: { platform: "linux", arch: "x86_64", distKey: "linux-x86_64", binaryName: "agy_acp_server.par", isWindows: false },
  win: { platform: "win32", arch: "x86_64", distKey: "windows-x86_64", binaryName: "agy_acp_server.exe", isWindows: true },
};

test("localizeLaunchSpec — rewrites command/args per host platform, keeps env", () => {
  // linux spec arriving on a darwin host loses --uid=
  const linuxSpec = { command: "agy_acp_server.par", args: ["--uid="], env: { BB_ANTIGRAVITY_DEFAULT_MODEL: "gemini-3.8-flash" } };
  localizeLaunchSpec(linuxSpec, targets.darwin);
  assert.deepEqual(linuxSpec.args, []);
  assert.equal(linuxSpec.command, "agy_acp_server.par");
  assert.equal(linuxSpec.env.BB_ANTIGRAVITY_DEFAULT_MODEL, "gemini-3.8-flash");

  // spec arriving on a linux host gains --uid= and the linux command
  const macSpec = { command: "agy_acp_server.par", args: [], env: {} };
  localizeLaunchSpec(macSpec, targets.linux);
  assert.deepEqual(macSpec.args, FALLBACK_DIST["linux-x86_64"].args);
  assert.equal(macSpec.command, "agy_acp_server.par");

  // windows host gets the .exe command
  const winSpec = { command: "agy_acp_server.par", args: [] };
  localizeLaunchSpec(winSpec, targets.win);
  assert.equal(winSpec.command, "agy_acp_server.exe");
});

test("localizeLaunchSpec — missing spec is a no-op", () => {
  assert.doesNotThrow(() => localizeLaunchSpec(undefined, targets.darwin));
});
