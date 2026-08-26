import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PolicyRepository } from "../src/index.js";
import type { PullRequestCommandRunner } from "../src/index.js";

const roots: string[] = [];
const sharedResolverDirectory = join(process.cwd(), "shared", "resolvers");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function repository(): Promise<PolicyRepository> {
  const root = await mkdtemp(join(tmpdir(), "sandbox-extender-"));
  roots.push(root);
  return new PolicyRepository(root);
}

async function installResolver(root: string, name: string): Promise<void> {
  await mkdir(join(root, "resolvers"), { recursive: true });
  await Bun.write(
    join(root, "resolvers", name),
    await readFile(join(sharedResolverDirectory, name), "utf8"),
  );
}

async function commitPolicyRevision(root: string): Promise<string> {
  for (const command of [
    ["git", "init", "--quiet"],
    ["git", "config", "user.email", "sandbox-extender@example.test"],
    ["git", "config", "user.name", "Sandbox Extender"],
    ["git", "add", "-A"],
    ["git", "commit", "--quiet", "-m", "Review policy proposal"],
  ]) {
    const result = Bun.spawnSync({ cmd: command, cwd: root });
    if (result.exitCode !== 0) throw new Error(`could not run ${command.join(" ")}`);
  }
  const result = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: root, stdout: "pipe" });
  return new TextDecoder().decode(result.stdout).trim();
}

