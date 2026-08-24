import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PolicyRepository } from "./policy-repository.js";
import { activateProfile, disableProfile, evaluateForThread } from "./policy-service.js";
import { proposeProfile } from "./profile-authoring.js";
import { getPolicyRoot } from "./policy-root.js";
import { nonEmptyStringSchema, profileIdSchema, requestArgumentsSchema } from "./schemas.js";

const policyRoot = getPolicyRoot();
const repository = new PolicyRepository(policyRoot);
const server = new McpServer({
  name: "sandbox-extender",
  version: "0.1.2",
});

server.registerTool(
  "initialize_policy_repository",
  {
    description: "Create the local directories used for profiles, proposals, tests, and thread state.",
    inputSchema: {},
  },
  async () => {
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
      policyRevision: nonEmptyStringSchema.describe("Reviewed policy revision, such as a Git commit ID"),
      profileId: profileIdSchema,
    },
  },
  async ({ policyRevision, profileId }) => {
    await repository.promoteProposal(profileId, policyRevision);
    return text(`Promoted ${profileId}. It remains inactive until explicitly activated.`);
  },
);

server.registerTool(
  "activate_profile",
  {
    description: "Activate a reviewed policy profile for one agent thread.",
    inputSchema: {
      profileId: profileIdSchema,
      threadId: nonEmptyStringSchema,
    },
  },
  async ({ profileId, threadId }) => {
    await activateProfile(repository, threadId, profileId);
    const profile = await repository.loadProfile(profileId);
    return text(JSON.stringify({
      message: `Activated ${profileId} for ${threadId}.`,
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

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

await server.connect(new StdioServerTransport());
