import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { getActiveProfileHandler, listProfilesHandler } from "../src/mcp-read-handlers.js";
import { ProfileStaleError, PolicyRepository } from "../src/policy-repository.js";
import type { Profile } from "../src/types.js";

const threadId = "host-thread";

function profile(): Profile {
  return {
    allowedTargets: new Set(["github:pull-request:acme/example#42"]),
    groupings: [{ id: "allow", policies: { allow: "permit(principal, action, resource);" } }],
    id: "review",
    policyRevision: "a".repeat(40),
  };
}

function fingerprint(value: Profile): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        allowedTargets: [...value.allowedTargets].sort(),
        groupings: value.groupings,
        id: value.id,
        policyRevision: value.policyRevision,
        sessionContext: value.sessionContext ?? [],
        singleCommand: value.singleCommand,
        targetScope: value.targetScope,
        activationMaterializer: value.activationMaterializer,
        requestMaterializer: value.requestMaterializer,
      }),
    )
    .digest("hex");
}

function repositoryFor(
  state: Record<string, unknown>,
  loadVerifiedProfile: () => Promise<Profile>,
): PolicyRepository {
  return {
    appendAudit: async () => {
      throw new Error("read-only handler must not append audit records");
    },
    loadVerifiedProfile,
    readState: async () => state,
    updateState: async () => {
      throw new Error("read-only handler must not update state");
    },
  } as unknown as PolicyRepository;
}

describe("MCP read handlers", () => {
  test("serializes list and active-profile statuses without mutating the repository", async () => {
    const reviewed = profile();
    const binding = {
      allowedTargets: [...reviewed.allowedTargets],
      fingerprint: fingerprint(reviewed),
      policyRevision: reviewed.policyRevision,
      profileId: reviewed.id,
    };
    const activeRepository = repositoryFor({ [threadId]: binding }, async () => reviewed);
    const inactiveRepository = repositoryFor({}, async () => reviewed);
    const staleRepository = repositoryFor({ [threadId]: binding }, async () => {
      throw new ProfileStaleError("profile changed");
    });
    const unavailableRepository = {
      readState: async () => {
        throw new Error("repository unavailable");
      },
    } as unknown as PolicyRepository;
    const listRepository = {
      listVerifiedProfiles: async () => ["review"],
    } as unknown as PolicyRepository;

    await expect(listProfilesHandler(listRepository)).resolves.toEqual({
      content: [{ text: '["review"]', type: "text" }],
    });
    await expect(getActiveProfileHandler(activeRepository, threadId)).resolves.toEqual({
      content: [
        {
          text: `{"status":"active","profileId":"review","policyRevision":"${reviewed.policyRevision}","allowedTargets":["github:pull-request:acme/example#42"]}`,
          type: "text",
        },
      ],
    });
    await expect(getActiveProfileHandler(inactiveRepository, threadId)).resolves.toEqual({
      content: [
        { text: '{"status":"inactive","reason":"no active profile for thread"}', type: "text" },
      ],
    });
    await expect(getActiveProfileHandler(staleRepository, threadId)).resolves.toEqual({
      content: [
        {
          text: `{"status":"stale","profileId":"review","policyRevision":"${reviewed.policyRevision}","allowedTargets":["github:pull-request:acme/example#42"],"reason":"active profile no longer matches review"}`,
          type: "text",
        },
      ],
    });
    await expect(getActiveProfileHandler(unavailableRepository, threadId)).resolves.toEqual({
      content: [
        {
          text: '{"status":"unavailable","reason":"policy repository is unavailable"}',
          type: "text",
        },
      ],
    });
  });

  test("propagates listing verification failures without writing repository state", async () => {
    let writes = 0;
    const repository = {
      appendAudit: async () => {
        writes += 1;
      },
      listVerifiedProfiles: async () => {
        throw new Error("Git repository is unavailable");
      },
      updateState: async () => {
        writes += 1;
      },
    } as unknown as PolicyRepository;

    await expect(listProfilesHandler(repository)).rejects.toThrow("Git repository is unavailable");
    expect(writes).toBe(0);
  });
});
