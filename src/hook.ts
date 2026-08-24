import { PolicyRepository } from "./policy-repository.js";
import { evaluateForThread } from "./policy-service.js";
import type { Decision, NormalizedRequest } from "./types.js";
import { getPolicyRoot } from "./policy-root.js";
import { hookEventSchema, type HookEvent } from "./schemas.js";

export async function handlePermissionRequest(
  event: HookEvent,
  host: "claude" | "codex",
): Promise<Record<string, unknown>> {
  const request = normalizeHookRequest(event, host);
  if (!request) {
    return hookOutput("abstain", host, "policy context is unavailable");
  }

  const repository = new PolicyRepository(getPolicyRoot());
  const result = await evaluateForThread(repository, request);
  return hookOutput(result.decision, host, result.reason);
}

export function normalizeHookRequest(
  event: unknown,
  host: "claude" | "codex",
): NormalizedRequest | undefined {
  const parsedEvent = hookEventSchema.safeParse(event);
  if (!parsedEvent.success) return undefined;

  const { cwd, session_id, sessionId, tool_input, toolInput, tool_name, toolName, working_directory } = parsedEvent.data;
  const threadId = session_id ?? sessionId;
  const toolNameValue = tool_name ?? toolName;
  const resource = cwd ?? working_directory;
  const argumentsValue = tool_input ?? toolInput;
  if (!threadId || !toolNameValue || !resource || !argumentsValue) {
    return undefined;
  }

  return {
    action: `${host}.${toolNameValue}`,
    arguments: argumentsValue,
    resource,
    threadId,
  };
}

function hookOutput(
  decision: Decision,
  host: "claude" | "codex",
  reason: string,
): Record<string, unknown> {
  const permissionDecision =
    decision === "allow" ? "allow" : decision === "deny" ? "deny" : "ask";

  return {
    hookSpecificOutput: { permissionDecision },
    systemMessage: `Sandbox Extender (${host}): ${reason}`,
  };
}
