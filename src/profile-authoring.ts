import { profileIdSchema } from "./schemas.js";
import type { NormalizedRequest, ProfileProposal } from "./types.js";

/** Creates a deliberately narrow, reviewable starting point from one observed request. */
export function proposeProfile(profileId: string, request: NormalizedRequest): ProfileProposal {
  profileIdSchema.parse(profileId);

  const action = cedarEntity("Action", request.action);
  const resource = cedarEntity("Target", request.resource);
  const argumentsValue = cedarLiteral(request.arguments);
  return {
    profile: {
      allowedTargets: [request.resource],
      groupings: [
        {
          id: "observed-request",
          policies: {
            allowObservedRequest: `permit(principal, action == ${action}, resource == ${resource}) when { context.arguments == ${argumentsValue} };`,
          },
        },
      ],
      id: profileId,
      policyRevision: "pending-review",
    },
    tests: [
      { expected: "allow", name: "allows the observed request", request },
      {
        expected: "abstain",
        name: "does not extend to different arguments",
        request: { ...request, arguments: { ...request.arguments, command: "different" } },
      },
      {
        expected: "abstain",
        name: "does not extend to another target",
        request: { ...request, resource: `${request.resource}#outside-scope` },
      },
    ],
  };
}

function cedarLiteral(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(cedarLiteral).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).map(([key, item]) => `${JSON.stringify(key)}: ${cedarLiteral(item)}`).join(", ")}}`;
  }
  throw new Error("request arguments must be JSON values");
}

function cedarEntity(type: string, id: string): string {
  return `${type}::${JSON.stringify(id)}`;
}
