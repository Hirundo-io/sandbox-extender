import { describe, expect, test } from "bun:test";

import {
  materializeGitHubPullRequestActivation,
  runGh,
  runGitHubPullRequestActivationMaterializer,
} from "./github-pull-request.js";

function ghOutput(value: unknown, code = 0) {
  return { code, stdout: new TextEncoder().encode(JSON.stringify(value)) };
}

describe("GitHub pull request activation materializer", () => {
  test("creates a canonical target", () => {
    expect(materializeGitHubPullRequestActivation({ pullRequest: 42, repository: "Acme/Example" }))
      .toBe("github:pull-request:acme/example#42");
  });

  test("looks up the current pull request when the explicit target is omitted", () => {
    expect(materializeGitHubPullRequestActivation(
      { workingDirectory: "/workspace" },
      (workingDirectory) => {
        expect(workingDirectory).toBe("/workspace");
        return ghOutput({ number: 42, url: "https://github.com/Acme/Example/pull/42" });
      },
    )).toBe("github:pull-request:acme/example#42");
  });

  test("uses gh for an implicit current pull request", () => {
    const output = ghOutput({ number: 42, url: "https://github.com/acme/example/pull/42" });
    class Command {
      outputSync() {
        return output;
      }
    }
    expect(runGh("/workspace", Command)).toEqual(output);
  });

  test("fails closed when current pull request lookup fails", () => {
    for (const output of [
      ghOutput({}, 1),
      ghOutput({ number: 42, url: "https://evil.test/acme/example/pull/42" }),
      ghOutput({ number: 42, url: "https://github.com/acme/example/pull/43" }),
      { code: 0, stdout: new TextEncoder().encode("not json") },
    ]) {
      expect(materializeGitHubPullRequestActivation({ workingDirectory: "/workspace" }, () => output))
        .toBeUndefined();
    }
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
    { workingDirectory: "relative/workspace" },
    { pullRequest: 42, repository: "acme/example", workingDirectory: "/workspace" },
    { pullRequest: 42, workingDirectory: "/workspace" },
    { repository: "acme/example", workingDirectory: "/workspace" },
  ])("rejects invalid arguments %#", (candidate) => {
    expect(materializeGitHubPullRequestActivation(candidate)).toBeUndefined();
  });
});
