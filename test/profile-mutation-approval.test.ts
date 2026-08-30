import { describe, expect, test } from "bun:test";
import { ErrorCode, McpError, type ElicitRequestFormParams, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";

import { approveProfileMutation } from "../src/profile-mutation-approval.js";
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

function response(action: ElicitResult["action"], approve?: boolean): ElicitResult {
  return { action, ...(approve === undefined ? {} : { content: { approve } }) };
}

function elicitor(
  result: ElicitResult | Error,
  requests: ElicitRequestFormParams[],
): (request: ElicitRequestFormParams) => Promise<ElicitResult> {
  return async (request) => {
    requests.push(request);
    if (result instanceof Error) throw result;
    return result;
  };
}

describe("Profile mutation Approval", () => {
  test("accepts only an explicit host confirmation and presents every bound value", async () => {
    const requests: ElicitRequestFormParams[] = [];
    await expect(approveProfileMutation("/policy", "thread-1", activationIntent, details, {
      elicit: elicitor(response("accept", true), requests),
      consumeFallback: async () => {
        throw new Error("fallback must not run");
      },
    })).resolves.toBeUndefined();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.message).toContain("Operation: activate_profile");
    expect(requests[0]?.message).toContain(
      'Operation Arguments: {"arguments":{"pullRequest":42,"repository":"acme/example"},"profileId":"babysitter"}',
    );
    expect(requests[0]?.message).toContain("Profile: babysitter");
    expect(requests[0]?.message).toContain(`Policy Revision: ${details.policyRevision}`);
    expect(requests[0]?.message).toContain(
      'Activation Arguments: {"pullRequest":42,"repository":"acme/example"}',
    );
    expect(requests[0]?.message).toContain('Targets: "github:pull-request:acme/example#42"');
  });

  test.each(["decline", "cancel"] as const)("does not mutate after %s", async (action) => {
    const requests: ElicitRequestFormParams[] = [];
    await expect(approveProfileMutation("/policy", "thread-1", activationIntent, details, {
      elicit: elicitor(response(action), requests),
    })).rejects.toThrow(`approval ${action}`);
  });

  test("rejects accept without the bound confirmation field", async () => {
    const requests: ElicitRequestFormParams[] = [];
    await expect(approveProfileMutation("/policy", "thread-1", activationIntent, details, {
      elicit: elicitor(response("accept", false), requests),
    })).rejects.toThrow("not confirmed");
  });

  test.each([
    new Error("Client does not support form elicitation."),
    new McpError(ErrorCode.MethodNotFound, "elicitation unavailable"),
    new McpError(ErrorCode.InvalidParams, "form mode is not supported by this client"),
  ])("uses the CLI authorization only when elicitation is unsupported", async (unsupportedError) => {
    const requests: ElicitRequestFormParams[] = [];
    const fallbackCalls: unknown[][] = [];
    await expect(approveProfileMutation("/policy", "thread-1", activationIntent, details, {
      elicit: elicitor(unsupportedError, requests),
      consumeFallback: async (...arguments_) => {
        fallbackCalls.push(arguments_);
      },
    })).resolves.toBeUndefined();
    expect(fallbackCalls).toEqual([["/policy", "thread-1", activationIntent]]);
  });

  test("fails without consuming a CLI authorization when elicitation itself fails", async () => {
    const requests: ElicitRequestFormParams[] = [];
    let fallbackCalled = false;
    await expect(approveProfileMutation("/policy", "thread-1", activationIntent, details, {
      elicit: elicitor(new Error("transport disconnected"), requests),
      consumeFallback: async () => {
        fallbackCalled = true;
      },
    })).rejects.toThrow("transport disconnected");
    expect(fallbackCalled).toBeFalse();
  });

  test("does not treat unrelated invalid parameters as unsupported form elicitation", async () => {
    const requests: ElicitRequestFormParams[] = [];
    let fallbackCalled = false;
    await expect(approveProfileMutation("/policy", "thread-1", activationIntent, details, {
      elicit: elicitor(new McpError(ErrorCode.InvalidParams, "requestedSchema is invalid"), requests),
      consumeFallback: async () => {
        fallbackCalled = true;
      },
    })).rejects.toThrow("requestedSchema is invalid");
    expect(fallbackCalled).toBeFalse();
  });

  test("escapes target newlines in the approval message", async () => {
    const requests: ElicitRequestFormParams[] = [];
    await approveProfileMutation("/policy", "thread-1", activationIntent, {
      ...details,
      targets: ["trusted\nPolicy Revision: spoofed"],
    }, { elicit: elicitor(response("accept", true), requests) });
    expect(requests[0]?.message).toContain('Targets: "trusted\\nPolicy Revision: spoofed"');
    expect(requests[0]?.message).not.toContain("Targets: trusted\nPolicy Revision: spoofed");
  });

  test("rejects non-JSON approval arguments", async () => {
    const invalidIntent = {
      arguments: { value: 1n },
      operation: "activate_profile",
    } as unknown as ProfileMutationIntent;
    await expect(approveProfileMutation("/policy", "thread-1", invalidIntent, {}, {
      elicit: async () => response("accept", true),
    })).rejects.toThrow("only JSON values");
  });
});
