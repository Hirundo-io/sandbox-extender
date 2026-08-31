import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));

async function installRuntimeDependencies(): Promise<void> {
  const installation = Bun.spawn({
    cmd: [process.execPath, "install", "--frozen-lockfile", "--production", "--silent"],
    cwd: pluginRoot,
    stderr: "pipe",
    stdout: "ignore",
  });
  const stderr = await new Response(installation.stderr).text();
  const exitCode = await installation.exited;
  if (exitCode !== 0) {
    throw new Error(`failed to install MCP runtime dependencies: ${stderr.trim()}`);
  }
}

function forwardTermination(server: Bun.Subprocess): void {
  process.on("SIGINT", () => server.kill("SIGINT"));
  process.on("SIGTERM", () => server.kill("SIGTERM"));
}

async function launchServer(): Promise<number> {
  await installRuntimeDependencies();
  const server = Bun.spawn({
    cmd: [process.execPath, "./src/mcp-server.ts"],
    cwd: pluginRoot,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });
  forwardTermination(server);
  return server.exited;
}

process.exitCode = await launchServer();
