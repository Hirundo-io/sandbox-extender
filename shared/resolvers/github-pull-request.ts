export type GitHubPullRequestResolverInput = {
  readonly requestArguments?: Readonly<Record<string, unknown>>;
};

function resolverInput(candidate: unknown): GitHubPullRequestResolverInput {
  if (typeof candidate !== "object" || candidate === null) return {};
  const requestArguments = (candidate as Record<string, unknown>).requestArguments;
  return {
    requestArguments: typeof requestArguments === "object" && requestArguments !== null
      ? requestArguments as Readonly<Record<string, unknown>>
      : undefined,
  };
}

function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let hasWord = false;

  for (const character of command) {
    if (escaped) {
      word += character;
      escaped = false;
      hasWord = true;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      hasWord = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
      hasWord = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      hasWord = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (hasWord) words.push(word);
      word = "";
      hasWord = false;
      continue;
    }
    word += character;
    hasWord = true;
  }

  if (quote || escaped || !hasWord) return undefined;
  words.push(word);
  return words;
}

function canonicalPullRequestTarget(number: string, ownerAndName: string): string | undefined {
  if (!/^[1-9][0-9]*$/.test(number)) return undefined;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ownerAndName)) return undefined;
  return `github:pull-request:${ownerAndName.toLowerCase()}#${number}`;
}

function inspectionTarget(words: readonly string[]): string | undefined {
  const [gh, pr, subcommand, number, repoFlag, ownerAndName, ...options] = words;
  if (gh !== "gh" || pr !== "pr" || !["view", "diff", "checks"].includes(subcommand ?? "")) {
    return undefined;
  }
  if (!number || !ownerAndName || repoFlag !== "--repo" || options.length > 1 || (options.length === 1 &&
    (subcommand !== "checks" || options[0] !== "--watch"))) {
    return undefined;
  }
  return canonicalPullRequestTarget(number, ownerAndName);
}

function commentTarget(words: readonly string[]): string | undefined {
  const [gh, pr, subcommand, number, repoFlag, ownerAndName, bodyFlag, body] = words;
  if (!number || !ownerAndName || !body || words.length !== 8 || gh !== "gh" || pr !== "pr" || subcommand !== "comment" ||
    repoFlag !== "--repo" || bodyFlag !== "--body") {
    return undefined;
  }
  return canonicalPullRequestTarget(number, ownerAndName);
}

function resolvePullRequest(command: string): string | undefined {
  const words = shellWords(command);
  if (!words) return undefined;
  return inspectionTarget(words) ?? commentTarget(words);
}

export function resolveGitHubPullRequestTarget(candidate: unknown): string | undefined {
  const input = resolverInput(candidate);
  const command = input.requestArguments?.command;
  return typeof command === "string" ? resolvePullRequest(command) : undefined;
}

async function main(): Promise<void> {
  const target = resolveGitHubPullRequestTarget(await Bun.stdin.json());
  if (!target) process.exit(1);
  console.log(target);
}

if (import.meta.main) await main();
