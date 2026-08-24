import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PolicyRepository } from "../src/policy-repository.js";
import { activateProfile, disableProfile, evaluateForThread } from "../src/policy-service.js";

const request = {
  action: "codex.unified_exec",
  arguments: { command: "gh pr diff 42" },
  resource: "/work/example",
  threadId: "thread-1",
};

async function createRepository(): Promise<{ repository: PolicyRepository; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "sandbox-extender-service-"));
  return { repository: new PolicyRepository(root), root };
}

async function writeProfile(root: string, id: string, policyRevision: string): Promise<void> {
  await mkdir(join(root, "profiles"), { recursive: true });
  await Bun.write(join(root, "profiles", `${id}.json`), JSON.stringify({
    allowedTargets: [request.resource],
    groupings: [{ id: "allow", policies: { allow: "permit(principal, action, resource);" } }],
    id,
    policyRevision,
  }));
}

describe("policy service", () => {
  test("records inactive requests and fails closed for missing profile files", async () => {
    const { repository, root } = await createRepository();
    try {
      expect(await evaluateForThread(repository, request)).toEqual({
        decision: "abstain",
        reason: "no active profile for thread",
      });
      expect(await readFile(join(root, "audit.yaml"), "utf8")).toContain("extension-request");

      await repository.writeState({ [request.threadId]: "missing" });
      expect(await evaluateForThread(repository, request)).toEqual({
        decision: "abstain",
        reason: "policy repository is unavailable",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("requires review before activation and removes the thread binding on disable", async () => {
    const { repository, root } = await createRepository();
    try {
      await writeProfile(root, "pending", "pending-review");
      await expect(activateProfile(repository, request.threadId, "pending")).rejects.toThrow("reviewed");

      await writeProfile(root, "reviewed", "revision-1");
      await activateProfile(repository, request.threadId, "reviewed");
      expect((await evaluateForThread(repository, request)).decision).toBe("allow");
      await disableProfile(repository, request.threadId);
      expect(await repository.readState()).toEqual({});
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
