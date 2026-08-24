import { describe, expect, test } from "bun:test";

import { PolicyCore, type NormalizedRequest, type Profile } from "../src/index.js";

const request: NormalizedRequest = {
  action: "github.pr.comment.create",
  arguments: { body: "Reviewed." },
  resource: "github:pull-request:Hirundo-io/example#42",
  threadId: "codex-thread-1",
};

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    allowedTargets: new Set([request.resource]),
    groupings: [],
    id: "review-current-pr",
    policyRevision: "4f9e7a1",
    ...overrides,
  };
}

describe("PolicyCore", () => {
  test("abstains without an active profile", () => {
    expect(new PolicyCore().evaluate(request)).toEqual({
      decision: "abstain",
      reason: "no active profile for thread",
    });
  });

  test("validates token lifetime and can disable an active profile", () => {
    expect(() => new PolicyCore(0)).toThrow("positive safe integer");
    const core = new PolicyCore();
    core.activate(profile(), request.threadId);
    core.disable(request.threadId);
    expect(core.evaluate(request).decision).toBe("abstain");
  });

  test("abstains when the resolved target is outside the profile scope", () => {
    const core = new PolicyCore();
    core.activate(profile({ allowedTargets: new Set() }), request.threadId);

    expect(core.evaluate(request)).toEqual({
      decision: "abstain",
      reason: "resolved target is outside the allowed target set",
    });
  });

  test("uses the first decisive grouping and issues a one-time token", () => {
    const core = new PolicyCore();
    core.activate(
      profile({
        groupings: [
          { id: "not-applicable", evaluate: () => "abstain" },
          { id: "allow-comment", evaluate: () => "allow" },
          { id: "later-deny", evaluate: () => "deny" },
        ],
      }),
      request.threadId,
    );

    const result = core.evaluate(request);

    expect(result.decision).toBe("allow");
    expect(result.matchedGroupingId).toBe("allow-comment");
    expect(result.token).toBeDefined();
    expect(core.consumeToken(result.token!.id, request)).toBe(true);
    expect(core.consumeToken(result.token!.id, request)).toBe(false);
  });

  test("does not allow a token to authorize a different request", () => {
    const core = new PolicyCore();
    core.activate(
      profile({ groupings: [{ id: "allow-comment", evaluate: () => "allow" }] }),
      request.threadId,
    );

    const result = core.evaluate(request);
    const differentRequest = { ...request, arguments: { body: "Different." } };

    expect(core.consumeToken(result.token!.id, differentRequest)).toBe(false);
  });

  test("evaluates Cedar policies and abstains when none match", () => {
    const core = new PolicyCore();
    core.activate(
      profile({
        groupings: [
          {
            id: "comment-only",
            policies: {
              permitComment:
                'permit(principal, action == Action::"github.pr.comment.create", resource);',
            },
          },
        ],
      }),
      request.threadId,
    );

    expect(core.evaluate(request).decision).toBe("allow");
    expect(
      core.evaluate({ ...request, action: "github.pr.close" }).decision,
    ).toBe("abstain");
  });
});