describe("PolicyRepository", () => {
  test("loads a Cedar profile and persists thread bindings", async () => {
    const repo = await repository();
    await mkdir(join(repo.root, "profiles"));
    await Bun.write(
      join(repo.root, "profiles", "review.json"),
      JSON.stringify({
        allowedTargets: ["github:pull-request:acme/example#42"],
        groupings: [
          {
            id: "comments",
            policies: { allow: "permit(principal, action, resource);" },
          },
        ],
        id: "review",
        policyRevision: "abc123",
      }),
    );

    const profile = await repo.loadProfile("review");
    const binding = {
      fingerprint: "0".repeat(64),
      policyRevision: profile.policyRevision,
      profileId: profile.id,
    };
    await repo.writeState({ "thread-1": binding });

    expect(profile.allowedTargets.has("github:pull-request:acme/example#42")).toBe(true);
    expect(await repo.readState()).toEqual({ "thread-1": binding });
  });

  test("records decisions in an editable YAML audit log", async () => {
    const repo = await repository();

    await repo.appendAudit({ decision: "allow", profileId: "review" });

    const audit = await readFile(join(repo.root, "audit.yaml"), "utf8");
    expect(audit).toContain("decision: allow");
    expect(audit).toContain("profileId: review");
  });

  test("refuses to persist an invalid thread binding", async () => {
    const repo = await repository();
    await expect(repo.writeState({ "thread-1": {
      fingerprint: "short",
      policyRevision: "revision-1",
      profileId: "review",
    } })).rejects.toThrow();
  });

  test("rejects policy files that do not match the persisted Zod schema", async () => {
    const repo = await repository();
    await mkdir(join(repo.root, "profiles"));
    await Bun.write(
      join(repo.root, "profiles", "invalid.json"),
      JSON.stringify({
        allowedTargets: ["github:pull-request:acme/example#42"],
        groupings: [],
        id: "invalid",
        policyRevision: "abc123",
        unrecognized: true,
      }),
    );

    await expect(repo.loadProfile("invalid")).rejects.toThrow("not a valid policy profile");
  });

  test("only promotes a matching profile after every authorization test passes", async () => {
    const repo = await repository();
    await repo.writeProposal({
      profile: {
        allowedTargets: ["github:repository:acme/example"],
        groupings: [{
          id: "allow-read",
          policies: { allow: "permit(principal, action, resource);" },
        }],
        id: "review",
        policyRevision: "pending-review",
      },
      tests: [{
        expected: "allow",
        name: "allows the reviewed request",
        request: {
          action: "claude.Bash",
          arguments: { command: "gh pr view --repo acme/example" },
          resource: "github:repository:acme/example",
          threadId: "thread-1",
        },
      }],
    });

    const revision = await commitPolicyRevision(repo.root);
    await repo.promoteProposal("review", revision);
    expect((await repo.loadProfile("review")).policyRevision).toBe(revision);
  });

  test("verifies every no-resolver profile field against the reviewed proposal", async () => {
    const repo = await repository();
    await repo.writeProposal({
      profile: {
        allowedTargets: ["github:repository:acme/example"],
        groupings: [{
          id: "allow-read",
          policies: { allow: "permit(principal, action, resource);" },
        }],
        id: "review",
        policyRevision: "pending-review",
      },
      tests: [{
        expected: "allow",
        name: "allows the reviewed request",
        request: {
          action: "claude.Bash",
          arguments: { command: "gh pr view --repo acme/example" },
          resource: "github:repository:acme/example",
          threadId: "thread-1",
        },
      }],
    });
    const revision = await commitPolicyRevision(repo.root);
    await repo.promoteProposal("review", revision);
    const profileFile = join(repo.root, "profiles", "review.json");
    const reviewedProfile = JSON.parse(await readFile(profileFile, "utf8")) as Record<string, unknown>;

    await expect(repo.loadVerifiedProfile("review")).resolves.toEqual(expect.objectContaining({
      policyRevision: revision,
    }));
    const alterations: readonly Record<string, unknown>[] = [
      { ...reviewedProfile, allowedTargets: ["github:repository:evil/example"] },
      { ...reviewedProfile, groupings: [] },
      { ...reviewedProfile, sessionContext: ["unreviewed instruction"] },
      { ...reviewedProfile, targetScope: "single" },
      { ...reviewedProfile, policyRevision: "a".repeat(40) },
    ];
    for (const alteredProfile of alterations) {
      await Bun.write(profileFile, JSON.stringify(alteredProfile));
      await expect(repo.loadVerifiedProfile("review")).rejects.toThrow();
    }

    await Bun.write(join(repo.root, "proposals", "review.json"), JSON.stringify({
      ...reviewedProfile,
      allowedTargets: ["github:repository:evil/example"],
      policyRevision: "pending-review",
    }));
    const unrelatedRevision = await commitPolicyRevision(repo.root);
    await Bun.write(profileFile, JSON.stringify({
      ...reviewedProfile,
      policyRevision: unrelatedRevision,
    }));
    await expect(repo.loadVerifiedProfile("review")).rejects.toThrow(
      "does not match policy revision",
    );
  });

  test("runs target-resolver authorization tests from the reviewed revision", async () => {
    const repo = await repository();
    await repo.initialize();
    await installResolver(repo.root, "github-repository.ts");
    await repo.writeProposal({
      profile: {
        allowedTargets: ["github:repository:acme/example"],
        groupings: [{
          id: "allow-read",
          policies: { allow: "permit(principal, action, resource);" },
        }],
        id: "review",
        policyRevision: "pending-review",
        targetResolver: {
          file: "resolvers/github-repository.ts",
          language: "typescript",
        },
      },
      tests: [{
        expected: "allow",
        name: "allows the reviewed repository command",
        request: {
          action: "claude.Bash",
          arguments: { command: "gh pr view --repo acme/example" },
          resource: "/work/example",
          threadId: "thread-1",
        },
      }],
    });

    const revision = await commitPolicyRevision(repo.root);
    await expect(repo.promoteProposal("review", revision)).resolves.toBeUndefined();
    await expect(repo.loadVerifiedProfile("review")).resolves.toBeDefined();
    await Bun.write(
      join(repo.root, "resolvers", "github-repository.ts"),
      "console.log('github:repository:evil/example');\n",
    );
    await expect(repo.loadVerifiedProfile("review")).rejects.toThrow(
      "resolver resolvers/github-repository.ts does not match policy revision",
    );
  });

  test("rejects a resolver-reference change after review", async () => {
    const repo = await repository();
    await repo.initialize();
    await installResolver(repo.root, "github-repository.ts");
    await installResolver(repo.root, "github-pull-request.ts");
    await repo.writeProposal({
      profile: {
        allowedTargets: ["github:repository:acme/example"],
        groupings: [{ id: "allow", policies: { allow: "permit(principal, action, resource);" } }],
        id: "review",
        policyRevision: "pending-review",
        targetResolver: {
          file: "resolvers/github-repository.ts",
          language: "typescript",
        },
      },
      tests: [{
        expected: "allow",
        name: "allows the reviewed target",
        request: {
          action: "claude.Bash",
          arguments: { command: "gh pr view --repo acme/example" },
          resource: "/work/example",
          threadId: "thread-1",
        },
      }],
    });
    const revision = await commitPolicyRevision(repo.root);
    await repo.promoteProposal("review", revision);
    const profileFile = join(repo.root, "profiles", "review.json");
    const reviewedProfile = JSON.parse(await readFile(profileFile, "utf8")) as Record<string, unknown>;
    await Bun.write(profileFile, JSON.stringify({
      ...reviewedProfile,
      targetResolver: {
        file: "resolvers/github-pull-request.ts",
        language: "typescript",
      },
    }));

    await expect(repo.loadVerifiedProfile("review")).rejects.toThrow(
      "does not match policy revision",
    );
  });

  test("freezes a babysitter proposal's resolved target into the reviewed profile", async () => {
    const run: PullRequestCommandRunner = (command) => {
      if (command.join(" ") === "git rev-parse --show-toplevel") return "/work/example";
      if (command.join(" ") === "gh pr view 42 --repo acme/example --json url") {
        return JSON.stringify({ url: "https://github.com/acme/example/pull/42" });
      }
      return undefined;
    };
    const root = await mkdtemp(join(tmpdir(), "sandbox-extender-babysitter-"));
    roots.push(root);
    const repo = new PolicyRepository(root, run);
    await repo.initialize();
    await installResolver(root, "github-pull-request.ts");
    await repo.writeProposal({
      profile: {
        allowedTargets: [],
        groupings: [{
          id: "pull-request",
          policies: {
            allow: 'permit(principal, action, resource == Target::"__SANDBOX_EXTENDER_PULL_REQUEST_TARGET__");',
          },
        }],
        id: "babysitter",
        policyRevision: "pending-review",
        pullRequestBinding: {
          pullRequest: "acme/example#42",
          workspace: "/work/example",
        },
        targetResolver: {
          file: "resolvers/github-pull-request.ts",
          language: "typescript",
        },
        targetScope: "single",
      },
      tests: [{
        expected: "allow",
        name: "allows only the frozen pull request",
        request: {
          action: "codex.unified_exec",
          arguments: { command: "gh pr view 42 --repo acme/example" },
          resource: "/work/example",
          threadId: "thread-1",
        },
      }],
    });

    const revision = await commitPolicyRevision(root);
    await repo.promoteProposal("babysitter", revision);

    const persisted: unknown = JSON.parse(await readFile(join(root, "profiles", "babysitter.json"), "utf8"));
    expect(persisted).toEqual(expect.objectContaining({
      allowedTargets: ["github:pull-request:acme/example#42"],
      policyRevision: revision,
    }));
    expect(JSON.stringify(persisted)).toContain('Target::\\"github:pull-request:acme/example#42\\"');
    expect(JSON.stringify(persisted)).not.toContain("pullRequestBinding");
  });

  test("rejects a revision without the reviewed proposal and tests", async () => {
    const repo = await repository();
    await repo.writeProposal({
      profile: {
        allowedTargets: ["github:repository:acme/example"],
        groupings: [],
        id: "review",
        policyRevision: "pending-review",
      },
      tests: [{
        expected: "abstain",
        name: "does not make a decision",
        request: {
          action: "claude.Bash",
          arguments: { command: "git status" },
          resource: "github:repository:acme/example",
          threadId: "thread-1",
        },
      }],
    });
    const revision = await commitPolicyRevision(repo.root);
    await Bun.write(join(repo.root, "proposals", "review.json"), "{}\n");

    await expect(repo.promoteProposal("review", revision)).resolves.toBeUndefined();
    await expect(repo.promoteProposal("review", "a".repeat(40))).rejects.toThrow(
      "is not a Git commit",
    );
  });

  test("rejects an invalid proposal before it can be promoted", async () => {
    const repo = await repository();
    await repo.initialize();
    await Bun.write(
      join(repo.root, "proposals", "review.json"),
      JSON.stringify({
        allowedTargets: ["github:repository:acme/example"],
        groupings: [],
        id: "other",
        policyRevision: "pending-review",
      }),
    );

    await expect(repo.promoteProposal("review", "a".repeat(40))).rejects.toThrow(
      "is not a Git commit",
    );
  });
});
