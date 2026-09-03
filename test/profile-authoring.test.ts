import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PolicyRepository, proposeProfile } from "../src/index.js";
import { runFixtureGit } from "./git-fixture.js";

const request = {
  action: "codex.unified_exec",
  arguments: { command: "git status" },
  resource: "/work/example",
  threadId: "thread-1",
};

function commitPolicyRevision(root: string): string {
  for (const command of [
    ["init", "--quiet"],
    ["config", "user.email", "sandbox-extender@example.test"],
    ["config", "user.name", "Sandbox Extender"],
    ["add", "proposals", "tests"],
    ["commit", "--quiet", "-m", "Review policy proposal"],
  ]) {
    if (runFixtureGit(root, command).exitCode !== 0) {
      throw new Error(`could not run ${command.join(" ")}`);
    }
  }
  const result = runFixtureGit(root, ["rev-parse", "HEAD"]);
  return new TextDecoder().decode(result.stdout).trim();
}

describe("profile authoring", () => {
  test("rejects compound observed shell commands", async () => {
    await expect(
      proposeProfile("review-profile", {
        action: "codex.unified_exec",
        arguments: { command: "git status && git diff" },
        resource: "/workspace",
        threadId: "thread-1",
      }),
    ).rejects.toThrow("one authorization case");
  });

  test("rejects function-based observed commands that expand beyond their source", async () => {
    await expect(
      proposeProfile("function-profile", {
        action: "codex.unified_exec",
        arguments: { command: "inspect() { gh pr view 42; }; inspect" },
        resource: "github:pull-request:acme/example#42",
        threadId: "thread-1",
      }),
    ).rejects.toThrow("one authorization case");
  });
  test("writes a narrow proposal and promotes it only with a review revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-extender-authoring-"));
    try {
      const repository = new PolicyRepository(root);
      const proposal = await proposeProfile("inspect-repository", request);
      await repository.writeProposal(proposal);

      expect(await repository.listProfiles()).toEqual([]);
      expect(await readFile(join(root, "proposals", "inspect-repository.json"), "utf8")).toContain(
        '"pending-review"',
      );
      await expect(
        repository.promoteProposal("inspect-repository", "pending-review"),
      ).rejects.toThrow("policyRevision");

      const revision = commitPolicyRevision(root);
      await repository.promoteProposal("inspect-repository", revision);
      expect(await repository.listProfiles()).toEqual(["inspect-repository"]);
      expect((await repository.loadProfile("inspect-repository")).policyRevision).toBe(revision);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not widen the proposal beyond the observed action and target", async () => {
    const proposal = await proposeProfile("inspect-repository", request);
    expect(proposal.profile.allowedTargets).toEqual([request.resource]);
    expect(proposal.profile.groupings[0]?.policies.allowObservedRequest).toContain(
      'Action::"codex.unified_exec"',
    );
    expect(proposal.tests[1]?.expected).toBe("abstain");
    expect(proposal.tests[2]?.expected).toBe("abstain");
  });

  test("rejects observed arguments outside the JSON authorization boundary", async () => {
    await expect(
      proposeProfile("inspect-repository", {
        ...request,
        arguments: { command: undefined } as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow("JSON values");
  });

  test("rejects non-finite numbers at every argument depth", async () => {
    for (const argumentsValue of [{ count: NaN }, { nested: [Infinity] }]) {
      await expect(
        proposeProfile("inspect-repository", {
          ...request,
          arguments: argumentsValue,
        }),
      ).rejects.toThrow("finite JSON numbers");
    }
  });
});
