import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { proposeCompleteProfile } from "../src/profile-authoring.js";
import { verifyMaterializerIntegrity } from "../src/materializer-policy.js";
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
  test("rejects empty tests at the authoring boundary", () => {
    expect(() => proposeCompleteProfile(definition(), [])).toThrow("at least one test");
  });

  test.each([
    { unexpected: true },
    { allowedTargets: [42] },
    { policyRevision: "unreviewed" },
    { sessionContext: [""] },
  ])("rejects malformed complete definitions before persistence", (change) => {
    expect(() =>
      proposeCompleteProfile(
        { ...definition(), ...change } as unknown as ReturnType<typeof definition>,
        tests,
      ),
    ).toThrow();
  });

  test("derives a dedicated materializer path and reviewable integrity", () => {
    const proposal = proposeCompleteProfile(definition(), tests);
    expect(proposal.profile.activationMaterializer).toMatchObject({
      file: "materializers/activation/maker-fixture.ts",
      runtimeVersion: "2.8.1",
    });
    expect(proposal.profile.activationMaterializer?.integrity).toMatch(/^[0-9a-f]{64}$/);
    expect(proposal.tests[0]?.request.threadId).toBe("proposal-test");
  });

  test.each([activationSource, `${activationSource}\n`])(
    "preserves materializer bytes and refuses overwrites",
    async (source) => {
      const root = await mkdtemp(join(tmpdir(), "sandbox-extender-complete-"));
      try {
        const repository = new PolicyRepository(root);
        const proposal = proposeCompleteProfile(
          {
            ...definition(),
            activationMaterializer: { ...definition().activationMaterializer, source },
          },
          tests,
        );
        await repository.writeCompleteProposal(proposal, { activation: source });
        expect(await readFile(join(root, "proposals", "maker-fixture.json"), "utf8")).toContain(
          "pending-review",
        );
        expect(
          await readFile(join(root, "materializers", "activation", "maker-fixture.ts"), "utf8"),
        ).toBe(source);
        verifyMaterializerIntegrity(
          proposal.profile.activationMaterializer!,
          await readFile(join(root, "materializers", "activation", "maker-fixture.ts"), "utf8"),
        );
        expect(await repository.listProfiles()).toEqual([]);
        await expect(
          repository.writeCompleteProposal(proposal, { activation: source }),
        ).rejects.toThrow("overwrite");
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
  );

  test("rejects tampered source before writing proposal artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-extender-complete-"));
    try {
      const repository = new PolicyRepository(root);
      const proposal = proposeCompleteProfile(definition(), tests);
      await expect(
        repository.writeCompleteProposal(proposal, { activation: activationSource + "\n" }),
      ).rejects.toThrow("integrity mismatch");
      await expect(
        readFile(join(root, "materializers", "activation", "maker-fixture.ts")),
      ).rejects.toThrow("ENOENT");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test.each(["allow", "abstain"] as const)(
    "rejects targetless profiles even with %s tests",
    (expected) => {
      const { activationMaterializer: _materializer, ...profile } = definition();
      expect(() => proposeCompleteProfile(profile, [{ ...tests[0]!, expected }])).toThrow(
        "require allowed targets",
      );
      expect(
        proposeCompleteProfile({ ...profile, allowedTargets: ["/workspace"] }, tests).profile
          .allowedTargets,
      ).toEqual(["/workspace"]);
    },
  );

  test.each([
    { sessionContext: Array.from({ length: 257 }, () => "entry") },
    { allowedTargets: Array.from({ length: 257 }, () => "/workspace") },
    {
      activationMaterializer: { permissions, runtimeVersion: "2.8.1", source: "x".repeat(262145) },
    },
    { groupings: [{ id: "oversized", policies: { allow: "x".repeat(262145) } }] },
  ])("bounds authoring before materializer and Cedar validation", (change) => {
    expect(() => proposeCompleteProfile({ ...definition(), ...change }, tests)).toThrow(
      "authoring",
    );
  });

  test("bounds test count and nested test payloads", () => {
    expect(() =>
      proposeCompleteProfile(
        definition(),
        Array.from({ length: 257 }, () => tests[0]!),
      ),
    ).toThrow("256 entries");
    expect(() =>
      proposeCompleteProfile(definition(), [
        { ...tests[0]!, activationArguments: { payload: "x".repeat(262145) } },
      ]),
    ).toThrow("256 KiB");
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
