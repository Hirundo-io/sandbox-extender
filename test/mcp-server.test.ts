import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

describe("Sandbox Extender MCP server", () => {
  test("serves modern stdio discovery", async () => {
    const client = new Client(
      { name: "sandbox-extender-test", version: "0.1.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const transport = new StdioClientTransport({
      args: ["src/mcp-server.ts"],
      command: "bun",
      cwd: process.cwd(),
      stderr: "pipe",
    });

    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe("modern");
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("activate_profile");
    } finally {
      await client.close();
    }
  });
});
