import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PolicyRepository } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function repository(): Promise<PolicyRepository> {
  const root = await mkdtemp(join(tmpdir(), "sandbox-extender-"));
  roots.push(root);
  return new PolicyRepository(root);
}

async function commitPolicyRevision(root: string): Promise<string> {
  for (const command of [
    ["git", "init", "--quiet"],
    ["git", "config", "user.email", "sandbox-extender@example.test"],
    ["git", "config", "user.name", "Sandbox Extender"],
    ["git", "add", "proposals", "tests"],
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
      "does not contain proposals/review.json",
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
      "does not contain proposals/review.json",
    );
  });
});
