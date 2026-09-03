import { Kind, parse } from "graphql";

type RequestMaterializerInput = {
  readonly command?: { readonly words?: unknown };
};

type PullRequestOperation = {
  readonly bodyPresent: boolean;
  readonly operation: string;
  readonly resource: string;
  readonly trailingArguments: readonly string[];
  readonly trailingArgumentCount: number;
};

const replyPrefix = "_Replying as ";
type ReadTextFile = (path: string) => string;
type ReviewThreadLookup = (threadId: string) => string | undefined;
type ReviewCommentLookup = (
  owner: string,
  repository: string,
  pullRequestNumber: string,
  commentId: string,
) => boolean;

export const reviewThreadsQuery = `query ReviewThreads($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $endCursor) {
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 100) {
            nodes {
              id
              body
              author {
                login
              }
              path
              line
              originalLine
              diffHunk
              createdAt
              updatedAt
              url
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`;

export const resolveReviewThreadMutation = `mutation ResolveReviewThread($threadId: ID!, $clientMutationTag: String!) {
  resolveReviewThread(input: { threadId: $threadId, clientMutationId: $clientMutationTag }) {
    thread {
      id
      isResolved
      pullRequest {
        number
        repository {
          nameWithOwner
        }
      }
    }
  }
}`;

export const reviewThreadCommentsQuery = `query ReviewThreadComments($id: ID!, $endCursor: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      id
      pullRequest {
        number
        repository {
          nameWithOwner
        }
      }
      comments(first: 100, after: $endCursor) {
        nodes {
          id
          databaseId
          body
          author {
            login
          }
          url
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`;

const reviewThreadTargetQuery = `query ReviewThreadTarget($id: ID!) { node(id: $id) { ... on PullRequestReviewThread { pullRequest { number repository { nameWithOwner } } } } }`;

function input(candidate: unknown): RequestMaterializerInput {
  if (typeof candidate !== "object" || candidate === null) return {};
  const command =
    "command" in candidate && typeof candidate.command === "object" && candidate.command !== null
      ? (candidate.command as { readonly words?: unknown })
      : undefined;
  return { command };
}

function canonicalTarget(repository: string, number: string): string | undefined {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[1-9][0-9]*$/.test(number)) {
    return undefined;
  }
  return `github:pull-request:${repository.toLowerCase()}#${number}`;
}

function liveReviewThreadTarget(threadId: string): string | undefined {
  if (typeof Deno === "undefined") return undefined;
  const result = new Deno.Command("gh", {
    args: ["api", "graphql", "-f", `query=${reviewThreadTargetQuery}`, "-F", `id=${threadId}`],
    stderr: "null",
    stdout: "piped",
  }).outputSync();
  if (!result.success) return undefined;
  try {
    const value = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      data?: {
        node?: { pullRequest?: { number?: number; repository?: { nameWithOwner?: string } } };
      };
    };
    const pullRequest = value.data?.node?.pullRequest;
    return typeof pullRequest?.number === "number" &&
      typeof pullRequest.repository?.nameWithOwner === "string"
      ? canonicalTarget(pullRequest.repository.nameWithOwner, String(pullRequest.number))
      : undefined;
  } catch {
    return undefined;
  }
}

function liveReviewCommentBelongsTo(
  owner: string,
  repository: string,
  pullRequestNumber: string,
  commentId: string,
): boolean {
  if (typeof Deno === "undefined") return false;
  const result = new Deno.Command("gh", {
    args: [
      "api",
      `repos/${owner}/${repository}/pulls/${pullRequestNumber}/comments/${commentId}`,
      "--jq",
      ".id",
    ],
    stderr: "null",
    stdout: "piped",
  }).outputSync();
  return result.success && new TextDecoder().decode(result.stdout).trim() === commentId;
}

function pullRequestOperation(words: readonly string[]): PullRequestOperation | undefined {
  const [gh, pr, subcommand, number, repoFlag, repository, ...rest] = words;
  if (
    gh !== "gh" ||
    pr !== "pr" ||
    !subcommand ||
    !number ||
    repoFlag !== "--repo" ||
    !repository
  ) {
    return undefined;
  }
  const resource = canonicalTarget(repository, number);
  if (!resource) return undefined;
  const bodyIndex = rest.indexOf("--body");
  return {
    bodyPresent:
      bodyIndex >= 0 && typeof rest[bodyIndex + 1] === "string" && rest[bodyIndex + 1]!.length > 0,
    operation: `github.pull-request.${subcommand}`,
    resource,
    trailingArguments: rest,
    trailingArgumentCount: rest.length,
  };
}

