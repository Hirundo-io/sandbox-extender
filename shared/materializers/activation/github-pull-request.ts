import { isAbsolute } from "node:path";

export type GitHubPullRequestActivationArguments = {
  readonly pullRequest?: unknown;
  readonly repository?: unknown;
  readonly workingDirectory?: unknown;
};

type CommandOutput = {
  readonly code: number;
  readonly stdout: Uint8Array;
};

type RunGh = (workingDirectory: string) => CommandOutput;

function canonicalTarget(repository: string, pullRequest: number): string | undefined {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(pullRequest) || pullRequest <= 0) return undefined;
  return `github:pull-request:${repository.toLowerCase()}#${pullRequest}`;
}

function activationArguments(candidate: unknown): GitHubPullRequestActivationArguments {
  if (typeof candidate !== "object" || candidate === null) return {};
  const input = candidate as Record<string, unknown>;
  return {
    pullRequest: input.pullRequest,
    repository: input.repository,
    workingDirectory: input.workingDirectory,
  };
}

function runGh(workingDirectory: string): CommandOutput {
  return new Deno.Command("gh", {
    args: ["pr", "view", "--json", "number,url"],
    cwd: workingDirectory,
    stderr: "null",
    stdout: "piped",
  }).outputSync();
}

function currentPullRequestTarget(workingDirectory: string, execute: RunGh): string | undefined {
  const result = execute(workingDirectory);
  if (result.code !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(result.stdout));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { number, url } = parsed as Record<string, unknown>;
    if (typeof number !== "number" || typeof url !== "string") return undefined;
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/.exec(url);
    return match && Number(match[3]) === number
      ? canonicalTarget(`${match[1]}/${match[2]}`, number)
      : undefined;
  } catch {
    return undefined;
  }
}

export function materializeGitHubPullRequestActivation(
  candidate: unknown,
  execute: RunGh = runGh,
): string | undefined {
  const input = activationArguments(candidate);
  const hasExplicitTarget = input.repository !== undefined || input.pullRequest !== undefined;
  if (hasExplicitTarget) {
    return input.workingDirectory === undefined && typeof input.repository === "string" &&
        typeof input.pullRequest === "number"
      ? canonicalTarget(input.repository, input.pullRequest)
      : undefined;
  }
  return typeof input.workingDirectory === "string" && isAbsolute(input.workingDirectory)
    ? currentPullRequestTarget(input.workingDirectory, execute)
    : undefined;
}

export async function runGitHubPullRequestActivationMaterializer(
  candidate: Promise<unknown>,
  write: (value: string) => void = console.log,
): Promise<boolean> {
  const target = materializeGitHubPullRequestActivation(await candidate);
  if (!target) return false;
  write(JSON.stringify({ targets: [target] }));
  return true;
}

if (import.meta.main && !await runGitHubPullRequestActivationMaterializer(new Response(Deno.stdin.readable).json())) {
  Deno.exit(1);
}
