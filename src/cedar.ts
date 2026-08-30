import { isAuthorized } from "@cedar-policy/cedar-wasm/nodejs";
import type { CedarValueJson } from "@cedar-policy/cedar-wasm/nodejs";

import type {
  CedarGrouping,
  Decision,
  EvaluationContext,
  NormalizedRequest,
} from "./types.js";

/**
 * Evaluates one ordered policy grouping. Invalid policies and unsupported input
 * intentionally abstain: a broken local policy must never create authority.
 */
export function evaluateCedarGrouping(
  grouping: CedarGrouping,
  context: EvaluationContext,
): Decision {
  try {
    const answer = isAuthorized({
      action: entity("Action", context.request.action),
      context: {
        arguments: cedarValue(context.request.arguments),
        ...(context.command ? { command: cedarValue(context.command) } : {}),
        ...(context.materialized ? { materialized: cedarValue(context.materialized) } : {}),
      },
      entities: [],
      policies: { staticPolicies: cedarPolicies(grouping.policies) },
      principal: entity("AgentThread", context.request.threadId),
      resource: entity("Target", context.resolvedTarget),
      validateRequest: false,
    });

    if (answer.type !== "success") {
      return "abstain";
    }

    if (answer.response.decision === "allow") {
      return "allow";
    }

    // Cedar denies an unmatched request as well as an explicit forbid. Its
    // determining-policy list lets a grouping distinguish those cases.
    return answer.response.diagnostics.reason.length === 0 ? "abstain" : "deny";
  } catch {
    return "abstain";
  }
}

function cedarPolicies(
  policies: CedarGrouping["policies"],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(policies).map(([id, source]) => [
      id,
      typeof source === "string" ? source : source.join("\n"),
    ]),
  );
}

function entity(type: string, id: string): { type: string; id: string } {
  return { type, id };
}

function cedarValue(value: unknown): CedarValueJson {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(cedarValue);
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        cedarValue(item),
      ]),
    ) as Record<string, CedarValueJson>;
  }

  throw new Error("request arguments must be JSON values");
}