function replyBodyIsIdentified(
  bodyFlag: string,
  bodyField: string,
  readTextFile: ReadTextFile,
): boolean {
  if (bodyFlag === "-f") return bodyField.startsWith(`body=${replyPrefix}`);
  if (bodyFlag !== "-F" || !/^body=@[^/\\]+$/.test(bodyField)) return false;
  try {
    return readTextFile(bodyField.slice("body=@".length)).startsWith(replyPrefix);
  } catch {
    return false;
  }
}

function reviewReplyOperation(
  words: readonly string[],
  readTextFile: ReadTextFile,
  reviewCommentLookup: ReviewCommentLookup,
): PullRequestOperation | undefined {
  const [gh, api, ...arguments_] = words;
  if (gh !== "gh" || api !== "api") return undefined;
  const [methodFlag, method] = arguments_;
  const hasExplicitPost = methodFlag === "--method" && method === "POST";
  const [endpoint, bodyFlag, bodyField, ...output] = arguments_.slice(hasExplicitPost ? 2 : 0);
  if (!endpoint || (bodyFlag !== "-f" && bodyFlag !== "-F") || !bodyField) return undefined;
  const match =
    /^repos\/([^/]+)\/([^/]+)\/pulls\/([1-9][0-9]*)\/comments\/([1-9][0-9]*)\/replies$/.exec(
      endpoint,
    );
  if (!match) return undefined;
  const resource = canonicalTarget(`${match[1]}/${match[2]}`, match[3]!);
  const bodyPresent = replyBodyIsIdentified(bodyFlag, bodyField, readTextFile);
  if (
    !bodyPresent ||
    (output.length !== 0 &&
      (output.length !== 2 || output[0] !== "--jq" || output[1] !== ".html_url"))
  ) {
    return undefined;
  }
  return resource && reviewCommentLookup(match[1]!, match[2]!, match[3]!, match[4]!)
    ? {
        bodyPresent,
        operation: "github.review-comment.reply",
        resource,
        trailingArguments: [],
        trailingArgumentCount: 0,
      }
    : undefined;
}

function graphqlReviewReplyOperation(
  words: readonly string[],
  reviewThreadLookup: ReviewThreadLookup,
): PullRequestOperation | undefined {
  const [gh, api, graphql, queryFlag, queryField, threadFlag, threadField, bodyFlag, bodyField] =
    words;
  if (
    gh !== "gh" ||
    api !== "api" ||
    graphql !== "graphql" ||
    queryFlag !== "-f" ||
    !queryField?.startsWith("query=") ||
    threadFlag !== "-f" ||
    !/^thread=PRRT_[A-Za-z0-9_-]+$/.test(threadField ?? "") ||
    bodyFlag !== "-f" ||
    !bodyField?.startsWith(`body=${replyPrefix}`) ||
    words.length !== 9
  )
    return undefined;
  let document;
  try {
    document = parse(queryField.slice("query=".length), { noLocation: true });
  } catch {
    return undefined;
  }
  if (
    document.definitions.length !== 1 ||
    document.definitions[0]?.kind !== Kind.OPERATION_DEFINITION
  )
    return undefined;
  const operation = document.definitions[0];
  const variables = operation.variableDefinitions ?? [];
  const isRequiredNamedType = (name: string, type: (typeof variables)[number]["type"]) =>
    type.kind === Kind.NON_NULL_TYPE &&
    type.type.kind === Kind.NAMED_TYPE &&
    type.type.name.value === name;
  if (
    operation.operation !== "mutation" ||
    (operation.directives?.length ?? 0) !== 0 ||
    variables.length !== 2 ||
    variables.some(
      (variable) => variable.defaultValue || (variable.directives?.length ?? 0) !== 0,
    ) ||
    !variables.some(
      (variable) =>
        variable.variable.name.value === "thread" && isRequiredNamedType("ID", variable.type),
    ) ||
    !variables.some(
      (variable) =>
        variable.variable.name.value === "body" && isRequiredNamedType("String", variable.type),
    ) ||
    operation.selectionSet.selections.length !== 1
  )
    return undefined;
  const selection = operation.selectionSet.selections[0];
  if (
    selection?.kind !== Kind.FIELD ||
    selection.name.value !== "addPullRequestReviewThreadReply" ||
    (selection.directives?.length ?? 0) !== 0 ||
    selection.arguments?.length !== 1 ||
    selection.arguments[0]?.name.value !== "input" ||
    selection.arguments[0].value.kind !== Kind.OBJECT ||
    selection.arguments[0].value.fields.length !== 2
  )
    return undefined;
  const input = selection.arguments![0]!.value.fields;
  const thread = input.find((field) => field.name.value === "pullRequestReviewThreadId")?.value;
  const body = input.find((field) => field.name.value === "body")?.value;
  const threadId = threadField.slice("thread=".length);
  const resource = reviewThreadLookup(threadId);
  if (
    thread?.kind !== Kind.VARIABLE ||
    thread.name.value !== "thread" ||
    body?.kind !== Kind.VARIABLE ||
    body.name.value !== "body" ||
    !resource
  )
    return undefined;
  return {
    bodyPresent: true,
    operation: "github.review-thread.reply",
    resource,
    trailingArguments: [],
    trailingArgumentCount: 0,
  };
}

