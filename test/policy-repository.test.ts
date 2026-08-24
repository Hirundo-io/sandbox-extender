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

    await repo.promoteProposal("review", "a".repeat(40));
    expect((await repo.loadProfile("review")).policyRevision).toBe("a".repeat(40));
  });

  test("rejects proposals whose identity or authorization tests are invalid", async () => {
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
      "does not match its requested profile ID",
    );
  });
});
