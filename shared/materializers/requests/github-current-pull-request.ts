type MaterializerInput = {
  readonly workingDirectory?: unknown;
};

type PullRequestFacts = {
  readonly context: {
    readonly lookup: "gh.pr.view";
    readonly number: number;
    readonly url: string;
  };
  readonly resource: string;
};

type CommandOutput = {
  readonly code: number;
  readonly stdout: Uint8Array;
};

type RunGh = (workingDirectory: string) => CommandOutput;

function input(candidate: unknown): MaterializerInput {
  return typeof candidate === "object" && candidate !== null
    ? { workingDirectory: (candidate as Record<string, unknown>).workingDirectory }
    : {};
}

function runGh(workingDirectory: string): CommandOutput {
  return new Deno.Command("gh", {
    args: ["pr", "view", "--json", "number,url"],
    cwd: workingDirectory,
    stderr: "null",
    stdout: "piped",
  }).outputSync();
}

function pullRequestTarget(url: string, number: number): string | undefined {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/.exec(url);
  return match && Number(match[3]) === number
    ? `github:pull-request:${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}#${number}`
    : undefined;
}

export function materializeGitHubCurrentPullRequest(
  candidate: unknown,
  execute: RunGh = runGh,
): PullRequestFacts | undefined {
  const workingDirectory = input(candidate).workingDirectory;
  if (typeof workingDirectory !== "string" || workingDirectory.length === 0) return undefined;
  const result = execute(workingDirectory);
  if (result.code !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(result.stdout));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { number, url } = parsed as Record<string, unknown>;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || typeof url !== "string") return undefined;
    const resource = pullRequestTarget(url, number);
    return resource ? { context: { lookup: "gh.pr.view", number, url }, resource } : undefined;
  } catch {
    return undefined;
  }
}

export async function runGitHubCurrentPullRequestMaterializer(
  candidate: Promise<unknown>,
  write: (value: string) => void = console.log,
): Promise<boolean> {
  const materialized = materializeGitHubCurrentPullRequest(await candidate);
  if (!materialized) return false;
  write(JSON.stringify(materialized));
  return true;
}

if (import.meta.main && !await runGitHubCurrentPullRequestMaterializer(new Response(Deno.stdin.readable).json())) {
  Deno.exit(1);
}
