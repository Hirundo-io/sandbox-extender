type MaterializerInput = {
  readonly command?: { readonly words?: unknown };
  readonly resource?: unknown;
  readonly workingDirectory?: unknown;
};

type RepositoryOperation = {
  readonly argumentsSafe: boolean;
  readonly duplicateOptionCount: number;
  readonly localSafe: boolean;
  readonly operation: string;
  readonly remoteSafe: boolean;
  readonly resource: string;
};

type CommandOutput = {
  readonly code: number;
  readonly stdout: Uint8Array;
};

type RunGit = (arguments_: readonly string[]) => CommandOutput;

type DenoCommand = new (
  command: string,
  options: {
    readonly args: string[];
    readonly clearEnv: true;
    readonly stderr: "null";
    readonly stdout: "piped";
  },
) => { outputSync(): CommandOutput };

function toMaterializerInput(candidate: unknown): MaterializerInput {
  if (typeof candidate !== "object" || candidate === null) return {};
  const candidateRecord = candidate as Record<string, unknown>;
  const command =
    typeof candidateRecord.command === "object" && candidateRecord.command !== null
      ? (candidateRecord.command as { readonly words?: unknown })
      : undefined;
  return {
    command,
    resource: candidateRecord.resource,
    workingDirectory: candidateRecord.workingDirectory,
  };
}

function isDenseStringArray(candidate: unknown): candidate is string[] {
  if (!Array.isArray(candidate)) return false;
  for (let index = 0; index < candidate.length; index += 1) {
    if (typeof candidate[index] !== "string") return false;
  }
  return true;
}

function duplicateLongOptionCount(words: readonly string[]): number {
  const options = words
    .filter((word) => word.startsWith("--"))
    .map((word) => word.split("=", 1)[0]);
  return options.length - new Set(options).size;
}

function gitRemoteArgument(
  words: readonly string[],
): { readonly argumentsSafe: boolean; readonly remote: string } | undefined {
  if (words[1] === "fetch") {
    return words.length === 4 && words[2] === "--dry-run" && !words[3]?.startsWith("-")
      ? { argumentsSafe: true, remote: words[3]! }
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
  return remote && !remote.startsWith("-")
    ? {
        argumentsSafe: !words.slice(index + 1).some((pattern) => pattern.startsWith("-")),
        remote,
      }
    : undefined;
}

function localGitOperation(words: readonly string[]): string | undefined {
  const command = words[1];
  const arguments_ = words.slice(2);
  if (
    command === "status" &&
    (arguments_.length === 0 || arguments_.every((value) => value === "--short"))
  ) {
    return "git.status";
  }
  if (
    command === "diff" &&
    (arguments_.length === 0 ||
      arguments_.every((value) => value === "--check" || value === "--name-only"))
  ) {
    return "git.diff";
  }
  if (command === "branch" && arguments_.length === 1 && arguments_[0] === "--show-current") {
    return "git.branch";
  }
  if (
    command === "config" &&
    arguments_.length === 2 &&
    arguments_[0] === "--get" &&
    arguments_[1] === "core.hooksPath"
  ) {
    return "git.config";
  }
  if (
    ["log", "show", "rev-parse"].includes(command ?? "") &&
    arguments_.every((value) => !value.startsWith("-"))
  ) {
    return `git.${command}`;
  }
  return undefined;
}

export function runGit(
  arguments_: readonly string[],
  Command: DenoCommand = Deno.Command,
): CommandOutput {
  return new Command("git", {
    args: [...arguments_],
    // Repository-local config is still read after `git -C`; ambient Git overrides are excluded.
    clearEnv: true,
    stderr: "null",
    stdout: "piped",
  }).outputSync();
}

function effectiveGitRemote(
  workingDirectory: string,
  remote: string,
  execute: RunGit,
): string | undefined {
  const result = execute(["-C", workingDirectory, "ls-remote", "--get-url", "--", remote]);
  if (result.code !== 0) return undefined;
  const effectiveRemote = new TextDecoder().decode(result.stdout).trim();
  return effectiveRemote.length > 0 && !effectiveRemote.includes("\n")
    ? effectiveRemote
    : undefined;
}

function isGitHubHost(hostname: string): boolean {
  return hostname === "github.com" || hostname.endsWith(".github.com");
}

function isSafeGitRemote(remote: string | undefined): boolean {
  if (!remote || /^[A-Za-z][A-Za-z0-9+.-]*::/.test(remote)) return false;
  if (/^(?:https?|ssh|git):\/\//.test(remote)) {
    try {
      const url = new URL(remote);
      return url.password.length === 0 && isGitHubHost(url.hostname.toLowerCase());
    } catch {
      return false;
    }
  }
  const scp =
    /^(?:[A-Za-z0-9._][A-Za-z0-9._-]*@)?([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):[A-Za-z0-9._~/%+-]+(?:\/[A-Za-z0-9._~/%+-]+)*$/.exec(
      remote,
    );
  return Boolean(scp && isGitHubHost(scp[1]!.toLowerCase()));
}

function gitOperation(
  localTarget: string,
  workingDirectory: string,
  words: readonly string[],
  execute: RunGit,
): RepositoryOperation | undefined {
  const localOperation = localGitOperation(words);
  if (localOperation) {
    return {
      argumentsSafe: true,
      duplicateOptionCount: duplicateLongOptionCount(words),
      localSafe: localTarget === workingDirectory,
      operation: localOperation,
      remoteSafe: false,
      resource: localTarget,
    };
  }
  const parsed = gitRemoteArgument(words);
  if (!parsed) return undefined;
  return {
    argumentsSafe: parsed.argumentsSafe,
    duplicateOptionCount: duplicateLongOptionCount(words),
    localSafe: false,
    operation: `git.${words[1]}`,
    remoteSafe: isSafeGitRemote(effectiveGitRemote(workingDirectory, parsed.remote, execute)),
    resource: localTarget,
  };
}

function repositoryOption(words: readonly string[]): string | undefined {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === "--repo") return words[index + 1];
    if (word.startsWith("--repo=")) return word.slice("--repo=".length);
  }
  return undefined;
}

function githubOperation(words: readonly string[]): RepositoryOperation | undefined {
  const repository = repositoryOption(words);
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return undefined;
  return {
    argumentsSafe: true,
    duplicateOptionCount: duplicateLongOptionCount(words),
    localSafe: false,
    operation: `github.${words[1] ?? "unknown"}.${words[2] ?? "unknown"}`,
    remoteSafe: true,
    resource: `github:repository:${repository.toLowerCase()}`,
  };
}

export function materializeRepository(
  candidate: unknown,
  execute: RunGit = runGit,
): RepositoryOperation | undefined {
  const materializerInput = toMaterializerInput(candidate);
  const words = materializerInput.command?.words;
  if (
    typeof materializerInput.resource !== "string" ||
    typeof materializerInput.workingDirectory !== "string" ||
    !isDenseStringArray(words)
  )
    return undefined;
  if (words[0] === "git")
    return gitOperation(
      materializerInput.resource,
      materializerInput.workingDirectory,
      words,
      execute,
    );
  if (words[0] === "gh") return githubOperation(words);
  return undefined;
}

export async function runRepositoryMaterializer(
  candidate: Promise<unknown>,
  write: (value: string) => void = console.log,
): Promise<boolean> {
  const materialized = materializeRepository(await candidate);
  if (!materialized) return false;
  const { resource, ...context } = materialized;
  write(JSON.stringify({ context, resource }));
  return true;
}

// prettier-ignore
void (import.meta.main && Deno.exit((await runRepositoryMaterializer(new Response(Deno.stdin.readable).json())) ? 0 : 1));
