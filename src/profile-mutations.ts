import type { ProfileMutationIntent } from "./mutation-authorization.js";
import { PolicyRepository } from "./policy-repository.js";
import { proposeProfile } from "./profile-authoring.js";
import {
  activatePreparedProfile,
  disablePreparedProfile,
  prepareProfileActivation,
} from "./policy-service.js";
import type { MutationApprovalDetails } from "./profile-mutation-approval.js";

export type PreparedProfileMutation = {
  readonly approvalDetails: MutationApprovalDetails;
  readonly execute: () => Promise<string>;
};

export async function prepareProfileMutation(
  repository: PolicyRepository,
  threadId: string,
  intent: ProfileMutationIntent,
): Promise<PreparedProfileMutation> {
  switch (intent.operation) {
    case "initialize_policy_repository":
      return {
        approvalDetails: {},
        execute: async () => {
          await repository.initialize();
          return `Initialized policy repository at ${repository.root}.`;
        },
      };
    case "propose_profile":
      return {
        approvalDetails: {
          profileId: intent.arguments.profileId,
          targets: [intent.arguments.resource],
        },
        execute: async () => {
          const proposal = await proposeProfile(intent.arguments.profileId, {
            ...intent.arguments,
            threadId,
          });
          await repository.writeProposal(proposal);
          return `Wrote proposal ${intent.arguments.profileId}. Review proposals/${intent.arguments.profileId}.json and tests/${intent.arguments.profileId}.json before promoting it to profiles/.`;
        },
      };
    case "promote_profile":
      return {
        approvalDetails: {
          policyRevision: intent.arguments.policyRevision,
          profileId: intent.arguments.profileId,
        },
        execute: async () => {
          await repository.promoteProposal(
            intent.arguments.profileId,
            intent.arguments.policyRevision,
          );
          return `Promoted ${intent.arguments.profileId}. It remains inactive until explicitly activated.`;
        },
      };
    case "activate_profile": {
      const activation = await prepareProfileActivation(
        repository,
        intent.arguments.profileId,
        intent.arguments.arguments,
      );
      return {
        approvalDetails: {
          activationArguments: intent.arguments.arguments,
          policyRevision: activation.profile.policyRevision,
          profileId: intent.arguments.profileId,
          targets: activation.targets,
        },
        execute: async () => {
          const allowedTargets = await activatePreparedProfile(repository, threadId, activation);
          return JSON.stringify({
            message: `Activated ${intent.arguments.profileId} for ${threadId}.`,
            allowedTargets,
            sessionContext: activation.profile.sessionContext ?? [],
          });
        },
      };
    }
    case "disable_profile": {
      const binding = (await repository.readState())[threadId];
      return {
        approvalDetails:
          binding !== undefined
            ? {
                policyRevision: binding.policyRevision,
                profileId: binding.profileId,
                targets: binding.allowedTargets,
              }
            : {},
        execute: async () => {
          await disablePreparedProfile(repository, threadId, binding);
          return `Disabled the profile for ${threadId}.`;
        },
      };
    }
  }
}
