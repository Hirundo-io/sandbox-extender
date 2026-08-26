import type { CedarGrouping, PullRequestBinding, TargetResolver } from "./types.js";

const pullRequestTargetPlaceholder = "__SANDBOX_EXTENDER_PULL_REQUEST_TARGET__";
const placeholderEntity = `Target::${JSON.stringify(pullRequestTargetPlaceholder)}`;
const pullRequestReference = /^(?<number>[1-9][0-9]*)$|^(?<repository>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(?<repositoryNumber>[1-9][0-9]*)$/;
const pullRequestUrl = /^https:\/\/github\.com\/(?<repository>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(?<number>[1-9][0-9]*)\/?$/;
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const canonicalPullRequestTargetPattern = /^github:pull-request:[a-z0-9_.-]+\/[a-z0-9_.-]+#[1-9][0-9]*$/;

export type PullRequestCommandRunner = (
  command: readonly string[],
  workspace: string,
) => string | undefined;

type PullRequestBoundProfile = {
  readonly allowedTargets: readonly string[];
  readonly groupings: readonly CedarGrouping[];
  readonly pullRequestBinding: PullRequestBinding;
  readonly targetResolver?: TargetResolver;
  readonly targetScope?: "single";
};

export type MaterializedPullRequestProfile<T extends PullRequestBoundProfile = PullRequestBoundProfile> = Omit<
  T,
  "allowedTargets" | "groupings" | "pullRequestBinding"
> & {
  readonly allowedTargets: [string];
  readonly groupings: T["groupings"];
};

function runPullRequestCommand(
  command: readonly string[],
  workspace: string,
): string | undefined {
  const result = Bun.spawnSync({
    cmd: [...command],
    cwd: workspace,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) return undefined;
  return new TextDecoder().decode(result.stdout).trim();
}

function canonicalPullRequestTarget(repository: string, number: string): string | undefined {
  if (!repositoryName.test(repository) || !/^[1-9][0-9]*$/.test(number)) return undefined;
  return `github:pull-request:${repository.toLowerCase()}#${number}`;
}

function targetFromReviewedPullRequestBinding(binding: PullRequestBinding): string | undefined {
  if (!binding.pullRequest) return undefined;
  const match = pullRequestReference.exec(binding.pullRequest);
  if (!match?.groups?.repository || !match.groups.repositoryNumber) return undefined;
  return canonicalPullRequestTarget(match.groups.repository, match.groups.repositoryNumber);
}

function targetFromPullRequestUrl(output: string | undefined): string | undefined {
  if (!output) return undefined;
  try {
    const value: unknown = JSON.parse(output);
    const url = value && typeof value === "object" && "url" in value
      ? value.url
      : undefined;
    if (typeof url !== "string") return undefined;
    const match = pullRequestUrl.exec(url);
    if (!match?.groups?.repository || !match.groups.number) return undefined;
    return canonicalPullRequestTarget(match.groups.repository, match.groups.number);
  } catch {
    return undefined;
  }
}

function repositoryFromWorkspace(
  workspace: string,
  run: PullRequestCommandRunner,
): string | undefined {
  const output = run(["gh", "repo", "view", "--json", "nameWithOwner"], workspace);
  if (!output) return undefined;
  try {
    const value: unknown = JSON.parse(output);
    const nameWithOwner = value && typeof value === "object" && "nameWithOwner" in value
      ? value.nameWithOwner
      : undefined;
    return typeof nameWithOwner === "string" && repositoryName.test(nameWithOwner)
      ? nameWithOwner
      : undefined;
  } catch {
    return undefined;
  }
}

function isGitWorkspace(workspace: string, run: PullRequestCommandRunner): boolean {
  return Boolean(run(["git", "rev-parse", "--show-toplevel"], workspace));
}

function resolveExplicitPullRequest(
  workspace: string,
  reference: string,
  run: PullRequestCommandRunner,
): string | undefined {
  const match = pullRequestReference.exec(reference);
  if (!match?.groups) return undefined;

  const repository = match.groups.repository ?? repositoryFromWorkspace(workspace, run);
  const number = match.groups.repositoryNumber ?? match.groups.number;
  if (!repository || !number) return undefined;

  const expected = canonicalPullRequestTarget(repository, number);
  const resolved = targetFromPullRequestUrl(run(
    ["gh", "pr", "view", number, "--repo", repository, "--json", "url"],
    workspace,
  ));
  return resolved === expected ? resolved : undefined;
}

/** Resolves a local workspace's active PR or a declared PR reference once at promotion. */
export function resolvePullRequestBinding(
  binding: PullRequestBinding,
  run: PullRequestCommandRunner = runPullRequestCommand,
): string | undefined {
  if (!isGitWorkspace(binding.workspace, run)) return undefined;
  if (binding.pullRequest) {
    return resolveExplicitPullRequest(binding.workspace, binding.pullRequest, run);
  }
  return targetFromPullRequestUrl(run(["gh", "pr", "view", "--json", "url"], binding.workspace));
}

function replaceTargetPlaceholder(
  policy: string | readonly string[],
  target: string,
): { readonly policy: string | readonly string[]; readonly replacements: number } {
  const replace = (value: string): string => value.replaceAll(placeholderEntity, `Target::${JSON.stringify(target)}`);
  const count = (value: string): number => value.split(placeholderEntity).length - 1;
  if (typeof policy === "string") {
    return { policy: replace(policy), replacements: count(policy) };
  }
  return {
    policy: policy.map(replace),
    replacements: policy.reduce((total, line) => total + count(line), 0),
  };
}

function materializeGrouping(
  grouping: CedarGrouping,
  target: string,
): { readonly grouping: CedarGrouping; readonly replacements: number } {
  let replacements = 0;
  const policies: Record<string, string | readonly string[]> = {};
  for (const [id, policy] of Object.entries(grouping.policies)) {
    const materialized = replaceTargetPlaceholder(policy, target);
    policies[id] = materialized.policy;
    replacements += materialized.replacements;
  }
  return { grouping: { ...grouping, policies }, replacements };
}

/** Applies the deterministic portion of PR materialization to a reviewed proposal. */
export function materializePullRequestProfileForTarget<T extends PullRequestBoundProfile>(
  profile: T,
  target: string,
): MaterializedPullRequestProfile<T> {
  if (profile.targetScope !== "single" || profile.allowedTargets.length !== 0 || !profile.targetResolver) {
    throw new Error("a pull-request binding requires one empty target set, single scope, and a target resolver");
  }
  const reviewedTarget = targetFromReviewedPullRequestBinding(profile.pullRequestBinding);
  if (!reviewedTarget || !canonicalPullRequestTargetPattern.test(target) || target !== reviewedTarget) {
    throw new Error("a pull-request binding requires one reviewed owner/repository#number target");
  }

  let replacements = 0;
  const groupings = profile.groupings.map((grouping) => {
    const materialized = materializeGrouping(grouping, target);
    replacements += materialized.replacements;
    return materialized.grouping;
  });
  if (replacements === 0) {
    throw new Error("a pull-request binding must contain the pull-request target placeholder in its Cedar policy");
  }
  const { allowedTargets: _allowedTargets, groupings: _groupings, pullRequestBinding: _binding, ...rest } = profile;
  return { ...rest, allowedTargets: [target], groupings } as MaterializedPullRequestProfile<T>;
}

/**
 * Converts a reviewable PR-binding proposal into a static, single-target profile.
 * The binding is intentionally discarded so activation cannot follow later branch changes.
 */
export function materializePullRequestProfile<T extends PullRequestBoundProfile>(
  profile: T,
  run: PullRequestCommandRunner = runPullRequestCommand,
): MaterializedPullRequestProfile<T> {
  if (profile.targetScope !== "single" || profile.allowedTargets.length !== 0 || !profile.targetResolver) {
    throw new Error("a pull-request binding requires one empty target set, single scope, and a target resolver");
  }
  const target = resolvePullRequestBinding(profile.pullRequestBinding, run);
  if (!target) throw new Error("could not resolve one pull request from the declared workspace");
  return materializePullRequestProfileForTarget(profile, target);
}
