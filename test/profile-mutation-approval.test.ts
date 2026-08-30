import { describe, expect, test } from "bun:test";
import type { ServerContext } from "@modelcontextprotocol/server";

import type { ProfileMutationIntent } from "../src/mutation-authorization.js";
import { approvalNonceFor, requestProfileMutationApproval } from "../src/profile-mutation-approval.js";

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
  test("reads the approval nonce only from verified continuation state", () => {
    expect(approvalNonceFor(context())).toBeUndefined();
    expect(approvalNonceFor(context({ details, intent, nonce: "continuation-nonce", threadId: "thread-1" }))).toBe("continuation-nonce");
  });

  test("returns a continuation approval containing every bound value", async () => {
    const result = await requestProfileMutationApproval("thread-1", intent, details, context());
    expect(result.approval?.resultType).toBe("input_required");
    expect(result.approval?.requestState).toStartWith("v1.");
    const approval = result.approval?.inputRequests?.approval;
    expect(approval).toMatchObject({ method: "elicitation/create" });
    const message = (approval?.params as { message?: string } | undefined)?.message;
    expect(message).toContain("Target Thread: thread-1");
    expect(message).toContain("Operation: activate_profile");
    expect(message).toContain('Profile: babysitter');
    expect(message).toContain(`Policy Revision: ${details.policyRevision}`);
    expect(message).toContain('Targets: "github:pull-request:acme/example#42"');
  });

  test("accepts only a matching approved retry", async () => {
    await expect(requestProfileMutationApproval("thread-1", intent, details, context({ details, intent, nonce: "matching-approved-retry", threadId: "thread-1" }, {
      approval: { action: "accept", content: { approve: true } },
    }))).resolves.toEqual({ nonce: "matching-approved-retry" });
  });

  test.each([
    { action: "decline" },
    { action: "cancel" },
    { action: "accept", content: { approve: false } },
    { action: "accept", content: { approve: "true" } },
  ])("fails closed on an unapproved retry: %#", async (approval) => {
    await expect(requestProfileMutationApproval("thread-1", intent, details, context({ details, intent, nonce: `unapproved-${approval.action}-${String(approval.content?.approve)}`, threadId: "thread-1" }, { approval }))).rejects.toThrow("not confirmed");
  });

  test("rejects a retry bound to another thread", async () => {
    await expect(requestProfileMutationApproval("thread-1", intent, details, context({ details, intent, nonce: "another-thread", threadId: "thread-2" }, {
      approval: { action: "accept", content: { approve: true } },
    }))).rejects.toThrow("does not match");
  });

  test.each([Number.NaN, new Date(), new Map(), new Set()])("rejects approval values outside the JSON boundary: %#", async (value) => {
    const invalidIntent = { arguments: { value }, operation: "activate_profile" } as unknown as ProfileMutationIntent;
    await expect(requestProfileMutationApproval("thread-1", invalidIntent, {}, context())).rejects.toThrow("only JSON values");
  });

  test("rejects a replayed approved continuation", async () => {
    const replayContext = context({ details, intent, nonce: "replayed-continuation", threadId: "thread-1" }, {
      approval: { action: "accept", content: { approve: true } },
    });
    await expect(requestProfileMutationApproval("thread-1", intent, details, replayContext)).resolves.toEqual({ nonce: "replayed-continuation" });
    await expect(requestProfileMutationApproval("thread-1", intent, details, replayContext)).rejects.toThrow("already been used");
  });
});
