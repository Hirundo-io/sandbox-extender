import { randomBytes } from "node:crypto";

import { acceptedContent, createRequestStateCodec, inputRequired, type InputRequiredResult, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { ProfileMutationIntent } from "./mutation-authorization.js";
import { redactSensitiveValue } from "./policy-service.js";

export type MutationApprovalDetails = {
  readonly activationArguments?: Readonly<Record<string, unknown>>;
  readonly policyRevision?: string;
  readonly profileId?: string;
  readonly targets?: readonly string[];
};

type ApprovalState = {
  readonly details: MutationApprovalDetails;
  readonly intent: SanitizedProfileMutationIntent;
  readonly nonce: string;
  readonly threadId: string;
};

type SanitizedProfileMutationIntent = {
  readonly arguments: unknown;
  readonly operation: ProfileMutationIntent["operation"];
};

export type ProfileMutationApproval = {
  readonly approval?: InputRequiredResult;
  readonly nonce: string;
};

const approvalResponseSchema = z.object({ approve: z.literal(true) }).strict();
const requestStateCodec = createRequestStateCodec<ApprovalState>({
  bind: (ctx) => ctx.mcpReq.method,
  key: randomBytes(32),
  ttlSeconds: 120,
});

export const verifyProfileMutationRequestState = requestStateCodec.verify;

const claimedNonces = new Map<string, number>();

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pruneClaimedNonces(now: number): void {
  for (const [nonce, expiresAt] of claimedNonces) {
    if (expiresAt <= now) claimedNonces.delete(nonce);
  }
}

function claimNonce(nonce: string): void {
  const now = Date.now();
  pruneClaimedNonces(now);
  if (claimedNonces.has(nonce)) throw new Error("profile mutation approval has already been used");
  claimedNonces.set(nonce, now + 120_000);
}

function canonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value === "object" && isPlainRecord(value)) {
    const record = value;
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

function approvalMessage(threadId: string, intent: SanitizedProfileMutationIntent, details: MutationApprovalDetails): string {
  const targets = details.targets?.length ? details.targets.map((target) => JSON.stringify(target)).join(", ") : undefined;
  return [
    "Approve this Sandbox Extender Profile mutation?",
    line("Target Thread", threadId),
    line("Operation", intent.operation),
    line("Operation Arguments", canonicalJson(intent.arguments)),
    line("Profile", details.profileId),
    line("Policy Revision", details.policyRevision),
    line("Activation Arguments", details.activationArguments && canonicalJson(details.activationArguments)),
    line("Targets", targets),
  ].join("\n");
}

function sanitizedApprovalValues(
  intent: ProfileMutationIntent,
  details: MutationApprovalDetails,
): { readonly details: MutationApprovalDetails; readonly intent: SanitizedProfileMutationIntent } {
  return {
    details: redactSensitiveValue(details) as MutationApprovalDetails,
    intent: { arguments: redactSensitiveValue(intent.arguments), operation: intent.operation },
  };
}

export function approvalNonceFor(serverContext: ServerContext): string | undefined {
  const state = serverContext.mcpReq.requestState<ApprovalState>();
  return state?.nonce;
}

function matchesApprovalState(state: ApprovalState, threadId: string, intent: SanitizedProfileMutationIntent, details: MutationApprovalDetails): boolean {
  return state.threadId === threadId &&
    canonicalJson(state.intent) === canonicalJson(intent) &&
    canonicalJson(state.details) === canonicalJson(details);
}

/** Returns an MCP continuation request; only its matching approved retry can mutate. */
export async function requestProfileMutationApproval(
  threadId: string,
  intent: ProfileMutationIntent,
  details: MutationApprovalDetails,
  serverContext: ServerContext,
): Promise<ProfileMutationApproval> {
  canonicalJson(intent);
  canonicalJson(details);
  const sanitized = sanitizedApprovalValues(intent, details);
  const state = serverContext.mcpReq.requestState<ApprovalState>();
  if (state !== undefined) {
    if (!matchesApprovalState(state, threadId, sanitized.intent, sanitized.details)) {
      throw new Error("profile mutation approval retry does not match the original request");
    }
    if (acceptedContent(serverContext.mcpReq.inputResponses, "approval", approvalResponseSchema) === undefined) {
      throw new Error("profile mutation approval was not confirmed");
    }
    claimNonce(state.nonce);
    return { nonce: state.nonce };
  }
  const nonce = randomBytes(16).toString("hex");
  const approval = await inputRequired({
    inputRequests: {
      approval: inputRequired.elicit({
        message: approvalMessage(threadId, sanitized.intent, sanitized.details),
        requestedSchema: {
          type: "object",
          properties: { approve: { type: "boolean", title: "Approve Profile mutation", description: "Allow only the operation and values shown above.", default: false } },
          required: ["approve"],
        },
      }),
    },
    requestState: await requestStateCodec.mint({ details: sanitized.details, intent: sanitized.intent, nonce, threadId }, serverContext),
  });
  return { approval, nonce };
}
