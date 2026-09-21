import assert from "node:assert/strict";
import test from "node:test";
import { renderWrapperScript } from "../wrapper-script.ts";

test("renders a pinned or env-node wrapper and valid JavaScript", () => {
  const pinned = renderWrapperScript({ nodePath: "/custom/node", realBinaryPath: "/opt/agy/agy_acp_server.par" });
  assert.equal(pinned.split("\n", 1)[0], "#!/custom/node");
  assert.match(pinned, /const INSTALLED_REAL_BINARY = "/);
  assert.match(pinned, /childArgs\.includes\("--uid="\)/);
  assert.match(pinned, /child\.stdin\.write\(line \+ "\\n"\)/);
  assert.doesNotMatch(pinned, /child\.stdin\.write\(line \+ "\\\\n"\)/);
  assert.doesNotThrow(() => new Function(pinned.replace(/^#![^\n]*\n/u, "")));

  const defaulted = renderWrapperScript({ nodePath: null, realBinaryPath: null });
  assert.equal(defaulted.split("\n", 1)[0], "#!/usr/bin/env node");
  assert.match(defaulted, /const INSTALLED_REAL_BINARY = null;/);
  assert.doesNotThrow(() => new Function(defaulted.replace(/^#![^\n]*\n/u, "")));

  const envNodeWithPath = renderWrapperScript({ nodePath: null, realBinaryPath: "/opt/agy/agy_acp_server.par" });
  assert.equal(envNodeWithPath.split("\n", 1)[0], "#!/usr/bin/env node");
  assert.match(envNodeWithPath, /const INSTALLED_REAL_BINARY = "\/opt\/agy\/agy_acp_server\.par";/);
  assert.doesNotThrow(() => new Function(envNodeWithPath.replace(/^#![^\n]*\n/u, "")));

  const pinnedNodeWithoutPath = renderWrapperScript({ nodePath: "/custom/node", realBinaryPath: null });
  assert.equal(pinnedNodeWithoutPath.split("\n", 1)[0], "#!/custom/node");
  assert.match(pinnedNodeWithoutPath, /const INSTALLED_REAL_BINARY = null;/);
  assert.doesNotThrow(() => new Function(pinnedNodeWithoutPath.replace(/^#![^\n]*\n/u, "")));
});
