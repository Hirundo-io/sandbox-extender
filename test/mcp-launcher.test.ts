import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type JsonRpcErrorResponse = {
  readonly error: {
    readonly code: number;
    readonly message: string;
  };
  readonly id: number;
  readonly jsonrpc: "2.0";
};

type JsonRpcSuccessResponse = {
  readonly id: number;
  readonly jsonrpc: "2.0";
  readonly result: {
    readonly serverInfo?: { readonly version: string };
    readonly tools?: readonly { readonly name: string }[];
  };
};

type JsonRpcResponse = JsonRpcErrorResponse | JsonRpcSuccessResponse;

type PluginManifest = {
  readonly mcpServers: Readonly<
    Record<
      string,
      {
        readonly args: readonly string[];
        readonly command: string;
        readonly cwd: string;
      }
    >
  >;
};

type PackageManifest = {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly version: string;
};

function denoPackageName(): string {
  const libc = process.platform === "linux" ? "-glibc" : "";
  return `${process.platform}-${process.arch}${libc}`;
}

function request(id: number, method: string, params: Readonly<Record<string, unknown>>): string {
  return `${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`;
}

function requireSuccessfulResponse(response: JsonRpcResponse): JsonRpcSuccessResponse {
  if ("error" in response) {
    throw new Error(
      `MCP request ${response.id} failed (${response.error.code}): ${response.error.message}`,
    );
  }
  return response;
}

async function writeRequests(process: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
  process.stdin.write(
    request(1, "initialize", {
      capabilities: {},
      clientInfo: { name: "plugin-installation-test", version: "1.0.0" },
      protocolVersion: "2025-06-18",
    }),
  );
  process.stdin.write(request(2, "tools/list", {}));
  process.stdin.end();
}

describe("MCP launcher", () => {
  test("reports JSON-RPC errors with their request details", () => {
    expect(() =>
      requireSuccessfulResponse({
        error: { code: -32_603, message: "Internal error" },
        id: 2,
        jsonrpc: "2.0",
      }),
    ).toThrow("MCP request 2 failed (-32603): Internal error");
  });

  test("installs production dependencies and lists tools from a clean plugin copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-extender-plugin-"));
    try {
      await cp(join(process.cwd(), "src"), join(root, "src"), { recursive: true });
      await cp(join(process.cwd(), ".codex-plugin"), join(root, ".codex-plugin"), {
        recursive: true,
      });
      await copyFile(join(process.cwd(), "package.json"), join(root, "package.json"));
      await copyFile(join(process.cwd(), "bun.lock"), join(root, "bun.lock"));

      const manifest = JSON.parse(
        await readFile(join(root, ".codex-plugin", "plugin.json"), "utf8"),
      ) as PluginManifest;
      const packageManifest = JSON.parse(
        await readFile(join(root, "package.json"), "utf8"),
      ) as PackageManifest;
      const lifecycleMarker = join(root, "root-preinstall-ran");
      await writeFile(
        join(root, "root-preinstall.ts"),
        `await Bun.write(${JSON.stringify(lifecycleMarker)}, "executed");\n`,
      );
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          ...packageManifest,
          scripts: { ...packageManifest.scripts, preinstall: "bun ./root-preinstall.ts" },
        }),
      );
      const configuration = manifest.mcpServers["sandbox-extender"]!;
      const server = Bun.spawn({
        cmd: [configuration.command, ...configuration.args],
        cwd: join(root, configuration.cwd),
        env: { ...process.env, HOME_FOLDER: join(root, "policy") },
        stderr: "pipe",
        stdin: "pipe",
        stdout: "pipe",
      });
      await writeRequests(server);
      const [exitCode, stderr, stdout] = await Promise.all([
        server.exited,
        new Response(server.stderr).text(),
        new Response(server.stdout).text(),
      ]);

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(existsSync(lifecycleMarker)).toBe(false);
      const denoExecutable = process.platform === "win32" ? "deno.exe" : "deno";
      expect(
        (
          await stat(join(root, "node_modules", "@deno", denoPackageName(), denoExecutable))
        ).isFile(),
      ).toBe(true);
      const responses = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as JsonRpcResponse);
      expect(responses.map(({ id }) => id)).toEqual([1, 2]);
      const initializeResponse = requireSuccessfulResponse(responses[0]!);
      const toolsResponse = requireSuccessfulResponse(responses[1]!);
      expect(initializeResponse.result.serverInfo?.version).toBe(packageManifest.version);
      expect(toolsResponse.result.tools?.map(({ name }) => name)).toEqual([
        "initialize_policy_repository",
        "list_profiles",
        "get_active_profile",
        "propose_profile",
        "promote_profile",
        "activate_profile",
        "disable_profile",
        "evaluate_request",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);
});
