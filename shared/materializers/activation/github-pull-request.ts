export type GitHubPullRequestActivationArguments = {
  readonly pullRequest?: unknown;
  readonly repository?: unknown;
};

function canonicalTarget(repository: string, pullRequest: number): string | undefined {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(pullRequest) || pullRequest <= 0) return undefined;
  return `github:pull-request:${repository.toLowerCase()}#${pullRequest}`;
}

function activationArguments(candidate: unknown): GitHubPullRequestActivationArguments {
  if (typeof candidate !== "object" || candidate === null) return {};
  const input = candidate as Record<string, unknown>;
  return { pullRequest: input.pullRequest, repository: input.repository };
}

export function materializeGitHubPullRequestActivation(candidate: unknown): string | undefined {
  const input = activationArguments(candidate);
  return typeof input.repository === "string" && typeof input.pullRequest === "number"
    ? canonicalTarget(input.repository, input.pullRequest)
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
