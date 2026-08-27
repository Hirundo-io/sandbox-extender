import { ErrorCode, McpError, type ElicitRequestFormParams, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";

import { consumeProfileMutationAuthorization } from "./mutation-authorization.js";
import type { ProfileMutationIntent } from "./mutation-authorization.js";

export type MutationApprovalDetails = {
  readonly activationArguments?: Readonly<Record<string, unknown>>;
  readonly policyRevision?: string;
  readonly profileId?: string;
  readonly targets?: readonly string[];
};

type ElicitApproval = (request: ElicitRequestFormParams) => Promise<ElicitResult>;

type ApprovalDependencies = {
  readonly consumeFallback?: typeof consumeProfileMutationAuthorization;
  readonly elicit: ElicitApproval;
};

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

function isUnsupportedElicitation(error: unknown): boolean {
  return (error instanceof Error && error.message === "Client does not support form elicitation.") ||
    (error instanceof McpError && (error.code === ErrorCode.MethodNotFound ||
      error.code === ErrorCode.InvalidParams && /(?:form.*(?:not supported|unsupported)|(?:not supported|unsupported).*form)/i.test(error.message)));
}

/** Requests host-mediated user approval, with the legacy CLI artifact as a compatibility fallback. */
export async function approveProfileMutation(
  root: string,
  threadId: string,
  intent: ProfileMutationIntent,
  details: MutationApprovalDetails,
  dependencies: ApprovalDependencies,
): Promise<void> {
  let result: ElicitResult;
  try {
    result = await dependencies.elicit({
      mode: "form",
      message: approvalMessage(intent, details),
      requestedSchema: {
        type: "object",
        properties: {
          approve: {
            type: "boolean",
            title: "Approve Profile mutation",
            description: "Allow only the operation and values shown above.",
            default: false,
          },
        },
        required: ["approve"],
      },
    });
  } catch (error) {
    if (!isUnsupportedElicitation(error)) throw error;
    await (dependencies.consumeFallback ?? consumeProfileMutationAuthorization)(root, threadId, intent);
    return;
  }

  if (result.action !== "accept") {
    throw new Error(`profile mutation approval ${result.action}`);
  }
  if (result.content?.approve !== true) {
    throw new Error("profile mutation approval was not confirmed");
  }
}
