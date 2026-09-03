import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { proposeCompleteProfile } from "../src/profile-authoring.js";
import { PolicyRepository } from "../src/policy-repository.js";

const permissions = { env: [], ffi: [], net: [], read: [], run: [], sys: [], write: [] } as const;
const activationSource =
  "console.log(JSON.stringify({targets:[await new Response(Deno.stdin.readable).json().then((x) => x.workspace)]}));";

function definition() {
  return {
    allowedTargets: [],
    activationMaterializer: { permissions, runtimeVersion: "2.8.1", source: activationSource },
    groupings: [{ id: "maker", policies: { allow: "permit(principal, action, resource);" } }],
    id: "maker-fixture",
    policyRevision: "pending-review" as const,
    targetScope: "single" as const,
  };
}

const tests = [
  {
    activationArguments: { workspace: "/workspace" },
    expected: "allow" as const,
    name: "allows the frozen workspace",
    request: {
      action: "codex.unified_exec",
      arguments: { command: "bun add --ignore-scripts example" },
      resource: "/workspace",
    },
  },
];

describe("complete profile authoring", () => {
  test("derives a dedicated materializer path and reviewable integrity", () => {
    const proposal = proposeCompleteProfile(definition(), tests);
    expect(proposal.profile.activationMaterializer).toMatchObject({
      file: "materializers/activation/maker-fixture.ts",
      runtimeVersion: "2.8.1",
    });
    expect(proposal.profile.activationMaterializer?.integrity).toMatch(/^[0-9a-f]{64}$/);
    expect(proposal.tests[0]?.request.threadId).toBe("proposal-test");
  });

  test("writes only pending proposal files and refuses conflicting materializers", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-extender-complete-"));
    try {
      const repository = new PolicyRepository(root);
      const proposal = proposeCompleteProfile(definition(), tests);
      await repository.writeCompleteProposal(proposal, { activation: activationSource });
      expect(await readFile(join(root, "proposals", "maker-fixture.json"), "utf8")).toContain(
        "pending-review",
      );
      expect(
        await readFile(join(root, "materializers", "activation", "maker-fixture.ts"), "utf8"),
      ).toContain("targets");
      expect(await repository.listProfiles()).toEqual([]);
      await expect(
        repository.writeCompleteProposal(proposal, { activation: activationSource }),
      ).rejects.toThrow("overwrite");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test.each([
    { change: { id: "../escape" }, error: "Invalid string" },
    {
      change: {
        activationMaterializer: { permissions, runtimeVersion: "9.9.9", source: activationSource },
      },
      error: "unsupported Deno",
    },
    {
      change: { groupings: [{ id: "broken", policies: { nope: "permit(" } }] },
      error: "invalid Cedar",
    },
  ])("rejects unsafe complete definitions", ({ change, error }) => {
    expect(() =>
      proposeCompleteProfile(
        { ...definition(), ...change } as ReturnType<typeof definition>,
        tests,
      ),
    ).toThrow(error);
  });
});
