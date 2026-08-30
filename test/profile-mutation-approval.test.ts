import { describe, expect, test } from "bun:test";
import type { ServerContext } from "@modelcontextprotocol/server";

import { requestProfileMutationApproval } from "../src/profile-mutation-approval.js";
import type { ProfileMutationIntent } from "../src/mutation-authorization.js";

const activationIntent = {
  arguments: {
    arguments: { pullRequest: 42, repository: "acme/example" },
    profileId: "babysitter",
  },
  operation: "activate_profile",
} as const satisfies ProfileMutationIntent;

const details = {
  activationArguments: activationIntent.arguments.arguments,
  policyRevision: "0123456789abcdef0123456789abcdef01234567",
  profileId: "babysitter",
  targets: ["github:pull-request:acme/example#42"],
} as const;

function context(
  state?: unknown,
  inputResponses?: Record<string, unknown>,
): ServerContext {
  return {
    mcpReq: {
      id: 1,
      inputResponses,
      method: "tools/call",
      requestState: () => state,
    },
  } as unknown as ServerContext;
}

function missingFallback(): Promise<void> {
  return Promise.reject(new Error("a user mutation authorization is required"));
}

describe("Profile mutation approval", () => {
  test("returns a modern input_required approval with every bound value", async () => {
    const result = await requestProfileMutationApproval("/policy", "thread-1", activationIntent, details, context(), {
      consumeFallback: missingFallback,
    });

    expect(result?.resultType).toBe("input_required");
    expect(result?.requestState).toStartWith("v1.");
    const approval = result?.inputRequests?.approval;
    expect(approval).toMatchObject({ method: "elicitation/create" });
    const message = (approval?.params as { message?: string } | undefined)?.message;
    expect(message).toContain("Operation: activate_profile");
    expect(message).toContain(
      'Operation Arguments: {"arguments":{"pullRequest":42,"repository":"acme/example"},"profileId":"babysitter"}',
    );
    expect(message).toContain("Profile: babysitter");
    expect(message).toContain(`Policy Revision: ${details.policyRevision}`);
    expect(message).toContain(
      'Activation Arguments: {"pullRequest":42,"repository":"acme/example"}',
    );
    expect(message).toContain('Targets: "github:pull-request:acme/example#42"');
  });

  test("accepts a retry only when the sealed state and confirmation both match", async () => {
    await expect(requestProfileMutationApproval("/policy", "thread-1", activationIntent, details, context({
      details,
      intent: activationIntent,
      threadId: "thread-1",
    }, {
      approval: { action: "accept", content: { approve: true } },
    }), { consumeFallback: missingFallback })).resolves.toBeUndefined();
  });

  test.each([
    { action: "decline" },
    { action: "cancel" },
    { action: "accept", content: { approve: false } },
    { action: "accept", content: { approve: "true" } },
    { action: "accept", content: { approve: true, extra: true } },
  ])("fails closed on a rejected or malformed retry: %#", async (approval) => {
    await expect(requestProfileMutationApproval("/policy", "thread-1", activationIntent, details, context({
      details,
      intent: activationIntent,
      threadId: "thread-1",
    }, { approval }), { consumeFallback: missingFallback })).rejects.toThrow("not confirmed");
  });

  test("rejects a retry whose sealed intent is bound to another thread", async () => {
    await expect(requestProfileMutationApproval("/policy", "thread-1", activationIntent, details, context({
      details,
      intent: activationIntent,
      threadId: "thread-2",
    }, {
      approval: { action: "accept", content: { approve: true } },
    }), { consumeFallback: missingFallback })).rejects.toThrow("does not match");
  });

  test("consumes the short-lived CLI authorization only on a retry without MCP state", async () => {
    const fallbackCalls: unknown[][] = [];
    await expect(requestProfileMutationApproval("/policy", "thread-1", activationIntent, details, context(), {
      consumeFallback: async (...arguments_: Parameters<typeof missingFallback>) => {
        fallbackCalls.push(arguments_);
      },
    })).resolves.toBeUndefined();
    expect(fallbackCalls).toHaveLength(1);
  });

  test("does not hide a malformed or expired CLI authorization behind a new approval request", async () => {
    await expect(requestProfileMutationApproval("/policy", "thread-1", activationIntent, details, context(), {
      consumeFallback: async () => {
        throw new Error("mutation authorization has expired");
      },
    })).rejects.toThrow("expired");
  });
});
