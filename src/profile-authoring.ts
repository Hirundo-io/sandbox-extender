import { profileIdSchema } from "./schemas.js";
import {
  activationMaterializerSchema,
  authorizationTestSchema,
  cedarGroupingSchema,
  materializerPermissionManifestSchema,
  requestMaterializerSchema,
} from "./schemas.js";
import { compileShell } from "./shell-parser.js";
import { assertSelfContainedMaterializer, materializerIntegrity } from "./materializer-policy.js";
import { validateCedarGrouping } from "./cedar.js";
import type { CompleteProfileDefinition, NormalizedRequest, ProfileProposal } from "./types.js";

const supportedDenoVersion = "2.8.1";

type AuthoredMaterializer = NonNullable<CompleteProfileDefinition["activationMaterializer"]>;
type CompleteAuthorizationTest = Omit<ProfileProposal["tests"][number], "request"> & {
  readonly request: Omit<NormalizedRequest, "threadId">;
};

function authoredMaterializer(
  kind: "activation" | "requests",
  profileId: string,
  value: AuthoredMaterializer,
): NonNullable<ProfileProposal["profile"]["activationMaterializer"]> {
  if (!value) throw new Error("missing materializer");
  materializerPermissionManifestSchema.parse(value.permissions);
  if (value.runtimeVersion !== supportedDenoVersion)
    throw new Error(`unsupported Deno runtime version ${value.runtimeVersion}`);
  assertSelfContainedMaterializer(value.source);
  const materializer = {
    file: `materializers/${kind}/${profileId}.ts`,
    integrity: materializerIntegrity(value.source, value.permissions, value.runtimeVersion),
    language: "typescript" as const,
    permissions: value.permissions,
    runtimeVersion: value.runtimeVersion,
  };
  (kind === "activation" ? activationMaterializerSchema : requestMaterializerSchema).parse(
    materializer,
  );
  return materializer;
}

/** Builds a complete proposal while deriving all executable file names and integrity values. */
export function proposeCompleteProfile(
  profile: CompleteProfileDefinition,
  tests: readonly CompleteAuthorizationTest[],
): ProfileProposal {
  profileIdSchema.parse(profile.id);
  if (profile.policyRevision !== "pending-review")
    throw new Error("complete proposals must remain pending-review");
  if (!profile.groupings.length) throw new Error("profile must contain at least one grouping");
  for (const grouping of profile.groupings) {
    cedarGroupingSchema.parse(grouping);
    validateCedarGrouping(grouping);
  }
  const activationMaterializer =
    profile.activationMaterializer &&
    authoredMaterializer("activation", profile.id, profile.activationMaterializer);
  const requestMaterializer =
    profile.requestMaterializer &&
    authoredMaterializer("requests", profile.id, profile.requestMaterializer);
  const {
    activationMaterializer: _activation,
    requestMaterializer: _request,
    ...profileDefinition
  } = profile;
  const proposal: ProfileProposal = {
    profile: {
      ...profileDefinition,
      ...(activationMaterializer ? { activationMaterializer } : {}),
      ...(requestMaterializer ? { requestMaterializer } : {}),
    },
    tests: tests.map((test) => ({
      ...test,
      request: { ...test.request, threadId: "proposal-test" },
    })),
  };
  for (const test of proposal.tests)
    authorizationTestSchema.parse({
      ...test,
      request: {
        action: test.request.action,
        arguments: test.request.arguments,
        resource: test.request.resource,
      },
    });
  return proposal;
}

function cedarLiteral(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("request arguments must contain finite JSON numbers");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(cedarLiteral).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${JSON.stringify(key)}: ${cedarLiteral(item)}`)
      .join(", ")}}`;
  }
  throw new Error("request arguments must be JSON values");
}

function cedarEntity(type: string, id: string): string {
  return `${type}::${JSON.stringify(id)}`;
}

async function validateProposableRequest(request: NormalizedRequest): Promise<void> {
  const command = request.arguments.command;
  if (typeof command !== "string") return;
  const segments = await compileShell(command);
  if (!segments || segments.length !== 1 || segments[0]?.source !== command) {
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
export async function proposeProfile(
  profileId: string,
  request: NormalizedRequest,
): Promise<ProfileProposal> {
  profileIdSchema.parse(profileId);
  await validateProposableRequest(request);

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
