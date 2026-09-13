// Host entry: wraps the shared ACP provider bridge, discovers models from the running Antigravity server, and serves the install/status host RPC.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import readline from "node:readline";
import {
  experimental_acpProviderBridge,
} from "@get-bb/plugin-sdk/provider-bridge/acp";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { agyHostContract } from "./contract.js";
import { localizeLaunchSpec, probeLocal, runInstall } from "./install.js";

import {
  normalizeModelId,
  normalizeEffort,
  parseRawModels,
  resolveRawModelId,
  rawListsEqual,
  type RawModel,
  type ModelCatalog,
} from "./model-utils.js";


const CACHE_FILE = path.join(
  os.homedir(),
  ".bb",
  "plugins",
  "google-antigravity-acp",
  "models-cache.json",
);

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — picker never stale, background refresh handles rotation

// Per-provider default configurability

function getPreferredDefault(launchEnv?: Record<string, string>): { model: string; effort: string } | null {
  // 1. In-band RPC launchSpec env (works across distributed / remote hosts)
  const envModel = launchEnv?.BB_ANTIGRAVITY_DEFAULT_MODEL || process.env.BB_ANTIGRAVITY_DEFAULT_MODEL;
  const envEffort = launchEnv?.BB_ANTIGRAVITY_DEFAULT_REASONING || process.env.BB_ANTIGRAVITY_DEFAULT_REASONING;
  if (envModel && envModel.trim()) {
    return {
      model: normalizeModelId(envModel),
      effort: normalizeEffort(envEffort || "medium"),
    };
  }

  return null;
}

// The launch spec is built on the bb server machine, but spawns happen here; fix command/args for this machine (env carries settings and stays untouched).
// Wrap parse to inject settings
function parseWithSettings(rawList: RawModel[], launchEnv?: Record<string, string>): ModelCatalog {
  const pref = getPreferredDefault(launchEnv);
  return parseRawModels(rawList, undefined, pref);
}

// ---- Discovery and caching ------------------------------------------------

let activeCatalog: ModelCatalog = {
  families: new Map(),
  models: [],
  defaultFamilyId: "",
  rawModels: [],
};
let isInitialized = false;
let discoveryPromise: Promise<void> | null = null;
let cacheTimestamp = 0;
let lastRefreshAt = 0;

function isCacheStale(): boolean {
  if (!cacheTimestamp) return true;
  return Date.now() - cacheTimestamp > CACHE_TTL_MS;
}

const DEFAULT_FALLBACK_RAW_MODELS: RawModel[] = [
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
  { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
  { id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)" },
  { id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)" },
  { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)" },
  { id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)" },
  { id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)" },
  { id: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" },
  { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
];

function loadFromDiskCache(launchEnv?: Record<string, string>): boolean {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (Array.isArray(data.rawModels) && data.rawModels.length > 0) {
        cacheTimestamp = typeof data.timestamp === "number" ? data.timestamp : 0;
        activeCatalog = parseWithSettings(data.rawModels, launchEnv);
        isInitialized = true;
        lastRefreshAt = cacheTimestamp || Date.now();
        return true;
      }
    }
  } catch (err) {
    if (process.env.DEBUG) console.error("[acp-antigravity] Failed loading disk cache:", err);
  }
  if (!isInitialized) {
    activeCatalog = parseWithSettings(DEFAULT_FALLBACK_RAW_MODELS, launchEnv);
    isInitialized = true;
    lastRefreshAt = Date.now();
    return true;
  }
  return false;
}

function saveToDiskCache(rawModels: RawModel[]) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    cacheTimestamp = Date.now();
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ rawModels, timestamp: cacheTimestamp }), "utf8");
  } catch (err) {
    if (process.env.DEBUG) console.error("[acp-antigravity] Failed saving disk cache:", err);
  }
}

