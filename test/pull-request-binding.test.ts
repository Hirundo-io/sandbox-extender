import { describe, expect, test } from "bun:test";

import {
  materializePullRequestProfile,
  resolvePullRequestBinding,
  type PullRequestCommandRunner,
} from "../src/index.js";

const workspace = "/work/example";
const targetPlaceholder = 'Target::"__SANDBOX_EXTENDER_PULL_REQUEST_TARGET__"';

function runner(responses: Readonly<Record<string, string | undefined>>): PullRequestCommandRunner {
  return (command) => responses[command.join(" ")];
}

function profile(pullRequest = "acme/example#42") {
  return {
    allowedTargets: [],
    groupings: [{
      id: "pull-request",
      policies: {
        allow: `permit(principal, action, resource == ${targetPlaceholder});`,
      },
    }],
    pullRequestBinding: { pullRequest, workspace },
    targetResolver: {
      file: "resolvers/github-pull-request.ts",
      language: "typescript" as const,
    },
    targetScope: "single" as const,
  };
}

describe("pull-request bindings", () => {
  test("defaults to the active PR for the declared workspace", () => {
    const resolved = resolvePullRequestBinding(
      { workspace },
      runner({
        "git rev-parse --show-toplevel": workspace,
        "gh pr view --json url": JSON.stringify({ url: "https://github.com/Acme/Example/pull/42" }),
      }),
    );

    expect(resolved).toBe("github:pull-request:acme/example#42");
  });

  test("uses a numeric override in the workspace repository", () => {
    const resolved = resolvePullRequestBinding(
      { workspace, pullRequest: "42" },
      runner({
        "git rev-parse --show-toplevel": workspace,
        "gh repo view --json nameWithOwner": JSON.stringify({ nameWithOwner: "Acme/Example" }),
        "gh pr view 42 --repo Acme/Example --json url": JSON.stringify({ url: "https://github.com/Acme/Example/pull/42" }),
      }),
    );

    expect(resolved).toBe("github:pull-request:acme/example#42");
  });

  test("uses an explicit repository override", () => {
    const resolved = resolvePullRequestBinding(
      { workspace, pullRequest: "Other/Repository#99" },
      runner({
        "git rev-parse --show-toplevel": workspace,
        "gh pr view 99 --repo Other/Repository --json url": JSON.stringify({ url: "https://github.com/Other/Repository/pull/99" }),
      }),
    );

    expect(resolved).toBe("github:pull-request:other/repository#99");
  });

  test("fails closed when GitHub resolves another pull request", () => {
    expect(resolvePullRequestBinding(
      { workspace, pullRequest: "42" },
      runner({
        "git rev-parse --show-toplevel": workspace,
        "gh repo view --json nameWithOwner": JSON.stringify({ nameWithOwner: "acme/example" }),
        "gh pr view 42 --repo acme/example --json url": JSON.stringify({ url: "https://github.com/acme/example/pull/43" }),
      }),
    )).toBeUndefined();
  });

  test("materializes and removes the reviewed binding instead of following the branch later", () => {
    const materialized = materializePullRequestProfile(profile(), runner({
      "git rev-parse --show-toplevel": workspace,
      "gh pr view 42 --repo acme/example --json url": JSON.stringify({ url: "https://github.com/acme/example/pull/42" }),
    }));

    expect(materialized.allowedTargets).toEqual(["github:pull-request:acme/example#42"]);
    expect(materialized.groupings[0]?.policies.allow).toContain(
      'Target::"github:pull-request:acme/example#42"',
    );
    expect(JSON.stringify(materialized)).not.toContain("pullRequestBinding");
  });

  test("rejects a bound profile without a Cedar target placeholder", () => {
    const withoutPlaceholder = profile();
    withoutPlaceholder.groupings[0]!.policies.allow = "permit(principal, action, resource);";
    expect(() => materializePullRequestProfile(withoutPlaceholder, runner({
      "git rev-parse --show-toplevel": workspace,
      "gh pr view 42 --repo acme/example --json url": JSON.stringify({ url: "https://github.com/acme/example/pull/42" }),
    }))).toThrow("target placeholder");
  });

  test("rejects materialization whose target identity is not fully present in the review", () => {
    expect(() => materializePullRequestProfile(profile("42"), runner({
      "git rev-parse --show-toplevel": workspace,
      "gh repo view --json nameWithOwner": JSON.stringify({ nameWithOwner: "acme/example" }),
      "gh pr view 42 --repo acme/example --json url": JSON.stringify({ url: "https://github.com/acme/example/pull/42" }),
    }))).toThrow("reviewed owner/repository#number target");
  });
});
