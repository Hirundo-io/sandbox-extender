import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PolicyRepository, proposeProfile } from "../src/index.js";

const request = {
  action: "codex.unified_exec",
  arguments: { command: "git status" },
  resource: "/work/example",
  threadId: "thread-1",
};

function commitPolicyRevision(root: string): string {
  for (const command of [
    ["git", "init", "--quiet"],
    ["git", "config", "user.email", "sandbox-extender@example.test"],
    ["git", "config", "user.name", "Sandbox Extender"],
    ["git", "add", "proposals", "tests"],
    ["git", "commit", "--quiet", "-m", "Review policy proposal"],
  ]) {
    if (Bun.spawnSync({ cmd: command, cwd: root }).exitCode !== 0) {
      throw new Error(`could not run ${command.join(" ")}`);
    }
  }
  const result = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: root, stdout: "pipe" });
  return new TextDecoder().decode(result.stdout).trim();
}

describe("profile authoring", () => {
  test("writes a narrow proposal and promotes it only with a review revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-extender-authoring-"));
    try {
      const repository = new PolicyRepository(root);
      const proposal = proposeProfile("inspect-repository", request);
      await repository.writeProposal(proposal);

      expect(await repository.listProfiles()).toEqual([]);
      expect(await readFile(join(root, "proposals", "inspect-repository.json"), "utf8")).toContain('"pending-review"');
      await expect(repository.promoteProposal("inspect-repository", "pending-review")).rejects.toThrow("policyRevision");

      const revision = commitPolicyRevision(root);
      await repository.promoteProposal("inspect-repository", revision);
      expect(await repository.listProfiles()).toEqual(["inspect-repository"]);
      expect((await repository.loadProfile("inspect-repository")).policyRevision).toBe(revision);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not widen the proposal beyond the observed action and target", () => {
    const proposal = proposeProfile("inspect-repository", request);
    expect(proposal.profile.allowedTargets).toEqual([request.resource]);
    expect(proposal.profile.groupings[0]?.policies.allowObservedRequest).toContain('Action::"codex.unified_exec"');
    expect(proposal.tests[1]?.expected).toBe("abstain");
    expect(proposal.tests[2]?.expected).toBe("abstain");
  });

  test("rejects observed arguments outside the JSON authorization boundary", () => {
    expect(() => proposeProfile("inspect-repository", {
      ...request,
      arguments: { command: undefined } as unknown as Record<string, unknown>,
    })).toThrow("JSON values");
  });
});
