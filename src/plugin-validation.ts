import { access, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

const commandHookSchema = z.object({
  command: z.string().min(1),
  type: z.literal("command"),
}).strict();
const hooksFileSchema = z.object({
  hooks: z.record(
    z.string().min(1),
    z.array(z.object({
      hooks: z.array(commandHookSchema).min(1),
    }).strict()).min(1),
  ),
}).strict();
const codexPluginSchema = z.object({
  hooks: z.string().min(1),
  mcpServers: z.record(z.string().min(1), z.object({
    args: z.array(z.string().min(1)).min(1),
    command: z.string().min(1),
    cwd: z.string().min(1),
  }).strict()),
  name: z.string().min(1),
  skills: z.string().min(1),
  version: z.string().min(1),
}).loose();
const claudePluginSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
}).loose();

function resolveInsideRoot(root: string, entry: string): string {
  const resolvedRoot = resolve(root);
  const resolvedEntry = resolve(resolvedRoot, entry);
  const relativeEntry = relative(resolvedRoot, resolvedEntry);
  if (isAbsolute(relativeEntry) || relativeEntry === ".." ||
    relativeEntry.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`plugin path escapes its root: ${entry}`);
  }
  return resolvedEntry;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

async function validateFile(file: string): Promise<void> {
  await access(file);
}

export async function validatePlugin(root: string): Promise<void> {
  const codexPluginFile = resolveInsideRoot(root, ".codex-plugin/plugin.json");
  const codexPlugin = codexPluginSchema.parse(await readJson(codexPluginFile));
  const claudePluginFile = resolveInsideRoot(root, ".claude-plugin/plugin.json");
  claudePluginSchema.parse(await readJson(claudePluginFile));

  const hooksFile = resolveInsideRoot(root, codexPlugin.hooks);
  hooksFileSchema.parse(await readJson(hooksFile));
  await validateFile(resolveInsideRoot(root, codexPlugin.skills));
  for (const server of Object.values(codexPlugin.mcpServers)) {
    await validateFile(resolveInsideRoot(root, server.args[0]!));
  }
}
