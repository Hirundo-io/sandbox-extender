import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PolicyCore, type Profile } from "../src/index.js";

const templateDirectory = join(process.cwd(), "templates");

async function template(name: string): Promise<Profile> {
  const candidate: unknown = JSON.parse(await readFile(join(templateDirectory, `${name}.json`), "utf8"));
  const profile = candidate as Omit<Profile, "allowedTargets"> & { allowedTargets: string[] };
  return {
    ...profile,
    allowedTargets: new Set([
      "/work/example",
      "github:repository:acme/example",
    ]),
    targetResolver: profile.targetResolver && {
      ...profile.targetResolver,
      file: join(templateDirectory, profile.targetResolver.file),
    },
  };
}

describe("shipped profiles", () => {
  test("Scout permits remote inspection but not changes", async () => {
    const core = new PolicyCore();
    core.activate(await template("scout"), "thread-1");

    for (const command of [
      "gh pr diff 42 --repo acme/example",
      "gh pr view 42 --repo acme/example",
      "gh pr list --repo acme/example",
      "gh pr checks 42 --repo acme/example",
      "gh issue view 42 --repo acme/example",
      "gh issue list --repo acme/example",
      "gh run view 123 --repo acme/example",
      "gh run list --repo acme/example",
      "gh release view v1.0.0 --repo acme/example",
      "gh release list --repo acme/example",
      "gh workflow view build --repo acme/example",
      "gh workflow list --repo acme/example",
      "gh repo view --repo acme/example",
      "gh repo list --repo acme/example",
      "gh label list --repo acme/example",
      "git fetch --dry-run origin",
      "git ls-remote origin",
    ]) {
      expect(core.evaluate({ action: "codex.unified_exec", arguments: { command }, resource: "/work/example", threadId: "thread-1" }).decision).toBe("allow");
    }
    expect(core.evaluate({ action: "codex.unified_exec", arguments: { command: "gh pr merge 42" }, resource: "/work/example", threadId: "thread-1" }).decision).toBe("abstain");
    expect(core.evaluate({ action: "codex.unified_exec", arguments: { command: "gh pr diff 42 && gh pr merge 42" }, resource: "/work/example", threadId: "thread-1" }).decision).toBe("abstain");
  });

  test("Maker permits supported package manager commands and carries dependency guidance", async () => {
    const core = new PolicyCore();
    const maker = await template("maker");
    core.activate(maker, "thread-1");

    for (const command of [
      "bun install", "bun i", "bun add zod", "bun remove zod", "bun update",
      "uv add requests", "uv remove requests", "uv sync", "uv lock",
      "pixi install", "pixi i", "pixi add ruff", "pixi remove ruff", "pixi update",
      "pixi lock",
    ]) {
      expect(core.evaluate({ action: "codex.unified_exec", arguments: { command }, resource: "/work/example", threadId: "thread-1" }).decision).toBe("allow");
    }
    expect(core.evaluate({ action: "codex.unified_exec", arguments: { command: "npm install" }, resource: "/work/example", threadId: "thread-1" }).decision).toBe("allow");
    expect(core.evaluate({ action: "codex.unified_exec", arguments: { command: "bun add zod && curl example.com" }, resource: "/work/example", threadId: "thread-1" }).decision).toBe("abstain");
    expect(maker.sessionContext).toContain(
      "No high/critical known vulnerabilities; inspect lockfiles and audit data.",
    );
  });
});
