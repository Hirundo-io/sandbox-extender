import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { getActiveProfileHandler, listProfilesHandler } from "./mcp-read-handlers.js";
import type { ProfileMutationIntent } from "./mutation-authorization.js";
import { PolicyRepository } from "./policy-repository.js";
import { approvalNonceFor, requestProfileMutationApproval } from "./profile-mutation-approval.js";
import type { MutationApprovalDetails } from "./profile-mutation-approval.js";
import { prepareProfileMutation } from "./profile-mutations.js";
import type { PreparedProfileMutation } from "./profile-mutations.js";
import { evaluateForThread } from "./policy-service.js";
import { getPolicyRoot } from "./policy-root.js";
import { nonEmptyStringSchema, policyRevisionSchema, profileIdSchema, requestArgumentsSchema } from "./schemas.js";

const policyRoot = getPolicyRoot();
const repository = new PolicyRepository(policyRoot);
const pendingMutations = new Map<string, { expiresAt: number; mutation: PreparedProfileMutation }>();

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function pendingMutationFor(nonce: string): PreparedProfileMutation | undefined {
  const pending = pendingMutations.get(nonce);
  if (pending === undefined) return undefined;
  if (pending.expiresAt <= Date.now()) {
    pendingMutations.delete(nonce);
    return undefined;
  }
  return pending.mutation;
}

function rememberPendingMutation(nonce: string, mutation: PreparedProfileMutation): void {
  pendingMutations.set(nonce, { expiresAt: Date.now() + 120_000, mutation });
}

async function authorizeMutation(threadId: string, intent: ProfileMutationIntent, details: MutationApprovalDetails, serverContext: ServerContext) {
  return requestProfileMutationApproval(threadId, intent, details, serverContext);
}

async function runMutation(threadId: string, intent: ProfileMutationIntent, serverContext: ServerContext) {
  const retryNonce = approvalNonceFor(serverContext);
  const mutation = retryNonce === undefined
    ? await prepareProfileMutation(repository, threadId, intent)
    : pendingMutationFor(retryNonce);
  if (mutation === undefined) throw new Error("profile mutation approval has expired; submit the mutation again");

  const approval = await authorizeMutation(threadId, intent, mutation.approvalDetails, serverContext);
  if (approval.approval !== undefined) {
    rememberPendingMutation(approval.nonce, mutation);
    return approval.approval;
  }
  pendingMutations.delete(approval.nonce);
  return text(await mutation.execute());
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "sandbox-extender", version: "0.1.2" });

  server.registerTool("initialize_policy_repository", {
    description: "Create the local directories used for profiles, proposals, tests, and thread state.", inputSchema: { threadId: nonEmptyStringSchema },
  }, ({ threadId }, serverContext) => runMutation(threadId, { arguments: {}, operation: "initialize_policy_repository" }, serverContext));

  server.registerTool("list_profiles", {
    description: "List reviewed profiles whose stored contents still match their reviewed revision.", inputSchema: {},
  }, () => listProfilesHandler(repository));

  server.registerTool("get_active_profile", {
    description: "Report whether one agent thread has a verified active policy profile, without changing it.", inputSchema: { threadId: nonEmptyStringSchema },
  }, ({ threadId }) => getActiveProfileHandler(repository, threadId));

  server.registerTool("propose_profile", {
    description: "Write a narrow profile proposal and authorization tests from one observed request. It does not activate the profile.",
    inputSchema: { action: nonEmptyStringSchema, arguments: requestArgumentsSchema, profileId: profileIdSchema, resource: nonEmptyStringSchema, threadId: nonEmptyStringSchema },
  }, ({ action, arguments: requestArguments, profileId, resource, threadId }, serverContext) => runMutation(threadId, {
    arguments: { action, arguments: requestArguments, profileId, resource }, operation: "propose_profile",
  }, serverContext));

  server.registerTool("promote_profile", {
    description: "Promote a user-reviewed proposal into an activatable profile. Call only after the user has reviewed the proposal and its tests.",
    inputSchema: { policyRevision: policyRevisionSchema.describe("Reviewed full Git commit ID"), profileId: profileIdSchema, threadId: nonEmptyStringSchema },
  }, ({ policyRevision, profileId, threadId }, serverContext) => runMutation(threadId, {
    arguments: { policyRevision, profileId }, operation: "promote_profile",
  }, serverContext));

  server.registerTool("activate_profile", {
    description: "Activate a reviewed policy profile for one agent thread.", inputSchema: { arguments: requestArgumentsSchema, profileId: profileIdSchema, threadId: nonEmptyStringSchema },
  }, ({ arguments: activationArguments, profileId, threadId }, serverContext) => runMutation(threadId, {
    arguments: { arguments: activationArguments, profileId }, operation: "activate_profile",
  }, serverContext));

  server.registerTool("disable_profile", {
    description: "Disable the active policy profile for one agent thread.", inputSchema: { threadId: nonEmptyStringSchema },
  }, ({ threadId }, serverContext) => runMutation(threadId, { arguments: {}, operation: "disable_profile" }, serverContext));

  server.registerTool("evaluate_request", {
    description: "Evaluate a normalized request against the active profile without executing it.",
    inputSchema: { action: nonEmptyStringSchema, arguments: requestArgumentsSchema, resource: nonEmptyStringSchema, threadId: nonEmptyStringSchema },
  }, async ({ action, arguments: requestArguments, resource, threadId }) => text(JSON.stringify(await evaluateForThread(repository, {
    action, arguments: requestArguments, resource, threadId,
  }))));

  return server;
}

if (import.meta.main) serveStdio(() => buildServer());
