import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { materializerIntegrity } from "../src/materializer-policy.js";
import { validatePlugin } from "../src/plugin-validation.js";

const emptyPermissions = { env: [], ffi: [], net: [], read: [], run: [], sys: [], write: [] } as const;

function requestMaterializerReference(file = "materializers/requests/repository.ts") {
  return {
    file,
    integrity: materializerIntegrity("", emptyPermissions, "2.8.1"),
    language: "typescript",
    permissions: emptyPermissions,
    runtimeVersion: "2.8.1",
  } as const;
}

async function writePlugin(root: string): Promise<void> {
  await mkdir(join(root, ".claude-plugin"));
  await mkdir(join(root, ".codex-plugin"));
  await mkdir(join(root, "hooks"));
  await mkdir(join(root, "skills"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "shared", "profile-templates"), { recursive: true });
  await mkdir(join(root, "shared", "materializers", "requests"), { recursive: true });
  await writeFile(join(root, "src", "mcp-server.ts"), "");
  await writeFile(join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "test", version: "1" }));
  await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({
    hooks: "./hooks/hooks.codex.json",
    mcpServers: { test: { args: ["./src/mcp-server.ts"], command: "bun", cwd: "." } },
    name: "test",
    skills: "./skills",
    version: "1",
  }));
  await writeFile(join(root, "hooks", "hooks.codex.json"), JSON.stringify({
    hooks: { PermissionRequest: [{ hooks: [{ command: "bun hook.ts", type: "command" }] }] },
  }));
  await writeFile(join(root, "shared", "profile-templates", "scout.json"), JSON.stringify({
    requestMaterializer: requestMaterializerReference(),
  }));
  await writeFile(join(root, "shared", "materializers", "requests", "repository.ts"), "");
}

describe("plugin validation", () => {
  test("accepts the published plugin configuration", async () => {
    await expect(validatePlugin(process.cwd())).resolves.toBeUndefined();
  });

  test("rejects invalid plugin files and missing entrypoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-extender-plugin-"));
    try {
      await writePlugin(root);
      await expect(validatePlugin(root)).resolves.toBeUndefined();
      await rm(join(root, "src", "mcp-server.ts"));
      await expect(validatePlugin(root)).rejects.toThrow();
      await writeFile(join(root, "src", "mcp-server.ts"), "");
      await writeFile(join(root, ".claude-plugin", "plugin.json"), "{}");
      await expect(validatePlugin(root)).rejects.toThrow();
      await writeFile(join(root, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "test", version: "1" }));
      await writeFile(join(root, "shared", "profile-templates", "scout.json"), JSON.stringify({
        requestMaterializer: requestMaterializerReference("../../arbitrary-code.ts"),
      }));
      await expect(validatePlugin(root)).rejects.toThrow();
      await writeFile(join(root, "shared", "profile-templates", "scout.json"), JSON.stringify({
        requestMaterializer: requestMaterializerReference(),
      }));
      await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({
        hooks: "../../outside.json",
        mcpServers: {},
        name: "test",
        skills: "./skills",
        version: "1",
      }));
      await expect(validatePlugin(root)).rejects.toThrow("escapes its root");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
