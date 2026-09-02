import { access, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import { verifyMaterializerIntegrity } from "./materializer-policy.js";
import { activationMaterializerSchema, requestMaterializerSchema } from "./schemas.js";
import type { ActivationMaterializer, RequestMaterializer } from "./types.js";

const commandHookSchema = z
  .object({
    command: z.string().min(1),
    type: z.literal("command"),
  })
  .strict();
const hooksFileSchema = z
  .object({
    hooks: z.record(
      z.string().min(1),
      z
        .array(
          z
            .object({
              hooks: z.array(commandHookSchema).min(1),
            })
            .strict(),
        )
        .min(1),
    ),
  })
  .strict();
const codexPluginSchema = z
  .object({
    hooks: z.string().min(1),
    mcpServers: z.record(
      z.string().min(1),
      z
        .object({
          args: z.array(z.string().min(1)).min(1),
          command: z.string().min(1),
          cwd: z.string().min(1),
        })
        .strict(),
    ),
    name: z.string().min(1),
    skills: z.string().min(1),
    version: z.string().min(1),
  })
  .loose();
const claudePluginSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
  })
  .loose();
const marketplaceGitSelectorShape = {
  ref: z.string().min(1).optional(),
  sha: z.string().min(1).optional(),
};
const marketplaceUrlSourceSchema = z
  .object({
    source: z.literal("url"),
    url: z.string().min(1),
    ...marketplaceGitSelectorShape,
  })
  .loose();
const marketplaceGitSubdirectorySourceSchema = z
  .object({
    path: z.string().min(1),
    source: z.literal("git-subdir"),
    url: z.string().min(1),
    ...marketplaceGitSelectorShape,
  })
  .loose();
const marketplaceNpmSourceSchema = z
  .object({
    package: z.string().min(1),
    registry: z.string().min(1).optional(),
    source: z.literal("npm"),
    version: z.string().min(1).optional(),
  })
  .loose();
const claudeMarketplaceSourceSchema = z.union([
  z.string().min(1),
  z.discriminatedUnion("source", [
    z
      .object({
        repo: z.string().min(1),
        source: z.literal("github"),
        ...marketplaceGitSelectorShape,
      })
      .loose(),
    marketplaceUrlSourceSchema,
    marketplaceGitSubdirectorySourceSchema,
    marketplaceNpmSourceSchema,
    z
      .object({
        sha256: z.string().min(1).optional(),
        source: z.literal("archive"),
        url: z.string().min(1),
      })
      .loose(),
    z
      .object({
        command: z.string().min(1),
        source: z.literal("command"),
      })
      .loose(),
  ]),
]);
const codexMarketplaceSourceSchema = z.union([
  z.string().min(1),
  z.discriminatedUnion("source", [
    z
      .object({
        path: z.string().min(1),
        source: z.literal("local"),
      })
      .loose(),
    marketplaceUrlSourceSchema,
    marketplaceGitSubdirectorySourceSchema,
    marketplaceNpmSourceSchema,
  ]),
]);
const claudeMarketplaceSchema = z
  .object({
    name: z.string().min(1),
    plugins: z
      .array(
        z
          .object({
            name: z.string().min(1),
            source: claudeMarketplaceSourceSchema,
          })
          .loose(),
      )
      .min(1),
  })
  .loose();
const codexMarketplaceSchema = z
  .object({
    name: z.string().min(1),
    plugins: z
      .array(
        z
          .object({
            name: z.string().min(1),
            source: codexMarketplaceSourceSchema,
          })
          .loose(),
      )
      .min(1),
  })
  .loose();
const profileTemplateSchema = z
  .object({
    activationMaterializer: activationMaterializerSchema.optional(),
    requestMaterializer: requestMaterializerSchema.optional(),
  })
  .loose();

function resolveInsideRoot(root: string, entry: string): string {
  const resolvedRoot = resolve(root);
  const resolvedEntry = resolve(resolvedRoot, entry);
  const relativeEntry = relative(resolvedRoot, resolvedEntry);
  if (
    isAbsolute(relativeEntry) ||
    relativeEntry === ".." ||
    relativeEntry.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
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

type MarketplaceSource =
  z.infer<typeof claudeMarketplaceSourceSchema> | z.infer<typeof codexMarketplaceSourceSchema>;
type MarketplacePlugin = { readonly name: string; readonly source: MarketplaceSource };

function findPublishedMapping<T extends MarketplacePlugin>(
  plugins: readonly T[],
  pluginName: string,
): T {
  const mappings = plugins.filter((plugin) => plugin.name === pluginName);
  if (mappings.length !== 1) {
    throw new Error(`marketplace mapping does not match plugin name: ${pluginName}`);
  }
  return mappings[0]!;
}

function localMarketplacePath(source: MarketplaceSource): string | undefined {
  if (typeof source === "string") return source;
  return source.source === "local" ? source.path : undefined;
}

function validatePublishedMapping(root: string, mapping: MarketplacePlugin): void {
  const mappedSource = localMarketplacePath(mapping.source);
  if (!mappedSource || resolveInsideRoot(root, mappedSource) !== resolve(root)) {
    throw new Error(
      `marketplace mapping does not publish the plugin root: ${mappedSource ?? "remote source"}`,
    );
  }
}

async function validateMaterializer(
  root: string,
  materializer: ActivationMaterializer | RequestMaterializer,
): Promise<void> {
  const file = resolveInsideRoot(root, materializer.file);
  verifyMaterializerIntegrity(materializer, await readFile(file, "utf8"));
  if (!materializer.dependencies) return;
  const dependencyDirectory = resolveInsideRoot(root, materializer.dependencies.directory);
  for (const [fileName, integrity] of [
    [materializer.dependencies.packageJson, materializer.dependencies.packageJsonIntegrity],
    [materializer.dependencies.denoLock, materializer.dependencies.denoLockIntegrity],
  ] as const) {
    const dependency = resolveInsideRoot(dependencyDirectory, fileName);
    let contents: Buffer;
    try {
      contents = await readFile(dependency);
    } catch {
      throw new Error(`materializer dependency is missing: ${dependency}`);
    }
    if (createHash("sha256").update(contents).digest("hex") !== integrity) {
      throw new Error(`materializer dependency integrity mismatch: ${dependency}`);
    }
  }
}

async function validateProfileTemplates(root: string): Promise<void> {
  const sharedDirectory = resolveInsideRoot(root, "shared");
  const profileTemplateDirectory = resolveInsideRoot(sharedDirectory, "profile-templates");
  const entries = await readdir(profileTemplateDirectory, { withFileTypes: true });
  await Promise.all(
    entries
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
      }),
  );
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
  const codexMapping = findPublishedMapping(codexMarketplace.plugins, codexPlugin.name);
  validatePublishedMapping(root, codexMapping);
  const claudeMarketplace = claudeMarketplaceSchema.parse(
    await readJson(resolveInsideRoot(root, ".claude-plugin/marketplace.json")),
  );
  const claudeMapping = findPublishedMapping(claudeMarketplace.plugins, claudePlugin.name);
  validatePublishedMapping(root, claudeMapping);

  const hooksFile = resolveInsideRoot(root, codexPlugin.hooks);
  hooksFileSchema.parse(await readJson(hooksFile));
  await validateFile(resolveInsideRoot(root, codexPlugin.skills));
  for (const server of Object.values(codexPlugin.mcpServers)) {
    await validateFile(resolveInsideRoot(root, server.args[0]!));
  }
  await validateProfileTemplates(root);
}
