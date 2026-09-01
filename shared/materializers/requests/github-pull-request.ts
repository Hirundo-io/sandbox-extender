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
  return resource
    ? {
        bodyPresent,
        operation: "github.review-comment.reply",
        resource,
        trailingArguments: [],
        trailingArgumentCount: 0,
      }
    : undefined;
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
  const number = pullRequestField?.slice("pr=".length);
  if (
    !ownerField?.startsWith("owner=") ||
    !repoField?.startsWith("repo=") ||
    !pullRequestField?.startsWith("pr=") ||
    owner === undefined ||
    name === undefined ||
    number === undefined
  ) {
    return undefined;
  }
  const resource = canonicalTarget(`${owner}/${name}`, number);
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

function reviewThreadResolutionOperation(
  words: readonly string[],
): PullRequestOperation | undefined {
  const [gh, api, graphql, queryFlag, queryField, threadFlag, threadField, tagFlag, tagField] =
    words;
  if (
    gh !== "gh" ||
    api !== "api" ||
    graphql !== "graphql" ||
    queryFlag !== "-f" ||
    queryField !== `query=${resolveReviewThreadMutation}` ||
    threadFlag !== "-F" ||
    !/^threadId=PRRT_[A-Za-z0-9_-]+$/.test(threadField ?? "") ||
    tagFlag !== "-f" ||
    words.length !== 9
  )
    return batchReviewThreadResolutionOperation(words);
  const tag = tagField?.slice("clientMutationTag=".length);
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(tag ?? "");
  const resource = match && canonicalTarget(`${match[1]}/${match[2]}`, match[3]!);
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

function batchReviewThreadResolutionOperation(
  words: readonly string[],
): PullRequestOperation | undefined {
  const [gh, api, graphql, queryFlag, queryField, ...fields] = words;
  if (gh !== "gh" || api !== "api" || graphql !== "graphql" || queryFlag !== "-f") return undefined;
  const query = queryField?.startsWith("query=mutation(")
    ? queryField.slice("query=".length)
    : undefined;
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
  const variables = (operation.variableDefinitions ?? []).map(
    (definition) => definition.variable.name.value,
  );
  if (
    variables.length === 0 ||
    variables.length > 20 ||
    new Set(variables).size !== variables.length
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
  const tags: string[] = [];
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
    if (threadId?.kind !== Kind.OBJECT || threadId.fields.length !== 2) return undefined;
    const threadField = threadId.fields.find((field) => field.name.value === "threadId")?.value;
    const tagField = threadId.fields.find(
      (field) => field.name.value === "clientMutationId",
    )?.value;
    if (
      threadField?.kind !== Kind.VARIABLE ||
      !threadIds.has(threadField.name.value) ||
      tagField?.kind !== Kind.STRING
    )
      return undefined;
    tags.push(tagField.value);
  }
  if (operation.selectionSet.selections.length !== variables.length || new Set(tags).size !== 1)
    return undefined;
  const target = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(tags[0] ?? "");
  const resource = target && canonicalTarget(`${target[1]}/${target[2]}`, target[3]!);
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

export function materializeGitHubPullRequest(
  candidate: unknown,
  readTextFile: ReadTextFile = (path) => Deno.readTextFileSync(path),
): PullRequestOperation | undefined {
  const words = input(candidate).command?.words;
  if (!Array.isArray(words) || !words.every((word) => typeof word === "string")) return undefined;
  return (
    reviewThreadResolutionOperation(words) ??
    reviewThreadsOperation(words) ??
    reviewReplyOperation(words, readTextFile) ??
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
import { Kind, parse } from "graphql";
