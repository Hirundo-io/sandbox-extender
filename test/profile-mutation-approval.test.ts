import { describe, expect, test } from "bun:test";
import type { ServerContext } from "@modelcontextprotocol/server";

import type { ProfileMutationIntent } from "../src/mutation-authorization.js";
import { requestProfileMutationApproval } from "../src/profile-mutation-approval.js";

const intent = {
  arguments: { arguments: { pullRequest: 42, repository: "acme/example" }, profileId: "babysitter" },
  operation: "activate_profile",
} as const satisfies ProfileMutationIntent;

const details = {
  activationArguments: intent.arguments.arguments,
  policyRevision: "0123456789abcdef0123456789abcdef01234567",
  profileId: "babysitter",
  targets: ["github:pull-request:acme/example#42"],
} as const;

function context(state?: unknown, inputResponses?: Record<string, unknown>): ServerContext {
  return { mcpReq: { id: 1, inputResponses, method: "tools/call", requestState: () => state } } as unknown as ServerContext;
}

describe("profile mutation approval", () => {
  test("returns a continuation approval containing every bound value", async () => {
    const result = await requestProfileMutationApproval("thread-1", intent, details, context());
    expect(result?.resultType).toBe("input_required");
    expect(result?.requestState).toStartWith("v1.");
    const approval = result?.inputRequests?.approval;
    expect(approval).toMatchObject({ method: "elicitation/create" });
    const message = (approval?.params as { message?: string } | undefined)?.message;
    expect(message).toContain("Operation: activate_profile");
    expect(message).toContain('Profile: babysitter');
    expect(message).toContain(`Policy Revision: ${details.policyRevision}`);
    expect(message).toContain('Targets: "github:pull-request:acme/example#42"');
  });

  test("accepts only a matching approved retry", async () => {
    await expect(requestProfileMutationApproval("thread-1", intent, details, context({ details, intent, threadId: "thread-1" }, {
      approval: { action: "accept", content: { approve: true } },
    }))).resolves.toBeUndefined();
  });

  test.each([
    { action: "decline" },
    { action: "cancel" },
    { action: "accept", content: { approve: false } },
    { action: "accept", content: { approve: "true" } },
  ])("fails closed on an unapproved retry: %#", async (approval) => {
    await expect(requestProfileMutationApproval("thread-1", intent, details, context({ details, intent, threadId: "thread-1" }, { approval }))).rejects.toThrow("not confirmed");
  });

  test("rejects a retry bound to another thread", async () => {
    await expect(requestProfileMutationApproval("thread-1", intent, details, context({ details, intent, threadId: "thread-2" }, {
      approval: { action: "accept", content: { approve: true } },
    }))).rejects.toThrow("does not match");
  });

  test("rejects approval values outside the JSON boundary", async () => {
    const invalidIntent = {
      arguments: { value: Number.NaN },
      operation: "activate_profile",
    } as unknown as ProfileMutationIntent;
    await expect(requestProfileMutationApproval("thread-1", invalidIntent, {}, context())).rejects.toThrow("only JSON values");
  });
});
