import { describe, expect, test } from "bun:test";

import { evaluateCedarGrouping } from "../src/cedar.js";

const context = {
  policyRevision: "test",
  profileId: "test-profile",
  request: {
    action: "codex.unified_exec",
    arguments: { command: "gh pr diff 42", nested: { values: [1, true] } },
    resource: "/work/example",
    threadId: "thread-1",
  },
  resolvedTarget: "/work/example",
};

describe("Cedar grouping evaluation", () => {
  test("allows matching Cedar policies with JSON arguments", () => {
    expect(evaluateCedarGrouping({
      id: "allow-pr-diff",
      policies: {
        allow: 'permit(principal, action == Action::"codex.unified_exec", resource) when { context.arguments.command like "gh pr diff*" };',
      },
    }, context)).toBe("allow");
  });

  test("abstains when no policy matches or policy syntax is invalid", () => {
    expect(evaluateCedarGrouping({
      id: "no-match",
      policies: { allow: 'permit(principal, action == Action::"codex.unified_exec", resource) when { context.arguments.command like "gh pr view*" };' },
    }, context)).toBe("abstain");
    expect(evaluateCedarGrouping({ id: "invalid", policies: { invalid: "not Cedar" } }, context)).toBe("abstain");
  });

  test("returns deny for an explicit forbid", () => {
    expect(evaluateCedarGrouping({
      id: "deny",
      policies: { deny: 'forbid(principal, action, resource);' },
    }, context)).toBe("deny");
  });

  test("abstains when request arguments are not JSON values", () => {
    expect(evaluateCedarGrouping({
      id: "invalid-arguments",
      policies: { allow: "permit(principal, action, resource);" },
    }, {
      ...context,
      request: { ...context.request, arguments: { callback: () => undefined } },
    })).toBe("abstain");
  });
});
