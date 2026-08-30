import { randomBytes } from "node:crypto";

import { acceptedContent, createRequestStateCodec, inputRequired, type InputRequiredResult, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { ProfileMutationIntent } from "./mutation-authorization.js";

export type MutationApprovalDetails = {
  readonly activationArguments?: Readonly<Record<string, unknown>>;
  readonly policyRevision?: string;
  readonly profileId?: string;
  readonly targets?: readonly string[];
};

type ApprovalState = {
  readonly details: MutationApprovalDetails;
  readonly intent: ProfileMutationIntent;
  readonly threadId: string;
};

const approvalResponseSchema = z.object({ approve: z.literal(true) }).strict();
const requestStateCodec = createRequestStateCodec<ApprovalState>({
  bind: (ctx) => ctx.mcpReq.method,
  key: randomBytes(32),
  ttlSeconds: 120,
});

function canonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalJsonValue(record[key])]));
  }
  throw new Error("mutation arguments must contain only JSON values");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function line(label: string, value: string | undefined): string {
  return `${label}: ${value ?? "(not applicable)"}`;
}

function approvalMessage(intent: ProfileMutationIntent, details: MutationApprovalDetails): string {
  const targets = details.targets?.length ? details.targets.map((target) => JSON.stringify(target)).join(", ") : undefined;
  return [
    "Approve this Sandbox Extender Profile mutation?",
    line("Operation", intent.operation),
    line("Operation Arguments", canonicalJson(intent.arguments)),
    line("Profile", details.profileId),
    line("Policy Revision", details.policyRevision),
    line("Activation Arguments", details.activationArguments && canonicalJson(details.activationArguments)),
    line("Targets", targets),
  ].join("\n");
}

function matchesApprovalState(state: ApprovalState, threadId: string, intent: ProfileMutationIntent, details: MutationApprovalDetails): boolean {
  return state.threadId === threadId &&
    canonicalJson(state.intent) === canonicalJson(intent) &&
    canonicalJson(state.details) === canonicalJson(details);
}

/** Returns an MCP continuation request; only its matching approved retry can mutate. */
export async function requestProfileMutationApproval(
  threadId: string,
  intent: ProfileMutationIntent,
  details: MutationApprovalDetails,
  ctx: ServerContext,
): Promise<InputRequiredResult | undefined> {
  const state = ctx.mcpReq.requestState<ApprovalState>();
  if (state !== undefined) {
    if (!matchesApprovalState(state, threadId, intent, details)) {
      throw new Error("profile mutation approval retry does not match the original request");
    }
    if (acceptedContent(ctx.mcpReq.inputResponses, "approval", approvalResponseSchema) === undefined) {
      throw new Error("profile mutation approval was not confirmed");
    }
    return undefined;
  }
  return inputRequired({
    inputRequests: {
      approval: inputRequired.elicit({
        message: approvalMessage(intent, details),
        requestedSchema: {
          type: "object",
          properties: { approve: { type: "boolean", title: "Approve Profile mutation", description: "Allow only the operation and values shown above.", default: false } },
          required: ["approve"],
        },
      }),
    },
    requestState: await requestStateCodec.mint({ details, intent, threadId }, ctx),
  });
}
