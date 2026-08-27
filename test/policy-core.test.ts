import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PolicyCore, type NormalizedRequest, type Profile } from "../src/index.js";
import { materializerIntegrity } from "../src/materializer-policy.js";

const emptyPermissions = { env: [], ffi: [], net: [], read: [], run: [], sys: [], write: [] } as const;

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
  test("abstains without an active profile", async () => {
    expect(await new PolicyCore().evaluate(request)).toEqual({
      decision: "abstain",
      reason: "no active profile for thread",
    });
  });

  test("validates token lifetime and can disable an active profile", async () => {
    expect(() => new PolicyCore(0)).toThrow("positive safe integer");
    const core = new PolicyCore();
    core.activate(profile(), request.threadId);
    core.disable(request.threadId);
    expect((await core.evaluate(request)).decision).toBe("abstain");
  });

  test("abstains when the resolved target is outside the profile scope", async () => {
    const core = new PolicyCore();
    core.activate(profile({ allowedTargets: new Set() }), request.threadId);

    expect(await core.evaluate(request)).toEqual({
      decision: "abstain",
      reason: "resolved target is outside the allowed target set",
    });
  });

  test("uses the first decisive grouping and issues a one-time token", async () => {
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

    const result = await core.evaluate(request);

    expect(result.decision).toBe("allow");
    expect(result.matchedGroupingId).toBe("allow-comment");
    expect(result.token).toBeDefined();
    expect(await core.consumeToken(result.token!.id, request)).toBe(true);
    expect(await core.consumeToken(result.token!.id, request)).toBe(false);
  });

  test("does not allow a token to authorize a different request", async () => {
    const core = new PolicyCore();
    core.activate(
      profile({ groupings: [{ id: "allow-comment", evaluate: () => "allow" }] }),
      request.threadId,
    );

    const result = await core.evaluate(request);
    const differentRequest = { ...request, arguments: { body: "Different." } };

    expect(await core.consumeToken(result.token!.id, differentRequest)).toBe(false);
  });

  test("invalidates tokens when their active profile is disabled", async () => {
    const core = new PolicyCore();
    core.activate(profile({ groupings: [{ id: "allow", evaluate: () => "allow" }] }), request.threadId);
    const result = await core.evaluate(request);
    core.disable(request.threadId);
    expect(await core.consumeToken(result.token!.id, request)).toBe(false);
  });

  test("authorizes every Bash or POSIX command while allowing structural cd flow", async () => {
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

    expect((await core.evaluate({
      ...request,
      action: "codex.unified_exec",
      arguments: { command: "cd packages/app && npm i zod" },
    })).decision).toBe("allow");
    expect((await core.evaluate({
      ...request,
      action: "codex.unified_exec",
      arguments: { command: "for item in one; do npm i zod; done" },
    })).decision).toBe("allow");
    expect((await core.evaluate({
      ...request,
      action: "codex.unified_exec",
      arguments: { command: "npm i zod && curl example.test" },
    })).decision).toBe("abstain");
  });

  test("automatically allows non-mutating shell builtins", async () => {
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
      "printf -- '-v' PATH",
      "test -n /tmp/literal-string",
    ]) {
      expect((await core.evaluate({
        ...request,
        action: "codex.unified_exec",
        arguments: { command },
        resource: process.cwd(),
      })).decision).toBe("allow");
    }
  });

  test("does not automatically authorize printf variable assignment", async () => {
    const core = new PolicyCore();
    core.activate(profile({
      groupings: [{
        id: "npm",
        evaluate: ({ request: evaluated }) =>
          evaluated.arguments.command === "npm i zod" ? "allow" : "abstain",
      }],
    }), request.threadId);

    expect((await core.evaluate({
      ...request,
      action: "codex.unified_exec",
      arguments: { command: "printf -v PATH /tmp/attacker-bin; npm i zod" },
      resource: process.cwd(),
    })).decision).toBe("abstain");
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
        expect((await core.evaluate({
          ...workspaceRequest,
          arguments: { command },
        })).decision).toBe("allow");
      }

      for (const command of [
        `test -e ${outside}`,
        `test -G ${outside}`,
        "test -f ../outside/file",
        "test -e linked/file",
      ]) {
        expect((await core.evaluate({
          ...workspaceRequest,
          arguments: { command },
        })).decision).toBe("abstain");
      }

      expect((await core.evaluate({
        ...workspaceRequest,
        arguments: { command: "[ -d nested ]" },
      })).decision).toBe("abstain");
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

      expect((await core.evaluate({
        ...request,
        action: "codex.unified_exec",
        arguments: { command },
        resource: workspace,
      })).decision).toBe("allow");
    } finally {
      await rm(workspace, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  test("rejects directory changes outside the original workspace", async () => {
    const core = new PolicyCore();
    core.activate(profile({
      groupings: [{ id: "allow", evaluate: () => "allow" }],
    }), request.threadId);
    expect((await core.evaluate({
      ...request,
      action: "codex.unified_exec",
      arguments: { command: "cd ../outside && npm i zod" },
    })).decision).toBe("abstain");
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
        expect((await core.evaluate({
          ...workspaceRequest,
          arguments: { command },
        })).decision).toBe("abstain");
      }

      expect((await core.evaluate({
        ...workspaceRequest,
        arguments: { command: "git -C nested status -- ../nested" },
      })).decision).toBe("allow");
      expect((await core.evaluate({
        ...workspaceRequest,
        arguments: { command: "gh pr view --repo acme/example" },
      })).decision).toBe("allow");
      expect((await core.evaluate({
        ...workspaceRequest,
        arguments: { command: "curl https://example.test/api" },
      })).decision).toBe("allow");
    } finally {
      await rm(workspace, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  test("evaluates Cedar policies and abstains when none match", async () => {
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

    expect((await core.evaluate(request)).decision).toBe("allow");
    expect(
      (await core.evaluate({ ...request, action: "github.pr.close" })).decision,
    ).toBe("abstain");
  });

  test("exposes resolved loop arguments and control-flow facts to Capability Rules", async () => {
    const commands: unknown[] = [];
    const core = new PolicyCore();
    core.activate(profile({
      groupings: [{
        id: "loops",
        evaluate: ({ command }) => {
          commands.push(command);
          return "allow";
        },
      }],
    }), request.threadId);

    expect((await core.evaluate({
      ...request,
      action: "codex.unified_exec",
      arguments: { command: 'for item in one "two words"; do tool "$item"; done' },
    })).decision).toBe("allow");
    expect(commands).toEqual([
      expect.objectContaining({ controlFlow: "for", iteration: 0, repetition: "finite", role: "body", words: ["tool", "one"] }),
      expect.objectContaining({ controlFlow: "for", iteration: 1, repetition: "finite", role: "body", words: ["tool", "two words"] }),
    ]);

    commands.length = 0;
    expect((await core.evaluate({
      ...request,
      action: "codex.unified_exec",
      arguments: { command: "while probe; do work; done" },
    })).decision).toBe("allow");
    expect(commands).toEqual([
      expect.objectContaining({ controlFlow: "while", repetition: "potentially-unbounded", role: "condition" }),
      expect.objectContaining({ controlFlow: "while", repetition: "potentially-unbounded", role: "body" }),
    ]);
  });

  test("resolves every compound command before authorizing it", async () => {
    const file = join(process.cwd(), "shared", "materializers", "requests", "github-repository.ts");
    const reviewedSource = readFileSync(file, "utf8");
    const core = new PolicyCore();
    core.activate(profile({
      allowedTargets: new Set(["github:repository:acme/example"]),
      groupings: [{
        id: "read",
        evaluate: () => "allow",
      }],
      requestMaterializer: {
        file,
        integrity: materializerIntegrity(reviewedSource, emptyPermissions, "2.8.1"),
        language: "typescript",
        permissions: emptyPermissions,
        reviewedSource,
        runtimeVersion: "2.8.1",
      },
    }), request.threadId);
    expect((await core.evaluate({
      ...request,
      action: "codex.unified_exec",
      arguments: {
        command: "gh pr view --repo acme/example && gh pr view --repo evil/example",
      },
    })).decision).toBe("abstain");
  });

});
