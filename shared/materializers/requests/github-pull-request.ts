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

function input(candidate: unknown): RequestMaterializerInput {
  if (typeof candidate !== "object" || candidate === null) return {};
  const command = "command" in candidate && typeof candidate.command === "object" && candidate.command !== null
    ? candidate.command as { readonly words?: unknown }
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
  if (gh !== "gh" || pr !== "pr" || !subcommand || !number || repoFlag !== "--repo" || !repository) {
    return undefined;
  }
  const resource = canonicalTarget(repository, number);
  if (!resource) return undefined;
  const bodyIndex = rest.indexOf("--body");
  return {
    bodyPresent: bodyIndex >= 0 && typeof rest[bodyIndex + 1] === "string" && rest[bodyIndex + 1]!.length > 0,
    operation: `github.pull-request.${subcommand}`,
    resource,
    trailingArguments: rest,
    trailingArgumentCount: rest.length,
  };
}

function reviewReplyOperation(words: readonly string[]): PullRequestOperation | undefined {
  const [gh, api, methodFlag, method, endpoint, bodyFlag, bodyField] = words;
  if (gh !== "gh" || api !== "api" || methodFlag !== "--method" || method !== "POST" ||
    !endpoint || bodyFlag !== "-f" || words.length !== 7) return undefined;
  const match = /^repos\/([^/]+)\/([^/]+)\/pulls\/([1-9][0-9]*)\/comments\/([1-9][0-9]*)\/replies$/.exec(endpoint);
  if (!match) return undefined;
  const resource = canonicalTarget(`${match[1]}/${match[2]}`, match[3]!);
  return resource
    ? {
        bodyPresent: Boolean(bodyField?.startsWith("body=") && bodyField.length > "body=".length),
        operation: "github.review-comment.reply",
        resource,
        trailingArguments: [],
        trailingArgumentCount: 0,
      }
    : undefined;
}

export function materializeGitHubPullRequest(candidate: unknown): PullRequestOperation | undefined {
  const words = input(candidate).command?.words;
  if (!Array.isArray(words) || !words.every((word) => typeof word === "string")) return undefined;
  return reviewReplyOperation(words) ?? pullRequestOperation(words);
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

if (import.meta.main && !await runGitHubPullRequestMaterializer(new Response(Deno.stdin.readable).json())) {
  Deno.exit(1);
}
