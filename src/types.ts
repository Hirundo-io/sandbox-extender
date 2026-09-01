export type Decision = "allow" | "deny" | "abstain";

export type NormalizedRequest = {
  readonly action: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly resource: string;
  readonly threadId: string;
};

export type EvaluationContext = {
  readonly command?: ShellCommandContext;
  readonly materialized?: Readonly<Record<string, unknown>>;
  readonly policyRevision: string;
  readonly profileId: string;
  readonly request: NormalizedRequest;
  readonly resolvedTarget: string;
};

export type ShellCommandContext = {
  readonly arguments: readonly string[];
  readonly controlFlow?: "for" | "until" | "while";
  readonly executable: string;
  readonly iteration?: number;
  readonly repetition?: "finite" | "potentially-unbounded";
  readonly role?: "condition" | "body";
  readonly subcommand?: string;
  readonly words: readonly string[];
};

export type CapabilityEvaluator = (context: EvaluationContext) => Decision;

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
  readonly activationMaterializer?: ActivationMaterializer;
  readonly allowedTargets: ReadonlySet<string>;
  readonly groupings: readonly PolicyGrouping[];
  readonly id: string;
  readonly policyRevision: string;
  readonly sessionContext?: readonly string[];
  /** Reject shell requests containing more than one executable segment. */
  readonly singleCommand?: true;
  /** Requires exactly one reviewed target before this profile can authorize. */
  readonly targetScope?: "single";
  readonly requestMaterializer?: RequestMaterializer;
};

/** References engineer-reviewed executable code in the Policy Repository. */
type MaterializerReference = {
  readonly file: string;
  /** SHA-256 of the complete self-contained source, permissions, and runtime version. */
  readonly integrity: string;
  readonly language: "typescript";
  readonly permissions: MaterializerPermissionManifest;
  readonly runtimeVersion: string;
  /** Source loaded from and verified against the Profile's reviewed Git revision. */
  readonly reviewedSource?: string;
};

export type MaterializerPermissionManifest = {
  readonly env: readonly string[];
  readonly ffi: readonly string[];
  readonly net: readonly string[];
  readonly read: readonly string[];
  readonly run: readonly string[];
  readonly sys: readonly string[];
  readonly write: readonly string[];
};

export type ActivationMaterializer = MaterializerReference;

export type RequestMaterializer = MaterializerReference;

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
  readonly allowedTargets: readonly string[];
  readonly fingerprint: string;
  readonly policyRevision: string;
  readonly profileId: string;
};

export type ProfileProposal = {
  readonly profile: {
    readonly allowedTargets: readonly string[];
    readonly activationMaterializer?: Omit<ActivationMaterializer, "reviewedSource">;
    readonly groupings: readonly CedarGrouping[];
    readonly id: string;
    readonly policyRevision: string;
    readonly sessionContext?: readonly string[];
    readonly singleCommand?: true;
    readonly targetScope?: "single";
    readonly requestMaterializer?: Omit<RequestMaterializer, "reviewedSource">;
  };
  readonly tests: readonly AuthorizationTest[];
};

export type AuthorizationTest = {
  readonly activationArguments?: Readonly<Record<string, unknown>>;
  readonly expected: Decision;
  readonly name: string;
  readonly request: NormalizedRequest;
};
