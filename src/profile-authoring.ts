import { profileIdSchema } from "./schemas.js";
import type { NormalizedRequest, ProfileProposal } from "./types.js";

/** Creates a deliberately narrow, reviewable starting point from one observed request. */
export function proposeProfile(profileId: string, request: NormalizedRequest): ProfileProposal {
  profileIdSchema.parse(profileId);

  const action = cedarEntity("Action", request.action);
  const resource = cedarEntity("Target", request.resource);
  return {
    profile: {
      allowedTargets: [request.resource],
      groupings: [
        {
          id: "observed-request",
          policies: {
            allowObservedRequest: `permit(principal, action == ${action}, resource == ${resource});`,
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
        name: "does not extend to another target",
        request: { ...request, resource: `${request.resource}#outside-scope` },
      },
    ],
  };
}

function cedarEntity(type: string, id: string): string {
  return `${type}::${JSON.stringify(id)}`;
}