function reviewThreadsOperation(words: readonly string[]): PullRequestOperation | undefined {
  const pagination = words.filter((word) => word === "--paginate" || word === "--slurp");
  const command = words.filter((word) => word !== "--paginate" && word !== "--slurp");
  const [
    gh,
    api,
    graphql,
    queryFlag,
    queryField,
    ownerFlag,
    ownerField,
    repoFlag,
    repoField,
    pullRequestFlag,
    pullRequestField,
  ] = command;
  if (
    gh !== "gh" ||
    api !== "api" ||
    graphql !== "graphql" ||
    queryFlag !== "-f" ||
    queryField !== `query=${reviewThreadsQuery}` ||
    ownerFlag !== "-f" ||
    repoFlag !== "-f" ||
    pullRequestFlag !== "-F" ||
    command.length !== 11 ||
    !(
      pagination.length === 2 &&
      pagination.includes("--paginate") &&
      pagination.includes("--slurp")
    )
  ) {
    return undefined;
  }
  const owner = ownerField?.slice("owner=".length);
  const name = repoField?.slice("repo=".length);
  const pullRequestNumber = pullRequestField?.slice("pr=".length);
  if (
    !ownerField?.startsWith("owner=") ||
    !repoField?.startsWith("repo=") ||
    !pullRequestField?.startsWith("pr=") ||
    !pullRequestNumber ||
    Number(pullRequestNumber) > 2_147_483_647
  ) {
    return undefined;
  }
  const resource = canonicalTarget(`${owner}/${name}`, pullRequestNumber);
  return resource
    ? {
        bodyPresent: false,
        operation: "github.pull-request.review-threads",
        resource,
        trailingArguments: [],
        trailingArgumentCount: 0,
      }
    : undefined;
}

function reviewThreadCommentsOperation(
  words: readonly string[],
  reviewThreadLookup: ReviewThreadLookup,
): PullRequestOperation | undefined {
  const pagination = words.filter((word) => word === "--paginate" || word === "--slurp");
  const command = words.filter((word) => word !== "--paginate" && word !== "--slurp");
  const [gh, api, graphql, queryFlag, queryField, idFlag, idField] = command;
  if (
    gh !== "gh" ||
    api !== "api" ||
    graphql !== "graphql" ||
    queryFlag !== "-f" ||
    queryField !== `query=${reviewThreadCommentsQuery}` ||
    idFlag !== "-F" ||
    !/^id=PRRT_[A-Za-z0-9_-]+$/.test(idField ?? "") ||
    command.length !== 7 ||
    pagination.length !== 2 ||
    !pagination.includes("--paginate") ||
    !pagination.includes("--slurp")
  )
    return undefined;
  const resource = reviewThreadLookup(idField.slice("id=".length));
  return resource
    ? {
        bodyPresent: false,
        operation: "github.review-thread.comments",
        resource,
        trailingArguments: [],
        trailingArgumentCount: 0,
      }
    : undefined;
}

