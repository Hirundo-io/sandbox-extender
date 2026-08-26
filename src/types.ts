export type Decision = "allow" | "deny" | "abstain";

export type NormalizedRequest = {
  readonly action: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly resource: string;
  readonly threadId: string;
};

export type EvaluationContext = {
  readonly command?: ShellCommandContext;
  readonly policyRevision: string;
  readonly profileId: string;
  readonly request: NormalizedRequest;
  readonly resolvedTarget: string;
};

export type ShellCommandContext = {
  readonly arguments: readonly string[];
  readonly executable: string;
  readonly subcommand?: string;
  readonly words: readonly string[];
};

export type CapabilityEvaluator = (
  context: EvaluationContext,
) => Decision;

export type Grouping = {
  readonly evaluate: CapabilityEvaluator;
  readonly id: string;
};

export type CedarGrouping = {
  /** Cedar policy identifiers mapped to policy text or readable source lines. */
  readonly policies: Readonly<Record<string, string | readonly string[]>>;
  readonly id: string;
};

export type PolicyGrouping = Grouping | CedarGrouping;

export type Profile = {
  readonly allowedTargets: ReadonlySet<string>;
  readonly groupings: readonly PolicyGrouping[];
  readonly id: string;
  readonly policyRevision: string;
  readonly sessionContext?: readonly string[];
  /** Requires exactly one reviewed target before this profile can authorize. */
  readonly targetScope?: "single";
  readonly targetResolver?: TargetResolver;
};

/** References engineer-reviewed executable code in the Policy Repository. */
export type TargetResolver = {
  readonly file: string;
  readonly language: "typescript";
  /** Source loaded from and verified against the Profile's reviewed Git revision. */
  readonly reviewedSource?: string;
};

export type PullRequestBinding = {
  /** Absolute local Git workspace used only to resolve this profile at promotion. */
  readonly workspace: string;
  /** An optional active-branch default, a local PR number, or owner/repository#number. */
  readonly pullRequest?: string;
};

export type DecisionToken = {
  readonly expiresAt: Date;
  readonly id: string;
  readonly policyRevision: string;
  readonly request: NormalizedRequest;
  readonly resolvedTarget: string;
  readonly resolvedTargets: readonly string[];
};

export type EvaluationResult = {
  readonly decision: Decision;
  readonly matchedGroupingId?: string;
  readonly matchedGroupingIds?: readonly string[];
  readonly reason: string;
  readonly resolvedTarget?: string;
  readonly resolvedTargets?: readonly string[];
  readonly token?: DecisionToken;
};

export type ProfileBinding = {
  readonly fingerprint: string;
  readonly policyRevision: string;
  readonly profileId: string;
};

export type ProfileProposal = {
  readonly profile: {
    readonly allowedTargets: readonly string[];
    readonly groupings: readonly CedarGrouping[];
    readonly id: string;
    readonly policyRevision: string;
    readonly targetScope?: "single";
    readonly targetResolver?: Omit<TargetResolver, "reviewedSource">;
    /** Proposal-only input materialized into a static PR target during promotion. */
    readonly pullRequestBinding?: PullRequestBinding;
  };
  readonly tests: readonly AuthorizationTest[];
};

export type AuthorizationTest = {
  readonly expected: Decision;
  readonly name: string;
  readonly request: NormalizedRequest;
};
