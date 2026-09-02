import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { materializerIntegrity } from "../src/materializer-policy.js";
import { validatePlugin } from "../src/plugin-validation.js";

const emptyPermissions = {
  env: [],
  ffi: [],
  net: [],
  read: [],
  run: [],
  sys: [],
  write: [],
} as const;

function requestMaterializerReference(file = "materializers/requests/repository.ts") {
  return {
    file,
    integrity: materializerIntegrity("", emptyPermissions, "2.8.1"),
    language: "typescript",
    permissions: emptyPermissions,
    runtimeVersion: "2.8.1",
  } as const;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function dependencyRequestMaterializerReference(packageJson: string, denoLock: string) {
  const dependencies = {
    denoLock: "deno.lock",
    denoLockIntegrity: sha256(denoLock),
    directory: "materializers/dependencies/graphql",
    packageJson: "package.json",
    packageJsonIntegrity: sha256(packageJson),
  } as const;
  return {
    dependencies,
    file: "materializers/requests/repository.ts",
    integrity: materializerIntegrity("", emptyPermissions, "2.8.1", dependencies),
    language: "typescript",
    permissions: emptyPermissions,
    runtimeVersion: "2.8.1",
  } as const;
}

async function writeClaudePlugin(root: string, name: string): Promise<void> {
  await writeFile(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, version: "1" }),
  );
}

async function writeCodexMarketplace(
  root: string,
  marketplaceName: string,
  source: unknown = { path: ".", source: "local" },
  additionalPlugins: readonly unknown[] = [],
): Promise<void> {
  await writeFile(
    join(root, "marketplace.json"),
    JSON.stringify({
      name: marketplaceName,
      plugins: [...additionalPlugins, { name: "test", source }],
    }),
  );
}

async function writeClaudeMarketplace(
  root: string,
  marketplaceName: string,
  source: unknown = ".",
  additionalPlugins: readonly unknown[] = [],
): Promise<void> {
  await writeFile(
    join(root, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: marketplaceName,
      plugins: [...additionalPlugins, { name: "test", source }],
    }),
  );
}

async function writePlugin(root: string): Promise<void> {
  await mkdir(join(root, ".claude-plugin"));
  await mkdir(join(root, ".codex-plugin"));
  await mkdir(join(root, "hooks"));
  await mkdir(join(root, "skills"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "shared", "profile-templates"), { recursive: true });
  await mkdir(join(root, "shared", "materializers", "requests"), { recursive: true });
  await writeFile(join(root, "src", "mcp-launcher.ts"), "");
  await writeCodexMarketplace(root, "test");
  await writeClaudeMarketplace(root, "test");
  await writeClaudePlugin(root, "test");
  await writeFile(
    join(root, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      hooks: "./hooks/hooks.codex.json",
      mcpServers: { test: { args: ["./src/mcp-launcher.ts"], command: "bun", cwd: "." } },
      name: "test",
      skills: "./skills",
      version: "1",
    }),
  );
  await writeFile(
    join(root, "hooks", "hooks.codex.json"),
    JSON.stringify({
      hooks: { PermissionRequest: [{ hooks: [{ command: "bun hook.ts", type: "command" }] }] },
    }),
  );
  await writeFile(
    join(root, "shared", "profile-templates", "scout.json"),
    JSON.stringify({
      requestMaterializer: requestMaterializerReference(),
    }),
  );
  await writeFile(join(root, "shared", "materializers", "requests", "repository.ts"), "");
}

