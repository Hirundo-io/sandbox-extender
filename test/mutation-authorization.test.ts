import { describe, expect, test } from "bun:test";

import { parseProfileMutationIntent } from "../src/mutation-authorization.js";

describe("profile mutation intent", () => {
  test("parses an exact promote request", () => {
    expect(
      parseProfileMutationIntent({
        arguments: {
          policyRevision: "0123456789abcdef0123456789abcdef01234567",
          profileId: "babysitter",
        },
        operation: "promote_profile",
      }),
    ).toEqual({
      arguments: {
        policyRevision: "0123456789abcdef0123456789abcdef01234567",
        profileId: "babysitter",
      },
      operation: "promote_profile",
    });
  });

  test("rejects malformed and extra arguments", () => {
    expect(() =>
      parseProfileMutationIntent({
        arguments: { profileId: "babysitter" },
        operation: "promote_profile",
      }),
    ).toThrow();
    expect(() =>
      parseProfileMutationIntent({ arguments: {}, operation: "disable_profile", unexpected: true }),
    ).toThrow();
  });

  test("parses a complete pending-review definition only", () => {
    expect(
      parseProfileMutationIntent({
        arguments: {
          profile: {
            allowedTargets: [],
            groupings: [
              { id: "allow", policies: { allow: "permit(principal, action, resource);" } },
            ],
            id: "maker",
            policyRevision: "pending-review",
          },
          tests: [
            {
              expected: "allow",
              name: "allows",
              request: { action: "codex.unified_exec", arguments: {}, resource: "/workspace" },
            },
          ],
        },
        operation: "propose_complete_profile",
      }),
    ).toMatchObject({ operation: "propose_complete_profile" });
    expect(() =>
      parseProfileMutationIntent({
        arguments: {
          profile: { allowedTargets: [], groupings: [], id: "maker", policyRevision: "reviewed" },
          tests: [],
        },
        operation: "propose_complete_profile",
      }),
    ).toThrow();
  });
});
