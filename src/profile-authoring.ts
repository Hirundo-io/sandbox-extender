import { profileIdSchema } from "./schemas.js";
import { parseShellCommands } from "./shell-parser.js";
import type { NormalizedRequest, ProfileProposal } from "./types.js";

function cedarLiteral(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("request arguments must contain finite JSON numbers");
  }
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(cedarLiteral).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).map(([key, item]) => `${JSON.stringify(key)}: ${cedarLiteral(item)}`).join(", ")}}`;
  }
  throw new Error("request arguments must be JSON values");
}

function cedarEntity(type: string, id: string): string {
  return `${type}::${JSON.stringify(id)}`;
}

function validateProposableRequest(request: NormalizedRequest): void {
  const command = request.arguments.command;
  if (typeof command !== "string") return;
  const commands = parseShellCommands(command);
  if (!commands || commands.length !== 1 || commands[0] !== command) {
    throw new Error("observed shell command cannot be represented as one authorization case");
  }
}

function differentArguments(request: NormalizedRequest): Readonly<Record<string, unknown>> {
  const command = request.arguments.command;
  return typeof command === "string"
    ? { ...request.arguments, command: `${command} --sandbox-extender-different` }
    : { ...request.arguments, sandboxExtenderDifferent: true };
}

/** Creates a deliberately narrow, reviewable starting point from one observed request. */
export function proposeProfile(profileId: string, request: NormalizedRequest): ProfileProposal {
  profileIdSchema.parse(profileId);
  validateProposableRequest(request);

  const action = cedarEntity("Action", request.action);
  const resource = cedarEntity("Target", request.resource);
  const argumentsValue = cedarLiteral(request.arguments);
  return {
    profile: {
      allowedTargets: [request.resource],
      groupings: [
        {
          id: "observed-request",
          policies: {
            allowObservedRequest: `permit(principal, action == ${action}, resource == ${resource}) when { context.arguments == ${argumentsValue} };`,
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
        name: "does not extend to different arguments",
        request: { ...request, arguments: differentArguments(request) },
      },
      {
        expected: "abstain",
        name: "does not extend to another target",
        request: { ...request, resource: `${request.resource}#outside-scope` },
      },
    ],
  };
}
