export type GitHubRepositoryResolverInput = {
  readonly localTarget?: unknown;
  readonly requestArguments?: Readonly<Record<string, unknown>>;
  readonly workingDirectory?: unknown;
};

function resolverInput(candidate: unknown): GitHubRepositoryResolverInput {
  if (typeof candidate !== "object" || candidate === null) return {};
  const input = candidate as Record<string, unknown>;
  return {
    localTarget: input.localTarget,
    requestArguments: typeof input.requestArguments === "object" && input.requestArguments !== null
      ? input.requestArguments as Readonly<Record<string, unknown>>
      : undefined,
    workingDirectory: input.workingDirectory,
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

function gitRemoteArgument(words: readonly string[]): string | undefined {
  if (words[0] !== "git") return undefined;
  if (words[1] === "fetch") {
    return words.length === 4 && words[2] === "--dry-run" && !words[3]?.startsWith("-")
      ? words[3]
      : undefined;
  }
  if (words[1] !== "ls-remote") return undefined;

  const options = new Set([
    "-b",
    "--branches",
    "--exit-code",
    "--heads",
    "-q",
    "--quiet",
    "--refs",
    "--symref",
    "-t",
    "--tags",
  ]);
  let index = 2;
  while (options.has(words[index] ?? "")) index += 1;
  if (words[index] === "--") index += 1;
  const remote = words[index];
  if (!remote || remote.startsWith("-")) return undefined;
  return words.slice(index + 1).some((pattern) => pattern.startsWith("-"))
    ? undefined
    : remote;
}

function effectiveGitRemote(localTarget: unknown, remote: string): string | undefined {
  if (typeof localTarget !== "string" || !localTarget.startsWith("/")) return undefined;
  const result = Bun.spawnSync({
    cmd: ["git", "-C", localTarget, "ls-remote", "--get-url", "--", remote],
    stderr: "ignore",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) return undefined;
  const effectiveRemote = new TextDecoder().decode(result.stdout).trim();
  return effectiveRemote.length > 0 && !effectiveRemote.includes("\n")
    ? effectiveRemote
    : undefined;
}

function isSafeGitRemote(remote: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(remote)) return false;
  if (/^(?:https?|ssh|git):\/\//.test(remote)) {
    try {
      const url = new URL(remote);
      const hostname = url.hostname;
      const safeHostname = /^\[[0-9A-Fa-f:.]+\]$/.test(hostname) ||
        /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(hostname);
      return safeHostname && url.password.length === 0;
    } catch {
      return false;
    }
  }
  return /^(?:[A-Za-z0-9._][A-Za-z0-9._-]*@)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?:[A-Za-z0-9._~/%+-]+(?:\/[A-Za-z0-9._~/%+-]+)*$/.test(remote);
}

function resolveGitTarget(
  localTarget: unknown,
  workingDirectory: unknown,
  words: readonly string[],
): string | undefined {
  const remote = gitRemoteArgument(words);
  if (!remote) return undefined;
  const effectiveRemote = effectiveGitRemote(workingDirectory, remote);
  return effectiveRemote && isSafeGitRemote(effectiveRemote) && typeof localTarget === "string"
    ? localTarget
    : undefined;
}

function resolveGitHubTarget(command: string): string | undefined {
  const repositoryPattern =
    /(?:^|\s)--repo(?:=|\s+)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?=\s|$)/;
  const repository = command.match(repositoryPattern)?.[1];
  return repository ? `github:repository:${repository.toLowerCase()}` : undefined;
}

export function resolveGitHubRepositoryTarget(candidate: unknown): string | undefined {
  const input = resolverInput(candidate);
  const command = input.requestArguments?.command;
  const words = typeof command === "string" ? shellWords(command) : undefined;
  const target = words?.[0] === "git"
    ? resolveGitTarget(input.localTarget, input.workingDirectory, words)
    : typeof command === "string" && /^\s*gh\b/.test(command)
      ? resolveGitHubTarget(command)
      : input.localTarget;
  return typeof target === "string" && target.length > 0 ? target : undefined;
}

async function main(): Promise<void> {
  const target = resolveGitHubRepositoryTarget(await Bun.stdin.json());
  if (!target) process.exit(1);
  console.log(target);
}

if (import.meta.main) await main();
