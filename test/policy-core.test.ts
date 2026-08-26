import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PolicyCore, type NormalizedRequest, type Profile } from "../src/index.js";

const request: NormalizedRequest = {
  action: "github.pr.comment.create",
  arguments: { body: "Reviewed." },
  resource: "github:pull-request:Hirundo-io/example#42",
  threadId: "codex-thread-1",
};

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    allowedTargets: new Set([request.resource]),
    groupings: [],
    id: "review-current-pr",
    policyRevision: "4f9e7a1",
    ...overrides,
  };
}

describe("PolicyCore", () => {
  test("abstains without an active profile", () => {
    expect(new PolicyCore().evaluate(request)).toEqual({
      decision: "abstain",
      reason: "no active profile for thread",
    });
  });

  test("validates token lifetime and can disable an active profile", () => {
    expect(() => new PolicyCore(0)).toThrow("positive safe integer");
    const core = new PolicyCore();
    core.activate(profile(), request.threadId);
    core.disable(request.threadId);
    expect(core.evaluate(request).decision).toBe("abstain");
  });

  test("abstains when the resolved target is outside the profile scope", () => {
    const core = new PolicyCore();
    core.activate(profile({ allowedTargets: new Set() }), request.threadId);

    expect(core.evaluate(request)).toEqual({
      decision: "abstain",
      reason: "resolved target is outside the allowed target set",
    });
  });

  test("uses the first decisive grouping and issues a one-time token", () => {
    const core = new PolicyCore();
    core.activate(
      profile({
        groupings: [
          { id: "not-applicable", evaluate: () => "abstain" },
          { id: "allow-comment", evaluate: () => "allow" },
          { id: "later-deny", evaluate: () => "deny" },
        ],
      }),
      request.threadId,
    );

    const result = core.evaluate(request);

    expect(result.decision).toBe("allow");
    expect(result.matchedGroupingId).toBe("allow-comment");
    expect(result.token).toBeDefined();
    expect(core.consumeToken(result.token!.id, request)).toBe(true);
    expect(core.consumeToken(result.token!.id, request)).toBe(false);
  });

  test("does not allow a token to authorize a different request", () => {
    const core = new PolicyCore();
    core.activate(
      profile({ groupings: [{ id: "allow-comment", evaluate: () => "allow" }] }),
      request.threadId,
    );

    const result = core.evaluate(request);
    const differentRequest = { ...request, arguments: { body: "Different." } };

    expect(core.consumeToken(result.token!.id, differentRequest)).toBe(false);
  });

  test("invalidates tokens when their active profile is disabled", () => {
    const core = new PolicyCore();
    core.activate(profile({ groupings: [{ id: "allow", evaluate: () => "allow" }] }), request.threadId);
    const result = core.evaluate(request);
    core.disable(request.threadId);
    expect(core.consumeToken(result.token!.id, request)).toBe(false);
  });

  test("authorizes every Bash or Zsh command while allowing structural cd flow", () => {
    const core = new PolicyCore();
    core.activate(
      profile({
        groupings: [{
          id: "npm",
          evaluate: ({ request: evaluated }) =>
            evaluated.arguments.command === "npm i zod" ? "allow" : "abstain",
        }],
      }),
      request.threadId,
    );

    expect(core.evaluate({
      ...request,
      action: "codex.unified_exec",
      arguments: { command: "cd packages/app && npm i zod" },
    }).decision).toBe("allow");
    expect(core.evaluate({
      ...request,
      action: "codex.unified_exec",
      arguments: { command: "for item in one; do npm i zod; done" },
    }).decision).toBe("allow");
    expect(core.evaluate({
      ...request,
      action: "codex.unified_exec",
      arguments: { command: "npm i zod && curl example.test" },
    }).decision).toBe("abstain");
  });

  test("automatically allows non-mutating shell builtins", () => {
    const core = new PolicyCore();
    core.activate(profile(), request.threadId);

    for (const command of [
      ":",
      "true",
      "false",
      "pwd",
      "echo safe",
      "echo /tmp/literal-path",
      "printf '%s' ../../literal-path",
      "test -n /tmp/literal-string",
    ]) {
      expect(core.evaluate({
        ...request,
        action: "codex.unified_exec",
        arguments: { command },
        resource: process.cwd(),
      }).decision).toBe("allow");
    }
  });

  test("automatically allows filesystem tests only within the working directory", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sandbox-extender-builtins-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "sandbox-extender-builtins-outside-"));
    try {
      await mkdir(join(workspace, "nested"));
      await symlink(outside, join(workspace, "linked"));
      const core = new PolicyCore();
      core.activate(profile(), request.threadId);
      const workspaceRequest = {
        ...request,
        action: "codex.unified_exec",
        resource: workspace,
      };

      for (const command of [
        "test -e nested/file",
        "test -d nested",
        "test nested/older -nt nested/newer",
      ]) {
        expect(core.evaluate({
          ...workspaceRequest,
          arguments: { command },
        }).decision).toBe("allow");
      }

      for (const command of [
        `test -e ${outside}`,
        `test -G ${outside}`,
        "test -f ../outside/file",
        "test -e linked/file",
      ]) {
        expect(core.evaluate({
          ...workspaceRequest,
          arguments: { command },
        }).decision).toBe("abstain");
      }

      expect(core.evaluate({
        ...workspaceRequest,
        arguments: { command: "[ -d nested ]" },
      }).decision).toBe("abstain");
    } finally {
      await rm(workspace, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  test("allows an outside filesystem test when policy explicitly matches it", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sandbox-extender-builtins-policy-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "sandbox-extender-builtins-policy-outside-"));
    try {
      const command = `test -e ${outside}`;
      const core = new PolicyCore();
      core.activate(profile({
        allowedTargets: new Set([workspace]),
        groupings: [{
          id: "outside-test",
          evaluate: ({ request: evaluated }) =>
            evaluated.arguments.command === command ? "allow" : "abstain",
        }],
      }), request.threadId);

      expect(core.evaluate({
        ...request,
        action: "codex.unified_exec",
        arguments: { command },
        resource: workspace,
      }).decision).toBe("allow");
    } finally {
      await rm(workspace, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  test("rejects directory changes outside the original workspace", () => {
    const core = new PolicyCore();
    core.activate(profile({
      groupings: [{ id: "allow", evaluate: () => "allow" }],
    }), request.threadId);
    expect(core.evaluate({
      ...request,
      action: "codex.unified_exec",
      arguments: { command: "cd ../outside && npm i zod" },
    }).decision).toBe("abstain");
  });

  test("does not authorize filesystem paths that escape a workspace target", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sandbox-extender-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "sandbox-extender-outside-"));
    const nested = join(workspace, "nested");
    try {
      await mkdir(nested);
      await symlink(outside, join(workspace, "linked"));
      const core = new PolicyCore();
      core.activate(profile({
        allowedTargets: new Set([workspace]),
        groupings: [{ id: "allow", evaluate: () => "allow" }],
      }), request.threadId);
      const workspaceRequest = {
        ...request,
        action: "codex.unified_exec",
        resource: workspace,
      };

      for (const command of [
        "git status -- /tmp/outside",
        "git -C ../outside status",
        "git -C../outside status",
        "tool --config=../outside",
        "tool -I../outside",
        "git -C= status",
        "tool --cwd",
        "tool --cwd nested --config ../../outside",
        "tool ./linked/file",
      ]) {
        expect(core.evaluate({
          ...workspaceRequest,
          arguments: { command },
        }).decision).toBe("abstain");
      }

      expect(core.evaluate({
        ...workspaceRequest,
        arguments: { command: "git -C nested status -- ../nested" },
      }).decision).toBe("allow");
      expect(core.evaluate({
        ...workspaceRequest,
        arguments: { command: "gh pr view --repo acme/example" },
      }).decision).toBe("allow");
      expect(core.evaluate({
        ...workspaceRequest,
        arguments: { command: "curl https://example.test/api" },
      }).decision).toBe("allow");
    } finally {
      await rm(workspace, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  test("evaluates Cedar policies and abstains when none match", () => {
    const core = new PolicyCore();
    core.activate(
      profile({
        groupings: [
          {
            id: "comment-only",
            policies: {
              permitComment:
                'permit(principal, action == Action::"github.pr.comment.create", resource);',
            },
          },
        ],
      }),
      request.threadId,
    );

    expect(core.evaluate(request).decision).toBe("allow");
    expect(
      core.evaluate({ ...request, action: "github.pr.close" }).decision,
    ).toBe("abstain");
  });

  test("resolves every compound command before authorizing it", () => {
    const core = new PolicyCore();
    core.activate(profile({
      allowedTargets: new Set(["github:repository:acme/example"]),
      groupings: [{
        id: "read",
        evaluate: () => "allow",
      }],
      targetResolver: {
        file: join(process.cwd(), "shared", "resolvers", "github-repository.ts"),
        language: "typescript",
      },
    }), request.threadId);
    expect(core.evaluate({
      ...request,
      action: "codex.unified_exec",
      arguments: {
        command: "gh pr view --repo acme/example && gh pr view --repo evil/example",
      },
    }).decision).toBe("abstain");
  });

});
