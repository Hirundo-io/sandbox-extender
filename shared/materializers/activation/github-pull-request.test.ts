import { describe, expect, test } from "bun:test";

import {
  materializeGitHubPullRequestActivation,
  runGitHubPullRequestActivationMaterializer,
} from "./github-pull-request.js";

describe("GitHub pull request activation materializer", () => {
  test("creates a canonical target", () => {
    expect(materializeGitHubPullRequestActivation({ pullRequest: 42, repository: "Acme/Example" }))
      .toBe("github:pull-request:acme/example#42");
  });

  test("writes the executable result and reports invalid input", async () => {
    const output: string[] = [];
    expect(await runGitHubPullRequestActivationMaterializer(
      Promise.resolve({ pullRequest: 42, repository: "acme/example" }), output.push.bind(output),
    )).toBe(true);
    expect(output).toEqual(['{"targets":["github:pull-request:acme/example#42"]}']);
    expect(await runGitHubPullRequestActivationMaterializer(Promise.resolve({}))).toBe(false);
  });

  test.each([
    undefined,
    null,
    {},
    { pullRequest: "42", repository: "acme/example" },
    { pullRequest: 42, repository: 1 },
    { pullRequest: 0, repository: "acme/example" },
    { pullRequest: 1.5, repository: "acme/example" },
    { pullRequest: 42, repository: "invalid" },
  ])("rejects invalid arguments %#", (candidate) => {
    expect(materializeGitHubPullRequestActivation(candidate)).toBeUndefined();
  });
});
