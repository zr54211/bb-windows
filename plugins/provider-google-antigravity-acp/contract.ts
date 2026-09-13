// Typed host RPC shared by server.ts (caller) and host.ts (implementation).
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const agyHostContract = defineRpcContract({
  install: {
    input: z.object({
      installDir: z.string().min(1),
      binDir: z.string().min(1),
      force: z.boolean(),
      updatePath: z.boolean(),
      source: z.string().optional(),
    }).strict(),
    output: z.object({
      ok: z.boolean(),
      platform: z.string(),
      arch: z.string(),
      distKey: z.string(),
      url: z.string(),
      args: z.array(z.string()),
      registryCommit: z.string(),
      installDir: z.string(),
      binDir: z.string(),
      binaryPath: z.string().nullable(),
      harnessPath: z.string().nullable(),
      alreadyInstalled: z.boolean(),
      error: z.string().nullable(),
      notes: z.array(z.string()),
    }),
  },
  probe: {
    input: z.null(),
    output: z.object({
      ok: z.boolean(),
      platform: z.string(),
      arch: z.string(),
      binaryPath: z.string().nullable(),
      harnessPath: z.string().nullable(),
      error: z.string().nullable(),
    }),
  },
});