describe("plugin validation", () => {
  test("accepts the published plugin configuration", async () => {
    await expect(validatePlugin(process.cwd())).resolves.toBeUndefined();
  });

  test("accepts documented remote sources for other marketplace plugins", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-extender-plugin-"));
    try {
      await writePlugin(root);
      const codexSources = [
        { ref: "main", source: "url", url: "https://example.test/plugin.git" },
        { path: "plugins/remote", sha: "commit", source: "git-subdir", url: "owner/repository" },
        { package: "@example/plugin", source: "npm", version: "1.0.0" },
      ];
      for (const source of codexSources) {
        await writeCodexMarketplace(root, "codex-catalog", ".", [{ name: "remote", source }]);
        await expect(validatePlugin(root)).resolves.toBeUndefined();
      }

      const claudeSources = [
        { ref: "main", repo: "example/plugin", source: "github" },
        { sha: "commit", source: "url", url: "https://example.test/plugin.git" },
        { path: "plugins/remote", source: "git-subdir", url: "owner/repository" },
        { package: "@example/plugin", registry: "https://registry.example.test", source: "npm" },
        { sha256: "digest", source: "archive", url: "https://example.test/plugin.zip" },
        { command: "find-plugin", source: "command" },
      ];
      for (const source of claudeSources) {
        await writeClaudeMarketplace(root, "claude-catalog", ".", [{ name: "remote", source }]);
        await expect(validatePlugin(root)).resolves.toBeUndefined();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects invalid plugin files and missing entrypoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-extender-plugin-"));
    try {
      await writePlugin(root);
      await expect(validatePlugin(root)).resolves.toBeUndefined();
      await rm(join(root, "src", "mcp-launcher.ts"));
      await expect(validatePlugin(root)).rejects.toThrow();
      await writeFile(join(root, "src", "mcp-launcher.ts"), "");
      await writeFile(join(root, ".claude-plugin", "plugin.json"), "{}");
      await expect(validatePlugin(root)).rejects.toThrow();
      await writeClaudePlugin(root, "other");
      await expect(validatePlugin(root)).rejects.toThrow("plugin names do not match");
      await writeClaudePlugin(root, "test");
      await writeCodexMarketplace(root, "catalog", ".", [
        { name: "remote", source: { source: "url", url: "https://example.test/plugin.git" } },
      ]);
      await writeClaudeMarketplace(root, "claude-catalog", ".", [
        { name: "remote", source: { repo: "example/remote", source: "github" } },
      ]);
      await expect(validatePlugin(root)).resolves.toBeUndefined();
      await writeCodexMarketplace(root, "catalog", {
        source: "url",
        url: "https://example.test/plugin.git",
      });
      await expect(validatePlugin(root)).rejects.toThrow("does not publish the plugin root");
      await writeCodexMarketplace(root, "catalog", ".", [
        { name: "test", source: { path: ".", source: "local" } },
      ]);
      await expect(validatePlugin(root)).rejects.toThrow("does not match plugin name");
      await writeCodexMarketplace(root, "catalog", "nested");
      await expect(validatePlugin(root)).rejects.toThrow("does not publish the plugin root");
      await writeCodexMarketplace(root, "test");
      await writeClaudeMarketplace(root, "test");
      await writeFile(
        join(root, "shared", "profile-templates", "scout.json"),
        JSON.stringify({
          requestMaterializer: requestMaterializerReference("../../arbitrary-code.ts"),
        }),
      );
      await expect(validatePlugin(root)).rejects.toThrow();
      await writeFile(
        join(root, "shared", "profile-templates", "scout.json"),
        JSON.stringify({
          requestMaterializer: requestMaterializerReference(),
        }),
      );
      await writeFile(
        join(root, ".codex-plugin", "plugin.json"),
        JSON.stringify({
          hooks: "../../outside.json",
          mcpServers: {},
          name: "test",
          skills: "./skills",
          version: "1",
        }),
      );
      await expect(validatePlugin(root)).rejects.toThrow("escapes its root");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("validates declared materializer dependency files and their hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-extender-plugin-"));
    const packageJson = '{"name":"graphql"}\n';
    const denoLock = "{}\n";
    try {
      await writePlugin(root);
      const dependencyDirectory = join(root, "shared", "materializers", "dependencies", "graphql");
      await mkdir(dependencyDirectory, { recursive: true });
      await writeFile(join(dependencyDirectory, "package.json"), packageJson);
      await writeFile(join(dependencyDirectory, "deno.lock"), denoLock);
      await writeFile(
        join(root, "shared", "profile-templates", "scout.json"),
        JSON.stringify({
          requestMaterializer: dependencyRequestMaterializerReference(packageJson, denoLock),
        }),
      );
      await expect(validatePlugin(root)).resolves.toBeUndefined();
      await rm(join(dependencyDirectory, "package.json"));
      await expect(validatePlugin(root)).rejects.toThrow("materializer dependency is missing");
      await writeFile(join(dependencyDirectory, "package.json"), "tampered\n");
      await expect(validatePlugin(root)).rejects.toThrow(
        "materializer dependency integrity mismatch",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
