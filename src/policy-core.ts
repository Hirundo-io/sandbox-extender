import type {
  CedarGrouping,
  DecisionToken,
  EvaluationResult,
  NormalizedRequest,
  Profile,
} from "./types.js";
import { evaluateCedarGrouping } from "./cedar.js";

type ActiveProfile = {
  readonly profile: Profile;
  readonly threadId: string;
};

/**
 * Coordinates profile activation, ordered capability evaluation, and one-time
 * authorization tokens. It intentionally does not execute agent requests.
 */
export class PolicyCore {
  readonly #activeProfiles = new Map<string, ActiveProfile>();
  readonly #tokens = new Map<string, DecisionToken>();

  constructor(private readonly tokenLifetimeMs = 60_000) {
    if (!Number.isSafeInteger(tokenLifetimeMs) || tokenLifetimeMs <= 0) {
      throw new Error("tokenLifetimeMs must be a positive safe integer");
    }
  }

  activate(profile: Profile, threadId: string): void {
    if (!threadId) {
      throw new Error("threadId is required");
    }

    this.#activeProfiles.set(threadId, { profile, threadId });
  }

  disable(threadId: string): void {
    this.#activeProfiles.delete(threadId);
  }

  evaluate(request: NormalizedRequest): EvaluationResult {
    const activeProfile = this.#activeProfiles.get(request.threadId);
    if (!activeProfile) {
      return { decision: "abstain", reason: "no active profile for thread" };
    }

    const { profile } = activeProfile;
    if (!profile.allowedTargets.has(request.resource)) {
      return {
        decision: "abstain",
        reason: "resolved target is outside the allowed target set",
      };
    }

    const context = {
      policyRevision: profile.policyRevision,
      profileId: profile.id,
      request,
      resolvedTarget: request.resource,
    };

    for (const grouping of profile.groupings) {
      const decision = isCedarGrouping(grouping)
        ? evaluateCedarGrouping(grouping, context)
        : grouping.evaluate(context);
      if (decision === "abstain") {
        continue;
      }

      if (decision === "deny") {
        return {
          decision,
          matchedGroupingId: grouping.id,
          reason: "denied by capability grouping",
        };
      }

      const token = this.#issueToken(request, profile.policyRevision);
      return {
        decision,
        matchedGroupingId: grouping.id,
        reason: "allowed by capability grouping",
        token,
      };
    }

    return { decision: "abstain", reason: "no grouping made a decision" };
  }

  consumeToken(tokenId: string, request: NormalizedRequest): boolean {
    const token = this.#tokens.get(tokenId);
    this.#tokens.delete(tokenId);

    return Boolean(
      token &&
        token.expiresAt.getTime() > Date.now() &&
        sameRequest(token.request, request),
    );
  }

  #issueToken(
    request: NormalizedRequest,
    policyRevision: string,
  ): DecisionToken {
    const token: DecisionToken = {
      expiresAt: new Date(Date.now() + this.tokenLifetimeMs),
      id: crypto.randomUUID(),
      policyRevision,
      request,
      resolvedTarget: request.resource,
    };
    this.#tokens.set(token.id, token);
    return token;
  }
}

function isCedarGrouping(
  grouping: Profile["groupings"][number],
): grouping is CedarGrouping {
  return "policies" in grouping;
}

function sameRequest(
  left: NormalizedRequest,
  right: NormalizedRequest,
): boolean {
  return (
    left.action === right.action &&
    left.resource === right.resource &&
    left.threadId === right.threadId &&
    JSON.stringify(left.arguments) === JSON.stringify(right.arguments)
  );
}
