export type Decision = "allow" | "deny" | "abstain";

export type NormalizedRequest = {
  readonly action: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly resource: string;
  readonly threadId: string;
};

export type EvaluationContext = {
  readonly policyRevision: string;
  readonly profileId: string;
  readonly request: NormalizedRequest;
  readonly resolvedTarget: string;
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
  readonly targetResolver?: TargetResolver;
};

/** Reviewed JavaScript that returns a canonical policy target or undefined. */
export type TargetResolver = {
  readonly file: string;
  readonly language: "javascript";
};

export type DecisionToken = {
  readonly expiresAt: Date;
  readonly id: string;
  readonly policyRevision: string;
  readonly request: NormalizedRequest;
  readonly resolvedTarget: string;
};

export type EvaluationResult = {
  readonly decision: Decision;
  readonly matchedGroupingId?: string;
  readonly reason: string;
  readonly resolvedTarget?: string;
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
  };
  readonly tests: readonly AuthorizationTest[];
};

export type AuthorizationTest = {
  readonly expected: Decision;
  readonly name: string;
  readonly request: NormalizedRequest;
};
