import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PolicyRepository } from "../src/index.js";

const roots: string[] = [];
const sharedMaterializerDirectory = join(process.cwd(), "shared", "materializers");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function repository(): Promise<PolicyRepository> {
  const root = await mkdtemp(join(tmpdir(), "sandbox-extender-"));
  roots.push(root);
  return new PolicyRepository(root);
}

async function installMaterializer(root: string, kind: "activation" | "requests", name: string): Promise<void> {
  await mkdir(join(root, "materializers", kind), { recursive: true });
  await Bun.write(
    join(root, "materializers", kind, name),
    await readFile(join(sharedMaterializerDirectory, kind, name), "utf8"),
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
      allowedTargets: ["github:pull-request:acme/example#42"],
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
      allowedTargets: ["github:repository:acme/example"],
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

  test("verifies every Profile field against the reviewed proposal", async () => {
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

  test("runs request-materializer authorization tests from the reviewed revision", async () => {
    const repo = await repository();
    await repo.initialize();
    await installMaterializer(repo.root, "requests", "github-repository.ts");
    await repo.writeProposal({
      profile: {
        allowedTargets: ["github:repository:acme/example"],
        groupings: [{
          id: "allow-read",
          policies: { allow: "permit(principal, action, resource);" },
        }],
        id: "review",
        policyRevision: "pending-review",
        requestMaterializer: {
          file: "materializers/requests/github-repository.ts",
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
      join(repo.root, "materializers", "requests", "github-repository.ts"),
      "console.log(JSON.stringify({resource:'github:repository:evil/example',context:{}}));\n",
    );
    await expect(repo.loadVerifiedProfile("review")).rejects.toThrow(
      "materializer materializers/requests/github-repository.ts does not match policy revision",
    );
  });

  test("rejects a request-materializer reference change after review", async () => {
    const repo = await repository();
    await repo.initialize();
    await installMaterializer(repo.root, "requests", "github-repository.ts");
    await installMaterializer(repo.root, "requests", "github-pull-request.ts");
    await repo.writeProposal({
      profile: {
        allowedTargets: ["github:repository:acme/example"],
        groupings: [{ id: "allow", policies: { allow: "permit(principal, action, resource);" } }],
        id: "review",
        policyRevision: "pending-review",
        requestMaterializer: {
          file: "materializers/requests/github-repository.ts",
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
      requestMaterializer: {
        file: "materializers/requests/github-pull-request.ts",
        language: "typescript",
      },
    }));

    await expect(repo.loadVerifiedProfile("review")).rejects.toThrow(
      "does not match policy revision",
    );
  });

  test("keeps Babysitter reusable and tests it with activation arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-extender-babysitter-"));
    roots.push(root);
    const repo = new PolicyRepository(root);
    await repo.initialize();
    await installMaterializer(root, "activation", "github-pull-request.ts");
    await installMaterializer(root, "requests", "github-pull-request.ts");
    await repo.writeProposal({
      profile: {
        allowedTargets: [],
        groupings: [{
          id: "pull-request",
          policies: {
            allow: 'permit(principal, action, resource) when { context.materialized.operation == "github.pull-request.view" };',
          },
        }],
        id: "babysitter",
        policyRevision: "pending-review",
        activationMaterializer: {
          file: "materializers/activation/github-pull-request.ts",
          language: "typescript",
        },
        requestMaterializer: {
          file: "materializers/requests/github-pull-request.ts",
          language: "typescript",
        },
        targetScope: "single",
      },
      tests: [{
        activationArguments: { pullRequest: 42, repository: "acme/example" },
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
      activationMaterializer: expect.objectContaining({ file: "materializers/activation/github-pull-request.ts" }),
      allowedTargets: [],
      policyRevision: revision,
    }));
    expect(JSON.stringify(persisted)).not.toContain("acme/example#42");
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
