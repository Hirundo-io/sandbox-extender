import { access, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import { verifyMaterializerIntegrity } from "./materializer-policy.js";
import { activationMaterializerSchema, requestMaterializerSchema } from "./schemas.js";
import type { ActivationMaterializer, RequestMaterializer } from "./types.js";

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
const claudeMarketplaceSchema = z.object({
  name: z.string().min(1),
  plugins: z.array(z.object({
    name: z.string().min(1),
    source: z.string().min(1),
  }).loose()).length(1),
}).loose();
const codexMarketplaceSchema = z.object({
  name: z.string().min(1),
  plugins: z.array(z.object({
    name: z.string().min(1),
    source: z.object({
      path: z.string().min(1),
      source: z.literal("local"),
    }).strict(),
  }).loose()).length(1),
}).loose();
const profileTemplateSchema = z.object({
  activationMaterializer: activationMaterializerSchema.optional(),
  requestMaterializer: requestMaterializerSchema.optional(),
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

function validatePublishedMapping(
  root: string,
  marketplaceName: string,
  mappedPluginName: string,
  mappedSource: string,
  pluginName: string,
): void {
  if (marketplaceName !== pluginName || mappedPluginName !== pluginName) {
    throw new Error(`marketplace mapping does not match plugin name: ${pluginName}`);
  }
  if (resolveInsideRoot(root, mappedSource) !== resolve(root)) {
    throw new Error(`marketplace mapping does not publish the plugin root: ${mappedSource}`);
  }
}

async function validateMaterializer(
  root: string,
  materializer: ActivationMaterializer | RequestMaterializer,
): Promise<void> {
  const file = resolveInsideRoot(root, materializer.file);
  verifyMaterializerIntegrity(materializer, await readFile(file, "utf8"));
}

async function validateProfileTemplates(root: string): Promise<void> {
  const sharedDirectory = resolveInsideRoot(root, "shared");
  const profileTemplateDirectory = resolveInsideRoot(sharedDirectory, "profile-templates");
  const entries = await readdir(profileTemplateDirectory, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(async (entry) => {
      const profileTemplate = profileTemplateSchema.parse(
        await readJson(join(profileTemplateDirectory, entry.name)),
      );
      if (profileTemplate.activationMaterializer) {
        await validateMaterializer(sharedDirectory, profileTemplate.activationMaterializer);
      }
      if (profileTemplate.requestMaterializer) {
        await validateMaterializer(sharedDirectory, profileTemplate.requestMaterializer);
      }
    }));
}

export async function validatePlugin(root: string): Promise<void> {
  const codexPluginFile = resolveInsideRoot(root, ".codex-plugin/plugin.json");
  const codexPlugin = codexPluginSchema.parse(await readJson(codexPluginFile));
  const claudePluginFile = resolveInsideRoot(root, ".claude-plugin/plugin.json");
  const claudePlugin = claudePluginSchema.parse(await readJson(claudePluginFile));
  if (claudePlugin.name !== codexPlugin.name) {
    throw new Error("Codex and Claude plugin names do not match");
  }

  const codexMarketplace = codexMarketplaceSchema.parse(
    await readJson(resolveInsideRoot(root, "marketplace.json")),
  );
  const codexMapping = codexMarketplace.plugins[0]!;
  validatePublishedMapping(
    root,
    codexMarketplace.name,
    codexMapping.name,
    codexMapping.source.path,
    codexPlugin.name,
  );
  const claudeMarketplace = claudeMarketplaceSchema.parse(
    await readJson(resolveInsideRoot(root, ".claude-plugin/marketplace.json")),
  );
  const claudeMapping = claudeMarketplace.plugins[0]!;
  validatePublishedMapping(
    root,
    claudeMarketplace.name,
    claudeMapping.name,
    claudeMapping.source,
    claudePlugin.name,
  );

  const hooksFile = resolveInsideRoot(root, codexPlugin.hooks);
  hooksFileSchema.parse(await readJson(hooksFile));
  await validateFile(resolveInsideRoot(root, codexPlugin.skills));
  for (const server of Object.values(codexPlugin.mcpServers)) {
    await validateFile(resolveInsideRoot(root, server.args[0]!));
  }
  await validateProfileTemplates(root);
}
