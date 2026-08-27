import { describe, expect, test } from "bun:test";

import { materializeGitHubCurrentPullRequest } from "./github-current-pull-request.js";

function output(value: unknown, code = 0) {
  return { code, stdout: new TextEncoder().encode(JSON.stringify(value)) };
}

describe("current GitHub pull request Context Lookup", () => {
  test("derives one target from reviewed gh output", () => {
    expect(materializeGitHubCurrentPullRequest(
      { workingDirectory: "/workspace" },
      (workingDirectory) => {
        expect(workingDirectory).toBe("/workspace");
        return output({ number: 42, url: "https://github.com/Acme/Example/pull/42" });
      },
    )).toEqual({
      context: { lookup: "gh.pr.view", number: 42, url: "https://github.com/Acme/Example/pull/42" },
      resource: "github:pull-request:acme/example#42",
    });
  });

  test.each([
    [{}, output({ number: 42, url: "https://github.com/acme/example/pull/42" })],
    [{ workingDirectory: "/workspace" }, output({}, 1)],
    [{ workingDirectory: "/workspace" }, output({ number: 42, url: "https://evil.test/acme/example/pull/42" })],
    [{ workingDirectory: "/workspace" }, output({ number: 42, url: "https://github.com/acme/example/pull/43" })],
  ])("fails closed for invalid input or gh output %#", (candidate, commandOutput) => {
    expect(materializeGitHubCurrentPullRequest(candidate, () => commandOutput)).toBeUndefined();
  });
});
