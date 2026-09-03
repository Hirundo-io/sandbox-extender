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

function repeatedCandidate(words: unknown): unknown {
  return { command: { repetition: "potentially-unbounded", words } };
}

function currentPullRequest(repository = "Hirundo-io/hirundo-platform", number = 513) {
  return {
    headBranch: "feature",
    headSha: "a".repeat(40),
    resource: `github:pull-request:${repository.toLowerCase()}#${number}`,
  };
}

const watcherPullRequestFields =
  "number,url,state,mergedAt,closedAt,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision";
const watcherChecksFields = "name,state,bucket,link,workflow,event,startedAt,completedAt";
const watcherReviewThreadsQuery = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes { databaseId createdAt body path line originalLine url authorAssociation author { login __typename } pullRequestReview { state } }
          }
        }
      }
    }
  }
}`;
const watcherThreadCommentsQuery = `query($threadId: ID!, $cursor: String) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { databaseId body }
      }
    }
  }
}`;

function mockDenoCommand(stdout: string, success = true): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Deno");
  Object.defineProperty(globalThis, "Deno", {
    configurable: true,
    value: {
      Command: class {
        outputSync() {
          return { success, stdout: new TextEncoder().encode(stdout) };
        }
      },
    },
  });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, "Deno", descriptor);
    else Reflect.deleteProperty(globalThis, "Deno");
  };
}

function mockDenoCommandSequence(outputs: readonly string[], observed: string[][]): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Deno");
  let outputIndex = 0;
  Object.defineProperty(globalThis, "Deno", {
    configurable: true,
    value: {
      Command: class {
        constructor(executable: string, options: { readonly args: readonly string[] }) {
          observed.push([executable, ...options.args]);
        }

        outputSync() {
          return {
            success: true,
            stdout: new TextEncoder().encode(outputs[outputIndex++] ?? ""),
          };
        }
      },
    },
  });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, "Deno", descriptor);
    else Reflect.deleteProperty(globalThis, "Deno");
  };
}

function mockDenoFiles(os: "linux" | "windows" = "linux"): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Deno");
  const root = os === "windows" ? "C:\\workspace" : "/workspace";
  Object.defineProperty(globalThis, "Deno", {
    configurable: true,
    value: {
      build: { os },
      cwd: () => root,
      realPathSync: (path: string) => {
        if (path === "missing-file.ts") throw new Error("missing");
        if (path === root) return root;
        return os === "windows" ? `${root}\\${path.replaceAll("/", "\\")}` : `${root}/${path}`;
      },
      statSync: (path: string) => ({
        isFile:
          path === `${root}${os === "windows" ? "\\" : "/"}package.json` ||
          path.endsWith(
            `${os === "windows" ? "\\" : "/"}src${os === "windows" ? "\\" : "/"}file.ts`,
          ),
      }),
    },
  });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, "Deno", descriptor);
    else Reflect.deleteProperty(globalThis, "Deno");
  };
}

describe("GitHub pull request request materializer", () => {
  test("materializes narrow Git mutations for the current pull request", () => {
    const pullRequestLookup = () => currentPullRequest();
    for (const [words, operation] of [
      [["git", "add", "mvp/utils/customer.py"], "git.add"],
      [["git", "commit", "-m", "fix(ci): format customer validation"], "git.commit"],
      [["git", "push"], "git.push"],
    ] as const) {
      expect(
        materializeGitHubPullRequest(
          candidate(words),
          undefined,
          undefined,
          undefined,
          pullRequestLookup,
          undefined,
          undefined,
          () => true,
          () => true,
        ),
      ).toEqual(
        expect.objectContaining({
          operation,
          resource: "github:pull-request:hirundo-io/hirundo-platform#513",
        }),
      );
    }

    for (const words of [
      ["git", "add", "."],
      ["git", "add", "src"],
      ["git", "add", "src/*.ts"],
      ["git", "commit", "--amend", "-m", "rewrite"],
      ["git", "commit", "--no-verify", "-m", "skip hooks"],
      ["git", "push", "--force"],
      ["git", "push", "origin", "HEAD:main"],
    ]) {
      expect(
        materializeGitHubPullRequest(
          candidate(words),
          undefined,
          undefined,
          undefined,
          pullRequestLookup,
          undefined,
          undefined,
          (path) => path !== "src",
          () => true,
        ),
      ).toBeUndefined();
    }
    expect(
      materializeGitHubPullRequest(
        candidate(["git", "push"]),
        undefined,
        undefined,
        undefined,
        () => undefined,
        undefined,
        undefined,
        () => true,
        () => true,
      ),
    ).toBeUndefined();
    expect(
      materializeGitHubPullRequest(
        repeatedCandidate(["git", "push"]),
        undefined,
        undefined,
        undefined,
        pullRequestLookup,
        undefined,
        undefined,
        () => true,
        () => true,
      ),
    ).toBeUndefined();
  });

  test("allows plain git push only for the current PR branch and configured repository", () => {
    const observed: string[][] = [];
    const restore = mockDenoCommandSequence(
      [
        JSON.stringify({
          headRefName: "feature",
          headRefOid: "a".repeat(40),
          number: 513,
          url: "https://github.com/Hirundo-io/hirundo-platform/pull/513",
        }),
        "feature",
        "",
        "",
        "origin",
        "",
        "refs/heads/feature",
        "",
        "",
        "git@github.com:Hirundo-io/hirundo-platform.git",
      ],
      observed,
    );
    try {
      expect(materializeGitHubPullRequest(candidate(["git", "push"]))).toEqual(
        expect.objectContaining({ operation: "git.push" }),
      );
      expect(observed).toContainEqual(["git", "config", "--get-all", "remote.origin.push"]);
      expect(observed).toContainEqual(["git", "config", "--get-all", "remote.origin.pushurl"]);
    } finally {
      restore();
    }
  });

  test("rejects plain git push when effective configuration is not proven safe", () => {
    expect(
      materializeGitHubPullRequest(
        candidate(["git", "push"]),
        undefined,
        undefined,
        undefined,
        () => currentPullRequest(),
        undefined,
        undefined,
        () => true,
        () => false,
      ),
    ).toBeUndefined();

    for (const repetition of ["unexpected", null, 1, {}]) {
      expect(
        materializeGitHubPullRequest(
          { command: { repetition, words: ["git", "push"] } },
          undefined,
          undefined,
          undefined,
          () => currentPullRequest(),
          undefined,
          undefined,
          () => true,
          () => true,
        ),
      ).toBeUndefined();
    }
  });

  test("rejects a push URL rewritten away from the PR repository", () => {
    const restore = mockDenoCommandSequence(
      [
        JSON.stringify({
          headRefName: "feature",
          headRefOid: "a".repeat(40),
          number: 513,
          url: "https://github.com/Hirundo-io/hirundo-platform/pull/513",
        }),
        "feature",
        "",
        "",
        "origin",
        "",
        "refs/heads/feature",
        "",
        "",
        "ssh://attacker.example/acme/example.git",
      ],
      [],
    );
    try {
      expect(materializeGitHubPullRequest(candidate(["git", "push"]))).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("allows git add only for existing regular workspace files", () => {
    const restore = mockDenoFiles();
    const materialize = (path: string) =>
      materializeGitHubPullRequest(
        candidate(["git", "add", path]),
        undefined,
        undefined,
        undefined,
        () => currentPullRequest(),
      );

    try {
      expect(materialize("package.json")).toEqual(
        expect.objectContaining({ operation: "git.add" }),
      );
      expect(materialize("shared")).toBeUndefined();
      expect(materialize("missing-file.ts")).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("recognizes nested workspace files with Windows path separators", () => {
    const restore = mockDenoFiles("windows");
    try {
      expect(
        materializeGitHubPullRequest(
          candidate(["git", "add", "src/file.ts"]),
          undefined,
          undefined,
          undefined,
          () => currentPullRequest(),
        ),
      ).toEqual(expect.objectContaining({ operation: "git.add" }));
    } finally {
      restore();
    }
  });

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
    expect(
      materializeGitHubPullRequest(
        candidate(["gh", "pr", "diff", "42"]),
        undefined,
        undefined,
        undefined,
        () => ({
          headBranch: "feature",
          headSha: "a".repeat(40),
          resource: "github:pull-request:acme/example#42",
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        operation: "github.pull-request.diff",
        resource: "github:pull-request:acme/example#42",
      }),
    );
    expect(
      materializeGitHubPullRequest(
        candidate(["gh", "pr", "diff", "42"]),
        undefined,
        undefined,
        undefined,
        () => ({
          headBranch: "feature",
          headSha: "a".repeat(40),
          resource: "github:pull-request:acme/example#7",
        }),
      ),
    ).toBeUndefined();
  });

  test("materializes an attributed pull-request conversation comment", () => {
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "--method",
          "POST",
          "repos/Hirundo-io/hirundo-platform/issues/513/comments",
          "-f",
          "body=_Replying as Codex. Addressed the review feedback.",
        ]),
      ),
    ).toEqual({
      bodyPresent: true,
      operation: "github.pull-request.conversation-comment",
      resource: "github:pull-request:hirundo-io/hirundo-platform#513",
      trailingArgumentCount: 0,
      trailingArguments: [],
    });
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "--method",
          "POST",
          "repos/Hirundo-io/hirundo-platform/issues/513/comments",
          "-f",
          "body=[from Codex]: Addressed the review feedback.",
        ]),
      ),
    ).toEqual(expect.objectContaining({ operation: "github.pull-request.conversation-comment" }));
  });

  test("rejects whitespace-only reply attribution", () => {
    for (const body of ["_Replying as    ", "[from    ]: Addressed the feedback."]) {
      expect(
        materializeGitHubPullRequest(
          candidate([
            "gh",
            "api",
            "--method",
            "POST",
            "repos/Hirundo-io/hirundo-platform/issues/513/comments",
            "-f",
            `body=${body}`,
          ]),
        ),
      ).toBeUndefined();
    }
  });

  test("materializes only the reviewed repo-local checks JSON selection", () => {
    expect(
      materializeGitHubPullRequest(
        candidate(["gh", "pr", "checks", "513", "--json", "name,state,bucket,link,workflow"]),
        undefined,
        undefined,
        undefined,
        () => currentPullRequest(),
      ),
    ).toEqual({
      bodyPresent: false,
      operation: "github.pull-request.checks",
      resource: "github:pull-request:hirundo-io/hirundo-platform#513",
      trailingArgumentCount: 2,
      trailingArguments: ["--json", "name,state,bucket,link,workflow"],
    });
  });

  test("materializes the watcher's PR metadata and checks commands", () => {
    for (const words of [
      ["gh", "pr", "view", "--json", watcherPullRequestFields],
      [
        "gh",
        "pr",
        "view",
        "513",
        "--json",
        "number,url,title,body,state,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,files,reviews,comments",
      ],
      [
        "gh",
        "-R",
        "Hirundo-io/hirundo-platform",
        "pr",
        "view",
        "513",
        "--json",
        watcherPullRequestFields,
      ],
    ]) {
      expect(
        materializeGitHubPullRequest(candidate(words), undefined, undefined, undefined, () =>
          currentPullRequest(),
        ),
      ).toEqual(expect.objectContaining({ operation: "github.pull-request.view" }));
    }
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "-R",
          "Hirundo-io/hirundo-platform",
          "pr",
          "checks",
          "513",
          "--json",
          watcherChecksFields,
        ]),
        undefined,
        undefined,
        undefined,
        () => currentPullRequest(),
      ),
    ).toEqual(expect.objectContaining({ operation: "github.pull-request.checks" }));
  });

  test("materializes the watcher's PR-scoped REST and Actions reads", () => {
    const pullRequestLookup = () => currentPullRequest();
    const runLookup = (repository: string, runId: string) =>
      repository.toLowerCase() === "hirundo-io/hirundo-platform" && runId === "9001"
        ? currentPullRequest().resource
        : undefined;
    for (const [words, operation] of [
      [
        ["gh", "api", "repos/Hirundo-io/hirundo-platform/issues/513/comments?per_page=100&page=2"],
        "github.pull-request.conversation-comments",
      ],
      [
        ["gh", "api", "repos/Hirundo-io/hirundo-platform/pulls/513/reviews?per_page=100&page=1"],
        "github.pull-request.reviews",
      ],
      [
        [
          "gh",
          "api",
          "repos/Hirundo-io/hirundo-platform/actions/runs",
          "-X",
          "GET",
          "-f",
          `head_sha=${"a".repeat(40)}`,
          "-f",
          "per_page=100",
          "-f",
          "page=1",
        ],
        "github.actions.runs",
      ],
      [
        [
          "gh",
          "api",
          "repos/Hirundo-io/hirundo-platform/actions/runs/9001/jobs",
          "-X",
          "GET",
          "-f",
          "per_page=100",
          "-f",
          "page=1",
        ],
        "github.actions.jobs",
      ],
    ] as const) {
      expect(
        materializeGitHubPullRequest(
          candidate(words),
          undefined,
          undefined,
          undefined,
          pullRequestLookup,
          runLookup,
        ),
      ).toEqual(expect.objectContaining({ operation }));
    }
  });

  test("materializes verified workflow-run diagnosis and failed reruns", () => {
    const runLookup = () => currentPullRequest().resource;
    const jobLookup = () => true;
    for (const [words, operation] of [
      [
        [
          "gh",
          "-R",
          "Hirundo-io/hirundo-platform",
          "run",
          "view",
          "9001",
          "--json",
          "jobs,name,workflowName,conclusion,status,url,headSha",
        ],
        "github.actions.run-view",
      ],
      [
        [
          "gh",
          "run",
          "view",
          "9001",
          "--json",
          "jobs,name,workflowName,conclusion,status,url,headSha",
        ],
        "github.actions.run-view",
      ],
      [
        [
          "gh",
          "-R",
          "Hirundo-io/hirundo-platform",
          "run",
          "view",
          "9001",
          "--job",
          "7001",
          "--log",
        ],
        "github.actions.run-view",
      ],
      [
        ["gh", "-R", "Hirundo-io/hirundo-platform", "run", "rerun", "9001", "--failed"],
        "github.actions.rerun-failed",
      ],
    ] as const) {
      expect(
        materializeGitHubPullRequest(
          candidate(words),
          undefined,
          undefined,
          undefined,
          () => currentPullRequest(),
          runLookup,
          jobLookup,
        ),
      ).toEqual(expect.objectContaining({ operation }));
    }
  });

  test("verifies workflow runs without account, auth, token, or configuration queries", () => {
    const observed: string[][] = [];
    const restore = mockDenoCommandSequence(
      [
        `${"a".repeat(40)}\n`,
        JSON.stringify({
          headRefName: "feature",
          headRefOid: "a".repeat(40),
          number: 513,
          url: "https://github.com/Hirundo-io/hirundo-platform/pull/513",
        }),
      ],
      observed,
    );
    try {
      expect(
        materializeGitHubPullRequest(
          candidate([
            "gh",
            "-R",
            "Hirundo-io/hirundo-platform",
            "run",
            "rerun",
            "9001",
            "--failed",
          ]),
        ),
      ).toEqual(expect.objectContaining({ operation: "github.actions.rerun-failed" }));
      expect(observed).toEqual([
        ["gh", "api", "repos/Hirundo-io/hirundo-platform/actions/runs/9001", "--jq", ".head_sha"],
        ["gh", "pr", "view", "--json", "number,url,headRefName,headRefOid"],
      ]);
    } finally {
      restore();
    }
  });

  test("fails closed across live workflow verification boundaries", () => {
    const rerun = ["gh", "-R", "Hirundo-io/hirundo-platform", "run", "rerun", "9001", "--failed"];
    for (const outputs of [
      ["a".repeat(40), "not-json"],
      ["a".repeat(40), "{}"],
      [
        "b".repeat(40),
        JSON.stringify({
          headRefName: "feature",
          headRefOid: "a".repeat(40),
          number: 513,
          url: "https://github.com/Hirundo-io/hirundo-platform/pull/513",
        }),
      ],
    ]) {
      const restore = mockDenoCommandSequence(outputs, []);
      try {
        expect(materializeGitHubPullRequest(candidate(rerun))).toBeUndefined();
      } finally {
        restore();
      }
    }

    const restore = mockDenoCommandSequence(
      [
        "https://api.github.com/repos/Hirundo-io/hirundo-platform/actions/runs/9001",
        "a".repeat(40),
        JSON.stringify({
          headRefName: "feature",
          headRefOid: "a".repeat(40),
          number: 513,
          url: "https://github.com/Hirundo-io/hirundo-platform/pull/513",
        }),
      ],
      [],
    );
    try {
      expect(
        materializeGitHubPullRequest(
          candidate([
            "gh",
            "-R",
            "Hirundo-io/hirundo-platform",
            "run",
            "view",
            "9001",
            "--job",
            "7001",
            "--log",
          ]),
        ),
      ).toEqual(expect.objectContaining({ operation: "github.actions.run-view" }));
    } finally {
      restore();
    }
  });

  test("handles explicit PR URLs and invalid scoped targets", () => {
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "pr",
          "view",
          "https://github.com/Hirundo-io/hirundo-platform/pull/513",
          "--json",
          watcherPullRequestFields,
        ]),
      ),
    ).toEqual(expect.objectContaining({ operation: "github.pull-request.view" }));
    for (const words of [
      ["gh", "-R", "invalid", "pr", "view", "513", "--json", watcherPullRequestFields],
      ["gh", "pr", "view", "https://github.com/not-a-pull", "--json", watcherPullRequestFields],
      [
        "gh",
        "-R",
        "Hirundo-io/other",
        "pr",
        "view",
        "https://github.com/Hirundo-io/hirundo-platform/pull/513",
        "--json",
        watcherPullRequestFields,
      ],
    ]) {
      expect(materializeGitHubPullRequest(candidate(words))).toBeUndefined();
    }
  });

  test("returns undefined when otherwise valid watcher targets cannot be verified", () => {
    expect(
      materializeGitHubPullRequest(
        candidate(["gh", "pr", "view", "999", "--json", watcherPullRequestFields]),
        undefined,
        undefined,
        undefined,
        () => currentPullRequest(),
      ),
    ).toBeUndefined();
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "repos/invalid@owner/example/issues/513/comments?per_page=100&page=1",
        ]),
      ),
    ).toBeUndefined();
    expect(
      materializeGitHubPullRequest(
        candidate(["gh", "pr", "checks", "999", "--json", watcherChecksFields]),
        undefined,
        undefined,
        undefined,
        () => currentPullRequest(),
      ),
    ).toBeUndefined();
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "repos/Hirundo-io/hirundo-platform/actions/runs/9001/jobs",
          "-X",
          "GET",
          "-f",
          "per_page=100",
        ]),
        undefined,
        undefined,
        undefined,
        () => currentPullRequest(),
        () => undefined,
      ),
    ).toBeUndefined();
  });

  test("materializes both watcher GraphQL pagination queries", () => {
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "graphql",
          "-f",
          `query=${watcherReviewThreadsQuery}`,
          "-F",
          "owner=Hirundo-io",
          "-F",
          "name=hirundo-platform",
          "-F",
          "number=513",
          "-F",
          "cursor=cursor-2",
        ]),
      ),
    ).toEqual(expect.objectContaining({ operation: "github.pull-request.review-threads" }));
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "graphql",
          "-f",
          `query=${watcherThreadCommentsQuery}`,
          "-F",
          "threadId=PRRT_current",
          "-F",
          "cursor=cursor-2",
        ]),
        undefined,
        () => currentPullRequest().resource,
      ),
    ).toEqual(expect.objectContaining({ operation: "github.review-thread.comments" }));
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "graphql",
          "-f",
          `query=${watcherThreadCommentsQuery}`,
          "-F",
          "threadId=PRRT_other",
          "-F",
          "cursor=cursor-2",
        ]),
        undefined,
        () => undefined,
      ),
    ).toBeUndefined();
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

  test("uses live GitHub lookups for reply and thread authorization", () => {
    const restoreThreadLookup = mockDenoCommand(
      JSON.stringify({
        data: {
          node: { pullRequest: { number: 42, repository: { nameWithOwner: "Acme/Example" } } },
        },
      }),
    );
    try {
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
        ),
      ).toEqual(expect.objectContaining({ operation: "github.review-thread.reply" }));
    } finally {
      restoreThreadLookup();
    }
    const restoreCommentLookup = mockDenoCommand("9\n");
    try {
      expect(
        materializeGitHubPullRequest(
          candidate([
            "gh",
            "api",
            "repos/acme/example/pulls/42/comments/9/replies",
            "-f",
            "body=_Replying as Codex\n\nFixed.",
          ]),
        ),
      ).toEqual(expect.objectContaining({ operation: "github.review-comment.reply" }));
    } finally {
      restoreCommentLookup();
    }
    const restoreMalformedLookup = mockDenoCommand("not JSON");
    try {
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
            "clientMutationTag=untrusted",
          ]),
        ),
      ).toBeUndefined();
    } finally {
      restoreMalformedLookup();
    }
    const restoreFailedLookup = mockDenoCommand("", false);
    try {
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
            "clientMutationTag=untrusted",
          ]),
        ),
      ).toBeUndefined();
    } finally {
      restoreFailedLookup();
    }
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
    const reformattedQuery = reviewThreadsQuery.replaceAll("\n", " ").replaceAll(/\s+/g, " ");
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "graphql",
          "--paginate",
          "--slurp",
          "-f",
          "owner=Acme",
          "-f",
          "repo=Example",
          "-F",
          "pr=42",
          "-f",
          `query=${reformattedQuery}`,
        ]),
      ),
    ).toEqual(expect.objectContaining({ operation: "github.pull-request.review-threads" }));
  });

  test("allows flexible pagination and comment projections in the review-thread query", () => {
    const query = `query($owner:String!,$repo:String!,$pr:Int!,$endCursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$pr){headRefOid reviewThreads(first:37,after:$endCursor){nodes{id isResolved isOutdated path line comments(first:73){nodes{id databaseId state authorAssociation reactionGroups{content users{totalCount}}}}} pageInfo{hasNextPage endCursor}}}}}`;
    const command = [
      "gh",
      "api",
      "graphql",
      "--paginate",
      "--slurp",
      "-f",
      "owner=Acme",
      "-f",
      "repo=Example",
      "-F",
      "pr=42",
      "-f",
      `query=${query}`,
    ];
    expect(materializeGitHubPullRequest(candidate(command))).toEqual(
      expect.objectContaining({ operation: "github.pull-request.review-threads" }),
    );
    const withoutPageInfo = query.replace(" pageInfo{hasNextPage endCursor}", "");
    expect(
      materializeGitHubPullRequest(
        candidate(command.with(command.length - 1, `query=${withoutPageInfo}`)),
      ),
    ).toEqual(expect.objectContaining({ operation: "github.pull-request.review-threads" }));
  });

  test("rejects malformed and out-of-range review-thread queries", () => {
    for (const [query, number] of [
      ["query(", "42"],
      [reviewThreadsQuery, "2147483648"],
    ]) {
      expect(
        materializeGitHubPullRequest(
          candidate([
            "gh",
            "api",
            "graphql",
            "--paginate",
            "--slurp",
            "-f",
            "owner=Acme",
            "-f",
            "repo=Example",
            "-F",
            `pr=${number}`,
            "-f",
            `query=${query}`,
          ]),
        ),
      ).toBeUndefined();
    }
    for (const first of ["0", "-1", "101"]) {
      const invalidReviewThreads = reviewThreadsQuery.replace(
        "reviewThreads(first: 100",
        `reviewThreads(first: ${first}`,
      );
      const invalidComments = reviewThreadsQuery.replace(
        "comments(first: 100)",
        `comments(first: ${first})`,
      );
      for (const query of [invalidReviewThreads, invalidComments]) {
        expect(
          materializeGitHubPullRequest(
            candidate([
              "gh",
              "api",
              "graphql",
              "--paginate",
              "--slurp",
              "-f",
              "owner=Acme",
              "-f",
              "repo=Example",
              "-F",
              "pr=42",
              "-f",
              `query=${query}`,
            ]),
          ),
        ).toBeUndefined();
      }
    }
  });

  test.each([
    [
      "conversation comment without attribution",
      [
        "gh",
        "api",
        "--method",
        "POST",
        "repos/Hirundo-io/hirundo-platform/issues/513/comments",
        "-f",
        "body=Missing attribution.",
      ],
    ],
    [
      "checks with an unreviewed JSON field",
      ["gh", "pr", "checks", "513", "--json", "name,state,bucket,link,workflow,event"],
    ],
    [
      "checks with a trailing flag",
      ["gh", "pr", "checks", "513", "--json", "name,state,bucket,link,workflow", "--watch"],
    ],
    [
      "a non-numeric comments page size",
      [
        "gh",
        "api",
        "graphql",
        "--paginate",
        "--slurp",
        "-f",
        "owner=Acme",
        "-f",
        "repo=Example",
        "-F",
        "pr=42",
        "-f",
        `query=${reviewThreadsQuery.replace("comments(first: 100)", "comments(first: $pr)")}`,
      ],
    ],
  ])("rejects %s", (_name, words) =>
    expect(
      materializeGitHubPullRequest(candidate(words), undefined, undefined, undefined, () =>
        currentPullRequest(),
      ),
    ).toBeUndefined(),
  );

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
    expect(
      materializeGitHubPullRequest(
        candidate([
          "gh",
          "api",
          "graphql",
          "-f",
          "query=mutation(",
          "-f",
          "thread=PRRT_current",
          "-f",
          "body=_Replying as Codex\n\nFixed.",
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
          `query=${reviewThreadCommentsQuery}`,
          "-F",
          "id=PRRT_other",
          "--paginate",
          "--slurp",
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

  test.each(
    [
      ["gh", "auth", "status"],
      ["gh", "auth", "token"],
      ["gh", "api", "user"],
      ["gh", "api", "user", "--jq", ".login"],
      ["gh", "api", "rate_limit"],
      ["gh", "api", "repos/Hirundo-io/hirundo-platform/actions/secrets"],
      ["gh", "-R", "Hirundo-io/other", "run", "rerun", "9001", "--failed"],
      ["gh", "-R", "Hirundo-io/hirundo-platform", "run", "view", "9001", "--job", "9999", "--log"],
    ].map((words) => [words] as const),
  )("rejects account, credential, generic API, and unrelated-repository access %#", (words) =>
    expect(
      materializeGitHubPullRequest(
        candidate(words),
        undefined,
        undefined,
        undefined,
        () => currentPullRequest(),
        (repository) =>
          repository.toLowerCase() === "hirundo-io/hirundo-platform"
            ? currentPullRequest().resource
            : undefined,
      ),
    ).toBeUndefined(),
  );

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
