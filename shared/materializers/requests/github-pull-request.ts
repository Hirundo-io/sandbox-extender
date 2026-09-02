import { Kind, parse, visit, type ASTNode, type DocumentNode } from "graphql";

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
const watcherPullRequestFields =
  "number,url,state,mergedAt,closedAt,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision";
const watcherChecksFields = "name,state,bucket,link,workflow,event,startedAt,completedAt";
const reviewedChecksFields = "name,state,bucket,link,workflow";
type ReadTextFile = (path: string) => string;
type ReviewThreadLookup = (threadId: string) => string | undefined;
type ReviewCommentLookup = (
  owner: string,
  repository: string,
  pullRequestNumber: string,
  commentId: string,
) => boolean;
type PullRequestLookup = () => { readonly headSha: string; readonly resource: string } | undefined;
type RunLookup = (repository: string, runId: string) => string | undefined;
type JobLookup = (repository: string, runId: string, jobId: string) => boolean;

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

const flexibleReviewThreadsQuery = `query($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      headRefOid
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 100) { nodes { databaseId } }
        }
      }
    }
  }
}`;

const watcherReviewThreadsQuery = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 100) { nodes { databaseId } }
        }
      }
    }
  }
}`;

const watcherReviewThreadCommentsQuery = `query($threadId: ID!, $cursor: String) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $cursor) { nodes { databaseId } }
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

function repositoryFromPullRequestUrl(url: string): string | undefined {
  return /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/[1-9][0-9]*$/
    .exec(url)
    ?.slice(1, 3)
    .join("/");
}

