import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PolicyRepository } from "./policy-repository.js";
import { consumeProfileMutationAuthorization } from "./mutation-authorization.js";
import type { ProfileMutationIntent } from "./mutation-authorization.js";
import { activateProfile, disableProfile, evaluateForThread } from "./policy-service.js";
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
): Promise<void> {
  await consumeProfileMutationAuthorization(policyRoot, threadId, intent);
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
    });
    await repository.initialize();
    return text(`Initialized policy repository at ${policyRoot}.`);
  },
);

server.registerTool(
  "list_profiles",
  {
    description: "List reviewed profiles available in a policy repository.",
    inputSchema: {},
  },
  async () => text(JSON.stringify(await repository.listProfiles())),
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
    });
    const proposal = proposeProfile(profileId, { action, arguments: requestArguments, resource, threadId });
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
    });
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
    await authorizeMutation(threadId, {
      arguments: { arguments: activationArguments, profileId },
      operation: "activate_profile",
    });
    const allowedTargets = await activateProfile(repository, threadId, profileId, activationArguments);
    const profile = await repository.loadProfile(profileId);
    return text(JSON.stringify({
      message: `Activated ${profileId} for ${threadId}.`,
      allowedTargets,
      sessionContext: profile.sessionContext ?? [],
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
    await authorizeMutation(threadId, {
      arguments: {},
      operation: "disable_profile",
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