function batchReviewThreadResolutionOperation(
  words: readonly string[],
  reviewThreadLookup: ReviewThreadLookup,
): PullRequestOperation | undefined {
  const [gh, api, graphql, queryFlag, queryField, ...fields] = words;
  if (gh !== "gh" || api !== "api" || graphql !== "graphql" || queryFlag !== "-f") return undefined;
  const query = queryField?.startsWith("query=") ? queryField.slice("query=".length) : undefined;
  if (!query || fields.length === 0 || fields.length % 2 !== 0) return undefined;
  let document;
  try {
    document = parse(query, { noLocation: true });
  } catch {
    return undefined;
  }
  if (
    document.definitions.length !== 1 ||
    document.definitions[0]?.kind !== Kind.OPERATION_DEFINITION
  )
    return undefined;
  const operation = document.definitions[0];
  if (operation.operation !== "mutation" || (operation.directives?.length ?? 0) !== 0)
    return undefined;
  const definitions = operation.variableDefinitions ?? [];
  const variables = definitions.map((definition) => definition.variable.name.value);
  if (
    variables.length === 0 ||
    variables.length > 20 ||
    new Set(variables).size !== variables.length ||
    definitions.some(
      (definition) =>
        definition.defaultValue ||
        (definition.directives?.length ?? 0) !== 0 ||
        definition.type.kind !== Kind.NON_NULL_TYPE ||
        definition.type.type.kind !== Kind.NAMED_TYPE ||
        definition.type.type.name.value !== "ID",
    )
  )
    return undefined;
  const threadIds = new Map<string, string>();
  for (let index = 0; index < fields.length; index += 2) {
    if (fields[index] !== "-f") return undefined;
    const match = /^([_A-Za-z][_0-9A-Za-z]*)=(PRRT_[A-Za-z0-9_-]+)$/.exec(fields[index + 1]!);
    if (!match || threadIds.has(match[1]!)) return undefined;
    threadIds.set(match[1]!, match[2]!);
  }
  if (threadIds.size !== variables.length || variables.some((variable) => !threadIds.has(variable)))
    return undefined;
  for (const selection of operation.selectionSet.selections) {
    if (
      selection.kind !== Kind.FIELD ||
      selection.name.value !== "resolveReviewThread" ||
      (selection.directives?.length ?? 0) !== 0
    )
      return undefined;
    const threadId = selection.arguments?.find(
      (argument) => argument.name.value === "input",
    )?.value;
    if (
      threadId?.kind !== Kind.OBJECT ||
      (threadId.fields.length !== 1 && threadId.fields.length !== 2)
    )
      return undefined;
    const threadField = threadId.fields.find((field) => field.name.value === "threadId")?.value;
    const tagField = threadId.fields.find(
      (field) => field.name.value === "clientMutationId",
    )?.value;
    if (
      threadField?.kind !== Kind.VARIABLE ||
      !threadIds.has(threadField.name.value) ||
      (tagField !== undefined && tagField.kind !== Kind.STRING)
    )
      return undefined;
  }
  if (operation.selectionSet.selections.length !== variables.length) return undefined;
  const resource = reviewThreadLookup(threadIds.values().next().value!);
  if (
    !resource ||
    [...threadIds.values()].some((threadId) => reviewThreadLookup(threadId) !== resource)
  )
    return undefined;
  return {
    bodyPresent: false,
    operation: "github.review-thread.resolve",
    resource,
    trailingArguments: [],
    trailingArgumentCount: 0,
  };
}

function reviewThreadResolutionOperation(
  words: readonly string[],
  reviewThreadLookup: ReviewThreadLookup,
): PullRequestOperation | undefined {
  const [gh, api, graphql, queryFlag, queryField, threadFlag, threadField, tagFlag, tagField] =
    words;
  if (
    gh === "gh" &&
    api === "api" &&
    graphql === "graphql" &&
    queryFlag === "-f" &&
    queryField === `query=${resolveReviewThreadMutation}` &&
    threadFlag === "-F" &&
    /^threadId=PRRT_[A-Za-z0-9_-]+$/.test(threadField ?? "") &&
    tagFlag === "-f" &&
    tagField?.startsWith("clientMutationTag=") &&
    words.length === 9
  ) {
    const resource = reviewThreadLookup(threadField.slice("threadId=".length));
    return resource
      ? {
          bodyPresent: false,
          operation: "github.review-thread.resolve",
          resource,
          trailingArguments: [],
          trailingArgumentCount: 0,
        }
      : undefined;
  }
  return batchReviewThreadResolutionOperation(words, reviewThreadLookup);
}

export function materializeGitHubPullRequest(
  candidate: unknown,
  readTextFile: ReadTextFile = (path) => Deno.readTextFileSync(path),
  reviewThreadLookup: ReviewThreadLookup = liveReviewThreadTarget,
  reviewCommentLookup: ReviewCommentLookup = liveReviewCommentBelongsTo,
): PullRequestOperation | undefined {
  const words = input(candidate).command?.words;
  if (!Array.isArray(words) || !words.every((word) => typeof word === "string")) return undefined;
  return (
    reviewThreadResolutionOperation(words, reviewThreadLookup) ??
    graphqlReviewReplyOperation(words, reviewThreadLookup) ??
    reviewThreadCommentsOperation(words, reviewThreadLookup) ??
    reviewThreadsOperation(words) ??
    reviewReplyOperation(words, readTextFile, reviewCommentLookup) ??
    pullRequestOperation(words)
  );
}

export async function runGitHubPullRequestMaterializer(
  candidate: Promise<unknown>,
  write: (value: string) => void = console.log,
): Promise<boolean> {
  const materialized = materializeGitHubPullRequest(await candidate);
  if (!materialized) return false;
  const { resource, ...context } = materialized;
  write(JSON.stringify({ context, resource }));
  return true;
}

// prettier-ignore
void (import.meta.main && Deno.exit((await runGitHubPullRequestMaterializer(new Response(Deno.stdin.readable).json())) ? 0 : 1));
