import { describe, expect, test } from "bun:test";
import { runFixtureGit } from "./git-fixture.js";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handlePermissionRequest, hookOutput, normalizeHookRequest } from "../src/hook.js";
import { activateProfile } from "../src/policy-service.js";
import type { ProfileProposal } from "../src/types.js";
import { watcherReviewThreadsQuery } from "./fixtures/watcher-queries.js";

import { PolicyRepository } from "../src/policy-repository.js";

function commitReview(root: string, extraPaths: readonly string[] = []): string {
  for (const command of [
    ["init", "--quiet"],
    ["config", "user.email", "sandbox-extender@example.test"],
    ["config", "user.name", "Sandbox Extender"],
    ["add", "proposals", "tests", ...extraPaths],
    ["commit", "--quiet", "-m", "Review profile"],
  ]) {
    const result = runFixtureGit(root, command);
    if (result.exitCode !== 0) throw new Error(`could not run ${command.join(" ")}`);
  }
  const result = runFixtureGit(root, ["rev-parse", "HEAD"]);
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
          groupings: [
            {
              id: "allow-bash",
              policies: { allow: "permit(principal, action, resource);" },
            },
          ],
          id: "allow",
          policyRevision: "pending-review",
        },
        tests: [
          {
            expected: "allow",
            name: "allows the reviewed hook request",
            request: {
              action: "claude.Bash",
              arguments: { command: "pwd" },
              resource: "/work/example",
              threadId: "thread-1",
            },
          },
        ],
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

  test("Babysitter evaluates watcher and body-file commands through both host hooks", async () => {
    const homeFolder = await realpath(await mkdtemp(join(tmpdir(), "babysitter-hook-")));
    const root = join(homeFolder, ".agents", "sandbox-extender");
    const workspace = join(homeFolder, "workspace");
    const previousHomeFolder = process.env.HOME_FOLDER;
    process.env.HOME_FOLDER = homeFolder;
    try {
      await mkdir(workspace);
      await mkdir(join(workspace, "notes"));
      const attributed = "_Replying as **Codex**._ Verified the fix.";
      await writeFile(join(workspace, "notes", "comment.md"), attributed);
      await writeFile(join(workspace, "unattributed.md"), "Verified the fix.");
      await writeFile(join(homeFolder, "outside.md"), attributed);
      await symlink(join(homeFolder, "outside.md"), join(workspace, "escape.md"));
      await symlink(join(workspace, "notes"), join(workspace, "linked-notes"));
      const shared = join(import.meta.dir, "..", "shared");
      const template = JSON.parse(
        await readFile(join(shared, "profile-templates", "babysitter.json"), "utf8"),
      ) as ProfileProposal["profile"];
      await cp(join(shared, "materializers"), join(root, "materializers"), { recursive: true });
      const repository = new PolicyRepository(root);
      await repository.writeProposal({
        profile: {
          ...template,
          activationMaterializer: undefined,
          allowedTargets: ["github:pull-request:acme/example#42"],
        },
        tests: [
          {
            expected: "allow",
            name: "reviewed PR read",
            request: {
              action: "codex.Bash",
              arguments: { command: "gh pr view 42 --repo acme/example" },
              resource: workspace,
              threadId: "watcher",
            },
          },
        ],
      });
      await repository.promoteProposal("babysitter", commitReview(root, ["materializers"]));
      await activateProfile(repository, "watcher", "babysitter");
      const threads = `gh api graphql -f 'query=${watcherReviewThreadsQuery}' -F owner=acme -F name=example -F number=42`;
      const comment = "gh pr comment 42 --repo acme/example --body-file";
      const cases = [
        [threads, true],
        [`${threads} -F cursor=Y3Vyc29yOjEwMA==`, true],
        [threads.replace("number=42", "number=43"), false],
        [threads.replace("name=example", "name=other"), false],
        [`${comment} notes/comment.md`, true],
        [`${comment} ${workspace}/notes/comment.md`, true],
        [`cd notes && ${comment} comment.md`, true],
        [`${comment} unattributed.md`, false],
        [`${comment} missing.md`, false],
        [`${comment} notes`, false],
        [`${comment} notes/../notes/comment.md`, false],
        [`${comment} notes/comment.md --body-file notes/comment.md`, false],
        [`${comment} ../outside.md`, false],
        [`${comment} ${homeFolder}/outside.md`, false],
        [`${comment} escape.md`, false],
        [`${comment} linked-notes/comment.md`, false],
        [`${comment} -`, false],
        [`${comment} notes/comment.md --edit-last`, false],
        [`${comment} notes/comment.md --body extra`, false],
        [`${comment.replace("42", "43")} notes/comment.md`, false],
        ["gh pr comment 42 --repo acme/example --body unattributed", false],
        [
          "python3 /home/agent/.agents/skills/babysit-pr/scripts/gh_pr_watch.py --pr 42 --watch",
          false,
        ],
        [
          "python3 /home/agent/.agents/skills/babysit-pr/scripts/gh_pr_watch.py --pr 42 --once",
          false,
        ],
        ["python3 -c 'print(42)'", false],
      ] as const;
      for (const host of ["codex", "claude"] as const) {
        for (const [command, allowed] of cases) {
          const result = await handlePermissionRequest(
            {
              cwd: workspace,
              session_id: "watcher",
              // Codex maps exec_command to Bash/command before PermissionRequest.
              // https://learn.chatgpt.com/docs/hooks#permissionrequest
              tool_name: "Bash",
              tool_input: { command },
            },
            host,
          );
          expect({ command, output: result.hookSpecificOutput }).toEqual({
            command,
            output:
              host === "codex"
                ? {
                    hookEventName: "PermissionRequest",
                    ...(allowed ? { decision: { behavior: "allow" } } : {}),
                  }
                : { hookEventName: "PreToolUse", permissionDecision: allowed ? "allow" : "ask" },
          });
        }
      }
    } finally {
      if (previousHomeFolder === undefined) delete process.env.HOME_FOLDER;
      else process.env.HOME_FOLDER = previousHomeFolder;
      await rm(homeFolder, { force: true, recursive: true });
    }
  }, 30_000);

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
