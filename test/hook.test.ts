import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handlePermissionRequest, hookOutput, normalizeHookRequest } from "../src/hook.js";
import { activateProfile } from "../src/policy-service.js";
import { PolicyRepository } from "../src/policy-repository.js";

function commitReview(root: string): string {
  for (const command of [
    ["git", "init", "--quiet"],
    ["git", "config", "user.email", "sandbox-extender@example.test"],
    ["git", "config", "user.name", "Sandbox Extender"],
    ["git", "add", "proposals", "tests"],
    ["git", "commit", "--quiet", "-m", "Review profile"],
  ]) {
    const result = Bun.spawnSync({ cmd: command, cwd: root });
    if (result.exitCode !== 0) throw new Error(`could not run ${command.join(" ")}`);
  }
  const result = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: root, stdout: "pipe" });
  return new TextDecoder().decode(result.stdout).trim();
}

describe("host permission hooks", () => {
  test("normalizes the portable fields used by both hosts", () => {
    expect(
      normalizeHookRequest(
        {
          cwd: "/work/example",
          session_id: "thread-1",
          tool_input: { command: "git status" },
          tool_name: "Bash",
        },
        "claude",
      ),
    ).toEqual({
      action: "claude.Bash",
      arguments: { command: "git status" },
      resource: "/work/example",
      threadId: "thread-1",
    });
  });

  test("abstains when a hook event does not have a complete request", async () => {
    expect(await handlePermissionRequest({ session_id: "thread-1" }, "codex")).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest" },
      systemMessage: "Sandbox Extender (codex): policy context is unavailable",
    });
  });

  test("asks the host when the default policy repository has no active profile", async () => {
    expect(
      await handlePermissionRequest(
        {
          cwd: "/work/example",
          session_id: "thread-1",
          tool_input: { command: "git status" },
          tool_name: "Bash",
          },
          "codex",
      ),
    ).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest" },
      systemMessage: "Sandbox Extender (codex): no active profile for thread",
    });
  });

  test("allows an in-scope request through Cedar and records the decision", async () => {
    const homeFolder = await mkdtemp(join(tmpdir(), "sandbox-extender-hook-"));
    const root = join(homeFolder, ".agents", "sandbox-extender");
    const previousHomeFolder = process.env.HOME_FOLDER;
    process.env.HOME_FOLDER = homeFolder;
    try {
      const repository = new PolicyRepository(root);
      await repository.writeProposal({
        profile: {
          allowedTargets: ["/work/example"],
          groupings: [{
            id: "allow-bash",
            policies: { allow: "permit(principal, action, resource);" },
          }],
          id: "allow",
          policyRevision: "pending-review",
        },
        tests: [{
          expected: "allow",
          name: "allows the reviewed hook request",
          request: {
            action: "claude.Bash",
            arguments: { command: "pwd" },
            resource: "/work/example",
            threadId: "thread-1",
          },
        }],
      });
      const revision = commitReview(root);
      await repository.promoteProposal("allow", revision);
      await activateProfile(repository, "thread-1", "allow");

      expect(
        await handlePermissionRequest(
          {
            cwd: "/work/example",
            session_id: "thread-1",
            tool_input: { command: "pwd" },
            tool_name: "Bash",
          },
          "claude",
        ),
      ).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
        },
        systemMessage: "Sandbox Extender (claude): allowed by capability grouping",
      });

      expect(await readFile(join(root, "audit.yaml"), "utf8")).toContain("decision: allow");
    } finally {
      if (previousHomeFolder === undefined) delete process.env.HOME_FOLDER;
      else process.env.HOME_FOLDER = previousHomeFolder;
      await rm(homeFolder, { force: true, recursive: true });
    }
  });

  test("preserves raw command arguments for Profile request materialization", () => {
    expect(
      normalizeHookRequest(
        {
          cwd: "/work/example",
          session_id: "thread-1",
          tool_input: { command: "gh pr view 42 --repo Other/Repository" },
          tool_name: "Bash",
        },
        "claude",
      ),
    ).toMatchObject({
      arguments: { command: "gh pr view 42 --repo Other/Repository" },
      resource: "/work/example",
    });
  });

  test("does not impose GitHub-specific target rules on generic hook events", () => {
    expect(
      normalizeHookRequest(
        {
          cwd: "/work/example",
          session_id: "thread-1",
          tool_input: { command: "gh pr view 42" },
          tool_name: "Bash",
        },
        "codex",
      ),
    ).toMatchObject({ resource: "/work/example" });
  });

  test("uses the Codex PermissionRequest response envelope", async () => {
    const response = await handlePermissionRequest({ session_id: "thread-1" }, "codex");
    expect(response).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest" },
      systemMessage: "Sandbox Extender (codex): policy context is unavailable",
    });
  });

  test("maps Codex allow and deny decisions to the documented envelope", () => {
    expect(hookOutput("allow", "codex", "allowed").hookSpecificOutput).toEqual({
      decision: { behavior: "allow" },
      hookEventName: "PermissionRequest",
    });
    expect(hookOutput("deny", "codex", "denied").hookSpecificOutput).toEqual({
      decision: { behavior: "deny" },
      hookEventName: "PermissionRequest",
    });
  });

  test("maps Claude decisions to the PreToolUse envelope", () => {
    expect(hookOutput("allow", "claude", "allowed").hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    });
    expect(hookOutput("abstain", "claude", "unavailable").hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
    });
  });
});
