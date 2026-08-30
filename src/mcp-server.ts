import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getActiveProfileHandler, listProfilesHandler } from "./mcp-read-handlers.js";
import { PolicyRepository } from "./policy-repository.js";
import type { ProfileMutationIntent } from "./mutation-authorization.js";
import { approveProfileMutation } from "./profile-mutation-approval.js";
import type { MutationApprovalDetails } from "./profile-mutation-approval.js";
import {
  activatePreparedProfile,
  disableProfile,
  evaluateForThread,
  prepareProfileActivation,
} from "./policy-service.js";
import { proposeProfile } from "./profile-authoring.js";
import { getPolicyRoot } from "./policy-root.js";
import {
  nonEmptyStringSchema,
  policyRevisionSchema,
  profileIdSchema,
  requestArgumentsSchema,
} from "./schemas.js";

const policyRoot = getPolicyRoot();
const repository = new PolicyRepository(policyRoot);

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

const server = new McpServer({
  name: "sandbox-extender",
  version: "0.1.2",
});

async function authorizeMutation(
  threadId: string,
  intent: ProfileMutationIntent,
  details: MutationApprovalDetails = {},
): Promise<void> {
  await approveProfileMutation(policyRoot, threadId, intent, details, {
    elicit: server.server.elicitInput.bind(server.server),
  });
}

server.registerTool(
  "initialize_policy_repository",
  {
    description: "Create the local directories used for profiles, proposals, tests, and thread state.",
    inputSchema: { threadId: nonEmptyStringSchema },
  },
  async ({ threadId }) => {
    await authorizeMutation(threadId, {
      arguments: {},
      operation: "initialize_policy_repository",
    }, {});
    await repository.initialize();
    return text(`Initialized policy repository at ${policyRoot}.`);
  },
);

server.registerTool(
  "list_profiles",
  {
    description: "List reviewed profiles whose stored contents still match their reviewed revision.",
    inputSchema: {},
  },
  async () => listProfilesHandler(repository),
);

server.registerTool(
  "get_active_profile",
  {
    description: "Report whether one agent thread has a verified active policy profile, without changing it.",
    inputSchema: { threadId: nonEmptyStringSchema },
  },
  async ({ threadId }) => getActiveProfileHandler(repository, threadId),
);

server.registerTool(
  "propose_profile",
  {
    description: "Write a narrow profile proposal and authorization tests from one observed request. It does not activate the profile.",
    inputSchema: {
      action: nonEmptyStringSchema,
      arguments: requestArgumentsSchema,
      profileId: profileIdSchema,
      resource: nonEmptyStringSchema,
      threadId: nonEmptyStringSchema,
    },
  },
  async ({ action, arguments: requestArguments, profileId, resource, threadId }) => {
    await authorizeMutation(threadId, {
      arguments: {
        action,
        arguments: requestArguments,
        profileId,
        resource,
      },
      operation: "propose_profile",
    }, { profileId, targets: [resource] });
    const proposal = await proposeProfile(profileId, { action, arguments: requestArguments, resource, threadId });
    await repository.writeProposal(proposal);
    return text(`Wrote proposal ${profileId}. Review proposals/${profileId}.json and tests/${profileId}.json before promoting it to profiles/.`);
  },
);

server.registerTool(
  "promote_profile",
  {
    description: "Promote a user-reviewed proposal into an activatable profile. Call only after the user has reviewed the proposal and its tests.",
    inputSchema: {
      policyRevision: policyRevisionSchema.describe("Reviewed full Git commit ID"),
      profileId: profileIdSchema,
      threadId: nonEmptyStringSchema,
    },
  },
  async ({ policyRevision, profileId, threadId }) => {
    await authorizeMutation(threadId, {
      arguments: { policyRevision, profileId },
      operation: "promote_profile",
    }, { policyRevision, profileId });
    await repository.promoteProposal(profileId, policyRevision);
    return text(`Promoted ${profileId}. It remains inactive until explicitly activated.`);
  },
);

server.registerTool(
  "activate_profile",
  {
    description: "Activate a reviewed policy profile for one agent thread.",
    inputSchema: {
      arguments: requestArgumentsSchema,
      profileId: profileIdSchema,
      threadId: nonEmptyStringSchema,
    },
  },
  async ({ arguments: activationArguments, profileId, threadId }) => {
    const activation = await prepareProfileActivation(repository, profileId, activationArguments);
    await authorizeMutation(threadId, {
      arguments: { arguments: activationArguments, profileId },
      operation: "activate_profile",
    }, {
      activationArguments,
      policyRevision: activation.profile.policyRevision,
      profileId,
      targets: activation.targets,
    });
    const allowedTargets = await activatePreparedProfile(repository, threadId, activation);
    return text(JSON.stringify({
      message: `Activated ${profileId} for ${threadId}.`,
      allowedTargets,
      sessionContext: activation.profile.sessionContext ?? [],
    }));
  },
);

server.registerTool(
  "disable_profile",
  {
    description: "Disable the active policy profile for one agent thread.",
    inputSchema: { threadId: nonEmptyStringSchema },
  },
  async ({ threadId }) => {
    const binding = (await repository.readState())[threadId];
    await authorizeMutation(threadId, {
      arguments: {},
      operation: "disable_profile",
    }, binding && {
      policyRevision: binding.policyRevision,
      profileId: binding.profileId,
      targets: binding.allowedTargets,
    });
    await disableProfile(repository, threadId);
    return text(`Disabled the profile for ${threadId}.`);
  },
);

server.registerTool(
  "evaluate_request",
  {
    description: "Evaluate a normalized request against the active profile without executing it.",
    inputSchema: {
      action: nonEmptyStringSchema,
      arguments: requestArgumentsSchema,
      resource: nonEmptyStringSchema,
      threadId: nonEmptyStringSchema,
    },
  },
  async ({ action, arguments: requestArguments, resource, threadId }) => {
    const result = await evaluateForThread(repository, {
      action,
      arguments: requestArguments,
      resource,
      threadId,
    });
    return text(JSON.stringify(result));
  },
);

await server.connect(new StdioServerTransport());
