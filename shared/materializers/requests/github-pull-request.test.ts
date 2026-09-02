import { describe, expect, test } from "bun:test";

import {
  materializeGitHubPullRequest,
  reviewThreadCommentsQuery,
  reviewThreadsQuery,
  resolveReviewThreadMutation,
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
          "body=_Replying as Codex",
        ]),
        undefined,
        () => "github:pull-request:acme/example#42",
        () => true,
      ),
    ).toEqual({
      bodyPresent: true,
      operation: "github.review-comment.reply",
      resource: "github:pull-request:acme/example#42",
      trailingArgumentCount: 0,
      trailingArguments: [],
    });
  });

  test("materializes the fixed read-only review-thread query", () => {
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "graphql",
          "-f",
          `query=${reviewThreadsQuery}`,
          "-f",
          "owner=Acme",
          "-f",
          "repo=Example",
          "-F",
          "pr=42",
          "--paginate",
          "--slurp",
        ]),
        undefined,
        () => "github:pull-request:acme/example#42",
      ),
    ).toEqual({
      bodyPresent: false,
      operation: "github.pull-request.review-threads",
      resource: "github:pull-request:acme/example#42",
      trailingArgumentCount: 0,
      trailingArguments: [],
    });
  });

  test("materializes the documented GraphQL review reply only for a live pull-request thread", () => {
    const query = `mutation($thread:ID!, $body:String!) { addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread, body:$body}) { comment { url } } }`;
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "graphql",
          "-f",
          `query=${query}`,
          "-f",
          "thread=PRRT_current",
          "-f",
          "body=_Replying as Codex\n\nFixed.",
        ]),
        undefined,
        () => "github:pull-request:acme/example#42",
      ),
    ).toEqual(
      expect.objectContaining({
        operation: "github.review-thread.reply",
        resource: "github:pull-request:acme/example#42",
      }),
    );
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "graphql",
          "-f",
          `query=${query}`,
          "-f",
          "thread=PRRT_other",
          "-f",
          "body=_Replying as Codex\n\nFixed.",
        ]),
        undefined,
        () => undefined,
      ),
    ).toBeUndefined();
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "graphql",
          "-f",
          `query=${query}`,
          "-f",
          "thread=PRRT_current",
          "-f",
          "body=Fixed without attribution.",
        ]),
        undefined,
        () => "github:pull-request:acme/example#42",
      ),
    ).toBeUndefined();
  });

  test("requires exact read-query arguments and live thread ownership", () => {
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "graphql",
          "-f",
          `query=${reviewThreadsQuery}`,
          "-f",
          "owner=acme",
          "-f",
          "repo=example",
          "-F",
          "pr=42",
          "--paginate",
          "--slurp",
          "--input",
          "mutation.json",
        ]),
      ),
    ).toBeUndefined();
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "graphql",
          "-f",
          `query=${reviewThreadCommentsQuery}`,
          "-F",
          "id=PRRT_current",
          "--paginate",
          "--slurp",
        ]),
        undefined,
        () => "github:pull-request:acme/example#42",
      ),
    ).toEqual(expect.objectContaining({ operation: "github.review-thread.comments" }));
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "graphql",
          "-f",
          `query=${resolveReviewThreadMutation}`,
          "-F",
          "threadId=PRRT_current",
          "-f",
          "clientMutationTag=anything-at-all",
        ]),
        undefined,
        () => "github:pull-request:acme/example#42",
      ),
    ).toEqual(expect.objectContaining({ operation: "github.review-thread.resolve" }));
  });

  test("allows a parsed resolution mutation without clientMutationId", () => {
    const query = `mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { isResolved } } }`;
    expect(
      materializeGitHubPullRequest(
        candidate(["gh", "api", "graphql", "-f", `query=${query}`, "-f", "thread=PRRT_current"]),
        undefined,
        () => "github:pull-request:acme/example#42",
      ),
    ).toEqual(expect.objectContaining({ operation: "github.review-thread.resolve" }));
  });

  test("requires identified inline and file-backed replies", () => {
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "repos/acme/example/pulls/42/comments/9/replies",
          "-F",
          "body=@reply.md",
          "--jq",
          ".html_url",
        ]),
        (path) => (path === "reply.md" ? "_Replying as Codex\n\nDone." : ""),
        undefined,
        () => true,
      ),
    ).toEqual(expect.objectContaining({ operation: "github.review-comment.reply" }));
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "graphql",
          "-f",
          `query=${resolveReviewThreadMutation}`,
          "-F",
          "threadId=PRRT_kwDOUC1vvc6d0Nov",
          "-f",
          "clientMutationTag=acme/example#42",
        ]),
        undefined,
        () => "github:pull-request:acme/example#42",
      ),
    ).toEqual(
      expect.objectContaining({
        operation: "github.review-thread.resolve",
        resource: "github:pull-request:acme/example#42",
      }),
    );
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "repos/acme/example/pulls/42/comments/9/replies",
          "-f",
          "body=Done.",
        ]),
        undefined,
        undefined,
        () => true,
      ),
    ).toBeUndefined();
  });

  test("fails closed on unreadable replies and invalid review-thread targets", () => {
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "repos/invalid@owner/example/pulls/42/comments/9/replies",
          "-f",
          "body=_Replying as Codex",
        ]),
        undefined,
        undefined,
        () => true,
      ),
    ).toBeUndefined();
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "repos/acme/example/pulls/42/comments/9/replies",
          "-F",
          "body=@reply.md",
        ]),
        () => {
          throw new Error("unreadable");
        },
      ),
    ).toBeUndefined();
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "repos/acme/example/pulls/42/comments/9/replies",
          "-F",
          "body=@missing-reply.md",
        ]),
      ),
    ).toBeUndefined();
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "repos/acme/example/pulls/42/comments/9/replies",
          "-f",
          "body=_Replying as Codex",
        ]),
        undefined,
        undefined,
        () => true,
      ),
    ).toEqual(expect.objectContaining({ operation: "github.review-comment.reply" }));
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "graphql",
          "-f",
          `query=${resolveReviewThreadMutation}`,
          "-F",
          "threadId=PRRT_kwDOUC1vvc6d0Nov",
          "-f",
          "clientMutationTag=invalid",
        ]),
      ),
    ).toBeUndefined();
  });

  test("materializes GraphQL resolution batches without variable-name conventions", () => {
    const query = `mutation($first: ID!, $second: ID!) { one: resolveReviewThread(input: { threadId: $first, clientMutationId: "acme/example#42" }) { thread { id } } two: resolveReviewThread(input: { threadId: $second, clientMutationId: "acme/example#42" }) { thread { id } } }`;
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "graphql",
          "-f",
          `query=${query}`,
          "-f",
          "first=PRRT_one",
          "-f",
          "second=PRRT_two",
        ]),
        undefined,
        () => "github:pull-request:acme/example#42",
      ),
    ).toEqual(
      expect.objectContaining({
        operation: "github.review-thread.resolve",
        resource: "github:pull-request:acme/example#42",
      }),
    );
  });

  test("rejects malformed batch resolution GraphQL", () => {
    expect(
      materializeGitHubPullRequest(
        candidate(["gh", "api", "graphql", "-f", "query=mutation(", "-f", "thread=PRRT_one"]),
      ),
    ).toBeUndefined();
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
      "graphql",
      "-f",
      "query=mutation { closeIssue(input: {}) { issue { id } } }",
    ]),
    candidate([
      "gh",
      "api",
      "graphql",
      "-f",
      "query=query { viewer { login } }",
      "-F",
      "owner=acme",
      "-F",
      "name=example",
      "-F",
      "number=42",
    ]),
    candidate([
      "gh",
      "api",
      "graphql",
      "-f",
      `query=${reviewThreadsQuery}`,
      "-f",
      "owner=acme",
      "-f",
      "repo=example",
      "-F",
      "pr=042",
      "--paginate",
      "--slurp",
    ]),
    candidate([
      "gh",
      "api",
      "graphql",
      "-f",
      `query=${reviewThreadsQuery}`,
      "-f",
      "owner=acme",
      "-f",
      "repo=example",
      "-F",
      "pr42",
      "--paginate",
      "--slurp",
    ]),
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
