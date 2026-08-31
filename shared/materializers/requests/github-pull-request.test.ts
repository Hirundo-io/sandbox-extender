import { describe, expect, test } from "bun:test";

import {
  materializeGitHubPullRequest,
  runGitHubPullRequestMaterializer,
} from "./github-pull-request.js";

function candidate(words: unknown): unknown {
  return { command: { words } };
}

describe("GitHub pull request request materializer", () => {
  test("materializes pull request operations", () => {
    expect(
      materializeGitHubPullRequest(
        candidate(["gh", "pr", "view", "42", "--repo", "Acme/Example", "--json", "url"]),
      ),
    ).toEqual({
      bodyPresent: false,
      operation: "github.pull-request.view",
      resource: "github:pull-request:acme/example#42",
      trailingArgumentCount: 2,
      trailingArguments: ["--json", "url"],
    });
    expect(
      materializeGitHubPullRequest(
        candidate(["gh", "pr", "comment", "42", "--repo", "acme/example", "--body", "done"]),
      ),
    ).toEqual(
      expect.objectContaining({ bodyPresent: true, operation: "github.pull-request.comment" }),
    );
  });

  test("materializes REST review replies", () => {
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "--method",
          "POST",
          "repos/acme/example/pulls/42/comments/9/replies",
          "-f",
          "body=done",
        ]),
      ),
    ).toEqual({
      bodyPresent: true,
      operation: "github.review-comment.reply",
      resource: "github:pull-request:acme/example#42",
      trailingArgumentCount: 0,
      trailingArguments: [],
    });
  });

  test("writes the executable result and reports invalid input", async () => {
    const output: string[] = [];
    expect(
      await runGitHubPullRequestMaterializer(
        Promise.resolve(candidate(["gh", "pr", "view", "42", "--repo", "acme/example"])),
        output.push.bind(output),
      ),
    ).toBe(true);
    expect(JSON.parse(output[0]!)).toEqual(
      expect.objectContaining({ resource: "github:pull-request:acme/example#42" }),
    );
    expect(await runGitHubPullRequestMaterializer(Promise.resolve({}))).toBe(false);
  });

  test.each([
    undefined,
    null,
    {},
    { command: null },
    candidate("words"),
    candidate(["gh", 1]),
    candidate(["git", "pr", "view", "42", "--repo", "acme/example"]),
    candidate(["gh", "pr"]),
    candidate(["gh", "pr", "view", "0", "--repo", "acme/example"]),
    candidate(["gh", "pr", "view", "42", "--repo", "invalid"]),
    candidate([
      "gh",
      "api",
      "--method",
      "GET",
      "repos/acme/example/pulls/42/comments/9/replies",
      "-f",
      "body=x",
    ]),
    candidate(["gh", "api", "--method", "POST", "invalid", "-f", "body=x"]),
    candidate([
      "gh",
      "api",
      "--method",
      "POST",
      "repos/acme/example/pulls/42/comments/9/replies",
      "-f",
    ]),
  ])("rejects unsupported input %#", (value) =>
    expect(materializeGitHubPullRequest(value)).toBeUndefined(),
  );
});