async function queryAcpServer(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<RawModel[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });

    const rl = readline.createInterface({ input: proc.stdout });
    let nextId = 1;
    const pending = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("ACP server query timed out"));
    }, 45000);

    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          const entry = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(msg.error.message));
          else entry.resolve(msg.result);
        }
      } catch {}
    });

    function send(method: string, params: any) {
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    }

    (async () => {
      try {
        await send("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "bb", version: "1.0.0" },
          clientCapabilities: {},
        });
        const session: any = await send("session/new", { cwd: process.cwd(), mcpServers: [] });
        const modelOption = session?.configOptions?.find((c: any) => c.id === "model");
        const rawList = (modelOption?.options ?? []).map((o: any) => ({
          id: o.value,
          name: o.name ?? o.value,
        }));
        clearTimeout(timeout);
        proc.kill();
        resolve(rawList);
      } catch (err) {
        clearTimeout(timeout);
        proc.kill();
        reject(err);
      }
    })();
  });
}

async function refreshModels(launchSpec?: { command: string; args: string[]; env: Record<string, string> }) {
  if (discoveryPromise) return discoveryPromise;
  const cmd = launchSpec?.command || "agy_acp_server.par";
  const args = launchSpec?.args || [];
  const env = launchSpec?.env || {};

  discoveryPromise = queryAcpServer(cmd, args, env)
    .then((rawList) => {
      if (rawList && rawList.length > 0) {
        // Stale check: diff against current cache — handles added/deprecated models so picker never stale
        if (!isInitialized || !rawListsEqual(rawList, activeCatalog.rawModels)) {
          activeCatalog = parseWithSettings(rawList, env);
          isInitialized = true;
          saveToDiskCache(rawList);
        } else {
          // No change — just bump timestamp to avoid re-querying
          cacheTimestamp = Date.now();
          try {
            const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
            data.timestamp = cacheTimestamp;
            fs.writeFileSync(CACHE_FILE, JSON.stringify(data), "utf8");
          } catch {}
        }
        lastRefreshAt = Date.now();
      }
    })
    .catch((err) => {
      if (process.env.DEBUG) console.error("[acp-antigravity] Failed refreshing models:", err);
    })
    .finally(() => {
      discoveryPromise = null;
    });

  return discoveryPromise;
}

// Attempt initial load from disk cache
loadFromDiskCache();

export const experimental_providerBridge = {
  experimental_apiVersion: 1 as const,
  handleLine: async (line: string) => {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        if (parsed.method === "model/list") {
          const launchSpec = parsed.params?.providerOptions?.acpLaunchSpec;
          localizeLaunchSpec(launchSpec);
          if (!isInitialized) {
            loadFromDiskCache(launchSpec?.env);
          }
          if (isCacheStale()) {
            // Stale or cold — await discovery so first picker is fresh
            await refreshModels(launchSpec);
          } else {
            // Re-derive from cache to honor current defaultModel setting
            activeCatalog = parseWithSettings(activeCatalog.rawModels, launchSpec?.env);
            if (Date.now() - lastRefreshAt > 60_000) {
              // Background refresh (debounced 60s) to pick up added/deprecated models without blocking
              refreshModels(launchSpec);
            }
          }

          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                models: activeCatalog.models,
                selectedOnlyModels: [],
              },
            }) + "\n",
          );
          return;
        }

        if (
          parsed.method === "thread/start" ||
          parsed.method === "thread/resume" ||
          parsed.method === "thread/fork"
        ) {
          if (!parsed.params.options) {
            parsed.params.options = {};
          }
          const launchSpec = parsed.params?.options?.providerOptions?.acpLaunchSpec;
          localizeLaunchSpec(launchSpec);
          if (!isInitialized) {
            loadFromDiskCache(launchSpec?.env);
            if (!isInitialized && launchSpec) {
              await refreshModels(launchSpec);
            }
          }
          const resolved = resolveRawModelId(
            parsed.params.options.model,
            parsed.params.options.reasoningLevel,
            activeCatalog,
          );
          parsed.params.options.model = resolved;
          line = JSON.stringify(parsed);
        }
      }
    } catch (err) {
      if (process.env.DEBUG) console.error("[acp-antigravity] Error in handleLine:", err);
    }
    return experimental_acpProviderBridge.handleLine(line);
  },
  onClose: () => {
    return experimental_acpProviderBridge.onClose?.();
  },
};

export default experimental_defineHostEntry({
  contract: agyHostContract,
  handlers: {
    probe: async () => {
      return probeLocal();
    },
    install: async (params) => {
      return runInstall({
        installDir: params.installDir,
        binDir: params.binDir,
        force: params.force,
        updatePath: params.updatePath,
        source: params.source,
      });
    },
  },
});