function repositoryFromTarget(resource: string): string | undefined {
  return /^github:pull-request:([^#]+)#[1-9][0-9]*$/.exec(resource)?.[1];
}

function scopedGhCommand(
  words: readonly string[],
): { readonly command: readonly string[]; readonly repository?: string } | undefined {
  if (words[0] !== "gh") return undefined;
  if (words[1] !== "-R" && words[1] !== "--repo") return { command: words.slice(1) };
  const repository = words[2];
  return repository && canonicalTarget(repository, "1")
    ? { command: words.slice(3), repository }
    : undefined;
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

function liveCurrentPullRequest():
  { readonly headSha: string; readonly resource: string } | undefined {
  if (typeof Deno === "undefined") return undefined;
  const result = new Deno.Command("gh", {
    args: ["pr", "view", "--json", "number,url,headRefOid"],
    stderr: "null",
    stdout: "piped",
  }).outputSync();
  if (!result.success) return undefined;
  try {
    const value = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      headRefOid?: unknown;
      number?: unknown;
      url?: unknown;
    };
    const repository =
      typeof value.url === "string" ? repositoryFromPullRequestUrl(value.url) : undefined;
    const resource =
      repository && typeof value.number === "number"
        ? canonicalTarget(repository, String(value.number))
        : undefined;
    return resource &&
      typeof value.headRefOid === "string" &&
      /^[0-9a-f]{40}$/.test(value.headRefOid)
      ? { headSha: value.headRefOid, resource }
      : undefined;
  } catch {
    return undefined;
  }
}

function liveRunTarget(repository: string, runId: string): string | undefined {
  if (typeof Deno === "undefined" || !/^[1-9][0-9]*$/.test(runId)) return undefined;
  const result = new Deno.Command("gh", {
    args: ["api", `repos/${repository}/actions/runs/${runId}`, "--jq", ".head_sha"],
    stderr: "null",
    stdout: "piped",
  }).outputSync();
  if (!result.success) return undefined;
  const pullRequest = liveCurrentPullRequest();
  const headSha = new TextDecoder().decode(result.stdout).trim();
  return pullRequest &&
    repositoryFromTarget(pullRequest.resource)?.toLowerCase() === repository.toLowerCase() &&
    pullRequest.headSha === headSha
    ? pullRequest.resource
    : undefined;
}

function liveJobBelongsToRun(repository: string, runId: string, jobId: string): boolean {
  if (typeof Deno === "undefined" || !/^[1-9][0-9]*$/.test(runId) || !/^[1-9][0-9]*$/.test(jobId))
    return false;
  const result = new Deno.Command("gh", {
    args: ["api", `repos/${repository}/actions/jobs/${jobId}`, "--jq", ".run_url"],
    stderr: "null",
    stdout: "piped",
  }).outputSync();
  if (!result.success) return false;
  return new TextDecoder()
    .decode(result.stdout)
    .trim()
    .endsWith(`/repos/${repository}/actions/runs/${runId}`);
}

function targetFromPullRequestSpecifier(
  specifier: string | undefined,
  repository: string | undefined,
  pullRequestLookup: PullRequestLookup,
): string | undefined {
  if (specifier?.startsWith("https://github.com/")) {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/.exec(specifier);
    if (
      !match ||
      (repository && `${match[1]}/${match[2]}`.toLowerCase() !== repository.toLowerCase())
    )
      return undefined;
    return canonicalTarget(`${match[1]}/${match[2]}`, match[3]!);
  }
  if (specifier && repository) return canonicalTarget(repository, specifier);
  const current = pullRequestLookup();
  if (!current) return undefined;
  if (
    repository &&
    repositoryFromTarget(current.resource)?.toLowerCase() !== repository.toLowerCase()
  )
    return undefined;
  return !specifier || current.resource.endsWith(`#${specifier}`) ? current.resource : undefined;
}

function watcherPullRequestViewOperation(
  words: readonly string[],
  pullRequestLookup: PullRequestLookup,
): PullRequestOperation | undefined {
  const scoped = scopedGhCommand(words);
  if (!scoped || scoped.command[0] !== "pr" || scoped.command[1] !== "view") return undefined;
  const arguments_ = scoped.command.slice(2);
  const hasSpecifier = arguments_[0] !== "--json";
  const specifier = hasSpecifier ? arguments_[0] : undefined;
  const jsonIndex = hasSpecifier ? 1 : 0;
  if (
    arguments_[jsonIndex] !== "--json" ||
    arguments_[jsonIndex + 1] !== watcherPullRequestFields ||
    arguments_.length !== jsonIndex + 2
  )
    return undefined;
  const resource = targetFromPullRequestSpecifier(specifier, scoped.repository, pullRequestLookup);
  return resource
    ? {
        bodyPresent: false,
        operation: "github.pull-request.view",
        resource,
        trailingArguments: [],
        trailingArgumentCount: 0,
      }
    : undefined;
}

function pullRequestChecksOperation(
  words: readonly string[],
  pullRequestLookup: PullRequestLookup,
): PullRequestOperation | undefined {
  const scoped = scopedGhCommand(words);
  if (!scoped) return undefined;
  const [pr, checks, number, jsonFlag, jsonFields] = scoped.command;
  if (
    pr !== "pr" ||
    checks !== "checks" ||
    !number ||
    jsonFlag !== "--json" ||
    (jsonFields !== reviewedChecksFields && jsonFields !== watcherChecksFields) ||
    scoped.command.length !== 5
  )
    return undefined;
  const resource = targetFromPullRequestSpecifier(number, scoped.repository, pullRequestLookup);
  return resource
    ? {
        bodyPresent: false,
        operation: "github.pull-request.checks",
        resource,
        trailingArguments: [jsonFlag, jsonFields],
        trailingArgumentCount: 2,
      }
    : undefined;
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

function pullRequestRestReadOperation(words: readonly string[]): PullRequestOperation | undefined {
  const [gh, api, endpoint] = words;
  if (gh !== "gh" || api !== "api" || !endpoint || words.length !== 3) return undefined;
  const match =
    /^repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/([1-9][0-9]*)\/(comments|reviews)\?per_page=100&page=([1-9][0-9]*)$/.exec(
      endpoint,
    );
  if (!match || (match[3] === "issues" ? match[5] !== "comments" : match[5] !== "reviews"))
    return undefined;
  const resource = canonicalTarget(`${match[1]}/${match[2]}`, match[4]!);
  if (!resource) return undefined;
  return {
    bodyPresent: false,
    operation:
      match[3] === "issues"
        ? "github.pull-request.conversation-comments"
        : "github.pull-request.reviews",
    resource,
    trailingArguments: [],
    trailingArgumentCount: 0,
  };
}

function exactFields(
  fields: readonly string[],
  expected: Readonly<Record<string, { readonly flag: string; readonly value: RegExp }>>,
): Readonly<Record<string, string>> | undefined {
  if (fields.length !== Object.keys(expected).length * 2) return undefined;
  const values: Record<string, string> = {};
  for (let index = 0; index < fields.length; index += 2) {
    const flag = fields[index];
    const field = fields[index + 1];
    const match = /^([^=]+)=(.*)$/s.exec(field ?? "");
    const rule = match && expected[match[1]!];
    if (!match || !rule || flag !== rule.flag || !rule.value.test(match[2]!) || match[1] in values)
      return undefined;
    values[match[1]!] = match[2]!;
  }
  return values;
}

function actionsReadOperation(
  words: readonly string[],
  pullRequestLookup: PullRequestLookup,
  runLookup: RunLookup,
): PullRequestOperation | undefined {
  const [gh, api, endpoint, methodFlag, method, ...fields] = words;
  if (gh !== "gh" || api !== "api" || methodFlag !== "-X" || method !== "GET" || !endpoint)
    return undefined;
  const runs = /^repos\/([^/]+)\/([^/]+)\/actions\/runs$/.exec(endpoint);
  if (runs) {
    const values = exactFields(fields, {
      head_sha: { flag: "-f", value: /^[0-9a-f]{40}$/ },
      ...(fields.length === 6 ? { page: { flag: "-f", value: /^[1-9][0-9]*$/ } } : {}),
      per_page: { flag: "-f", value: /^100$/ },
    });
    const current = values && pullRequestLookup();
    const repository = `${runs[1]}/${runs[2]}`;
    if (
      !current ||
      current.headSha !== values?.head_sha ||
      repositoryFromTarget(current.resource)?.toLowerCase() !== repository.toLowerCase()
    )
      return undefined;
    return {
      bodyPresent: false,
      operation: "github.actions.runs",
      resource: current.resource,
      trailingArguments: [],
      trailingArgumentCount: 0,
    };
  }
  const jobs = /^repos\/([^/]+)\/([^/]+)\/actions\/runs\/([1-9][0-9]*)\/jobs$/.exec(endpoint);
  if (!jobs) return undefined;
  const values = exactFields(fields, {
    ...(fields.length === 4 ? { page: { flag: "-f", value: /^[1-9][0-9]*$/ } } : {}),
    per_page: { flag: "-f", value: /^100$/ },
  });
  const repository = `${jobs[1]}/${jobs[2]}`;
  const resource = values && runLookup(repository, jobs[3]!);
  return resource
    ? {
        bodyPresent: false,
        operation: "github.actions.jobs",
        resource,
        trailingArguments: [],
        trailingArgumentCount: 0,
      }
    : undefined;
}

function workflowRunOperation(
  words: readonly string[],
  pullRequestLookup: PullRequestLookup,
  runLookup: RunLookup,
  jobLookup: JobLookup,
): PullRequestOperation | undefined {
  const scoped = scopedGhCommand(words);
  if (!scoped || scoped.command[0] !== "run") return undefined;
  const [run, subcommand, runId, ...subcommandArguments] = scoped.command;
  if (run !== "run" || !runId || !/^[1-9][0-9]*$/.test(runId)) return undefined;
  const repository = scoped.repository ?? repositoryFromTarget(pullRequestLookup()?.resource ?? "");
  if (!repository) return undefined;
  const allowedView =
    subcommand === "view" &&
    ((subcommandArguments.length === 2 &&
      subcommandArguments[0] === "--json" &&
      subcommandArguments[1] === "jobs,name,workflowName,conclusion,status,url,headSha") ||
      (subcommandArguments.length === 1 && subcommandArguments[0] === "--log-failed") ||
      (subcommandArguments.length === 3 &&
        subcommandArguments[0] === "--job" &&
        /^[1-9][0-9]*$/.test(subcommandArguments[1]!) &&
        subcommandArguments[2] === "--log" &&
        jobLookup(repository, runId, subcommandArguments[1]!)));
  const allowedRerun =
    subcommand === "rerun" &&
    subcommandArguments.length === 1 &&
    subcommandArguments[0] === "--failed";
  if (!allowedView && !allowedRerun) return undefined;
  const resource = runLookup(repository, runId);
  return resource
    ? {
        bodyPresent: false,
        operation: allowedRerun ? "github.actions.rerun-failed" : "github.actions.run-view",
        resource,
        trailingArguments: [],
        trailingArgumentCount: 0,
      }
    : undefined;
}

function identifiedReplyBody(body: string): boolean {
  if (body.startsWith(replyPrefix)) return body.slice(replyPrefix.length).trim().length > 0;
  const bracketedAgent = /^\[from ([A-Za-z0-9_. -]+)\]:\s+\S/.exec(body);
  return bracketedAgent !== null && bracketedAgent[1]!.trim().length > 0;
}

function replyBodyIsIdentified(
  bodyFlag: string,
  bodyField: string,
  readTextFile: ReadTextFile,
): boolean {
  if (bodyFlag === "-f") return identifiedReplyBody(bodyField.slice("body=".length));
  if (bodyFlag !== "-F" || !/^body=@[^/\\]+$/.test(bodyField)) return false;
  try {
    return identifiedReplyBody(readTextFile(bodyField.slice("body=@".length)));
  } catch {
    return false;
  }
}

function conversationCommentOperation(words: readonly string[]): PullRequestOperation | undefined {
  const [gh, api, methodFlag, method, endpoint, bodyFlag, bodyField] = words;
  if (
    gh !== "gh" ||
    api !== "api" ||
    methodFlag !== "--method" ||
    method !== "POST" ||
    bodyFlag !== "-f" ||
    !bodyField?.startsWith("body=") ||
    !identifiedReplyBody(bodyField.slice("body=".length)) ||
    words.length !== 7
  )
    return undefined;
  const match = /^repos\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/comments$/.exec(endpoint ?? "");
  const resource = match && canonicalTarget(`${match[1]}/${match[2]}`, match[3]!);
  return resource
    ? {
        bodyPresent: true,
        operation: "github.pull-request.conversation-comment",
        resource,
        trailingArguments: [],
        trailingArgumentCount: 0,
      }
    : undefined;
}

function enclosingFieldName(
  ancestors: readonly (ASTNode | readonly ASTNode[])[],
): string | undefined {
  return ancestors.findLast(
    (ancestor): ancestor is Extract<ASTNode, { readonly kind: typeof Kind.FIELD }> =>
      "kind" in ancestor && ancestor.kind === Kind.FIELD,
  )?.name.value;
}

function normalizedReviewThreadsDocument(document: DocumentNode): DocumentNode | undefined {
  let valid = true;
  const normalized = visit(document, {
    Field(node, _key, _parent, _path, ancestors) {
      const parentField = enclosingFieldName(ancestors);
      if (node.name.value === "pageInfo" && parentField === "reviewThreads") return null;
      if (node.name.value !== "reviewThreads" && node.name.value !== "comments") return undefined;
      const first = node.arguments?.find((argument) => argument.name.value === "first");
      if (!first || first.value.kind !== Kind.INT || !node.selectionSet) {
        valid = false;
        return undefined;
      }
      return {
        ...node,
        arguments: node.arguments?.map((argument) =>
          argument.name.value === "first"
            ? { ...argument, value: { kind: Kind.INT, value: "1" } }
            : argument,
        ),
        selectionSet:
          node.name.value === "comments"
            ? { ...node.selectionSet, selections: [] }
            : node.selectionSet,
      };
    },
  });
  return valid ? normalized : undefined;
}

function isReviewedReviewThreadsQuery(
  queryField: string | undefined,
  reviewedQuery = reviewThreadsQuery,
): boolean {
  if (!queryField?.startsWith("query=")) return false;
  try {
    const candidate = normalizedReviewThreadsDocument(
      parse(queryField.slice("query=".length), { noLocation: true }),
    );
    const reviewed = normalizedReviewThreadsDocument(parse(reviewedQuery, { noLocation: true }));
    return (
      candidate !== undefined &&
      reviewed !== undefined &&
      JSON.stringify(candidate) === JSON.stringify(reviewed)
    );
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
    !bodyField?.startsWith("body=") ||
    !identifiedReplyBody(bodyField.slice("body=".length)) ||
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
  const [gh, api, graphql, ...fields] = command;
  if (gh !== "gh" || api !== "api" || graphql !== "graphql") return undefined;
  const reviewedPagination =
    pagination.length === 2 && pagination.includes("--paginate") && pagination.includes("--slurp");
  const reviewedValues = reviewedPagination
    ? exactFields(fields, {
        owner: { flag: "-f", value: /^[A-Za-z0-9_.-]+$/ },
        pr: { flag: "-F", value: /^[1-9][0-9]*$/ },
        query: { flag: "-f", value: /^[\s\S]+$/ },
        repo: { flag: "-f", value: /^[A-Za-z0-9_.-]+$/ },
      })
    : undefined;
  const watcherValues =
    pagination.length === 0
      ? exactFields(fields, {
          ...(fields.length === 10 ? { cursor: { flag: "-F", value: /^\S+$/ } } : {}),
          name: { flag: "-F", value: /^[A-Za-z0-9_.-]+$/ },
          number: { flag: "-F", value: /^[1-9][0-9]*$/ },
          owner: { flag: "-F", value: /^[A-Za-z0-9_.-]+$/ },
          query: { flag: "-f", value: /^[\s\S]+$/ },
        })
      : undefined;
  const values = reviewedValues ?? watcherValues;
  const query = values?.query;
  const reviewedQuery = watcherValues ? watcherReviewThreadsQuery : reviewThreadsQuery;
  if (
    !values ||
    !query ||
    (!isReviewedReviewThreadsQuery(`query=${query}`, reviewedQuery) &&
      (watcherValues ||
        !isReviewedReviewThreadsQuery(`query=${query}`, flexibleReviewThreadsQuery)))
  )
    return undefined;
  const owner = values.owner;
  const name = values.repo ?? values.name;
  const pullRequestNumber = values.pr ?? values.number;
  if (!owner || !name || !pullRequestNumber || Number(pullRequestNumber) > 2_147_483_647) {
    return undefined;
  }
  return {
    bodyPresent: false,
    operation: "github.pull-request.review-threads",
    resource: canonicalTarget(`${owner}/${name}`, pullRequestNumber)!,
    trailingArguments: [],
    trailingArgumentCount: 0,
  };
}

function reviewThreadCommentsOperation(
  words: readonly string[],
  reviewThreadLookup: ReviewThreadLookup,
): PullRequestOperation | undefined {
  const pagination = words.filter((word) => word === "--paginate" || word === "--slurp");
  const command = words.filter((word) => word !== "--paginate" && word !== "--slurp");
  const [gh, api, graphql, queryFlag, queryField, idFlag, idField] = command;
  const reviewedInvalid =
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
    !pagination.includes("--slurp");
  if (!reviewedInvalid) {
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
  if (gh !== "gh" || api !== "api" || graphql !== "graphql" || pagination.length !== 0)
    return undefined;
  const values = exactFields(command.slice(3), {
    cursor: { flag: "-F", value: /^\S+$/ },
    query: { flag: "-f", value: /^[\s\S]+$/ },
    threadId: { flag: "-F", value: /^PRRT_[A-Za-z0-9_-]+$/ },
  });
  if (
    !values ||
    !isReviewedReviewThreadsQuery(`query=${values.query}`, watcherReviewThreadCommentsQuery)
  )
    return undefined;
  const resource = reviewThreadLookup(values.threadId!);
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
  pullRequestLookup: PullRequestLookup = liveCurrentPullRequest,
  runLookup: RunLookup = liveRunTarget,
  jobLookup: JobLookup = liveJobBelongsToRun,
): PullRequestOperation | undefined {
  const words = input(candidate).command?.words;
  if (!Array.isArray(words) || !words.every((word) => typeof word === "string")) return undefined;
  return (
    watcherPullRequestViewOperation(words, pullRequestLookup) ??
    conversationCommentOperation(words) ??
    pullRequestRestReadOperation(words) ??
    pullRequestChecksOperation(words, pullRequestLookup) ??
    actionsReadOperation(words, pullRequestLookup, runLookup) ??
    workflowRunOperation(words, pullRequestLookup, runLookup, jobLookup) ??
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
