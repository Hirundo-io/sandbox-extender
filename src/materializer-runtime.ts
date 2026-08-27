import type {
  ActivationMaterializer,
  NormalizedRequest,
  RequestMaterializer,
  ShellCommandContext,
} from "./types.js";

type ActivationResult = {
  readonly targets: readonly string[];
};

export type RequestMaterialization = {
  readonly context: Readonly<Record<string, unknown>>;
  readonly resource: string;
};

function runMaterializer(
  materializer: ActivationMaterializer | RequestMaterializer,
  input: Readonly<Record<string, unknown>>,
): unknown {
  const process = Bun.spawnSync({
    cmd: materializer.reviewedSource === undefined
      ? ["bun", materializer.file]
      : ["bun", "--eval", materializer.reviewedSource],
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stderr: "ignore",
    stdout: "pipe",
  });
  if (process.exitCode !== 0) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(process.stdout));
  } catch {
    return undefined;
  }
}

function activationResult(candidate: unknown): ActivationResult | undefined {
  if (typeof candidate !== "object" || candidate === null || !("targets" in candidate)) return undefined;
  const targets = candidate.targets;
  if (!Array.isArray(targets) || targets.length === 0 ||
    !targets.every((target) => typeof target === "string" && target.length > 0) ||
    new Set(targets).size !== targets.length) return undefined;
  return { targets };
}

function requestResult(candidate: unknown): RequestMaterialization | undefined {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const result = candidate as Record<string, unknown>;
  if (typeof result.resource !== "string" || result.resource.length === 0 ||
    typeof result.context !== "object" || result.context === null || Array.isArray(result.context)) return undefined;
  return {
    context: result.context as Readonly<Record<string, unknown>>,
    resource: result.resource,
  };
}

export function materializeActivation(
  materializer: ActivationMaterializer,
  arguments_: Readonly<Record<string, unknown>>,
): ActivationResult | undefined {
  try {
    return activationResult(runMaterializer(materializer, arguments_));
  } catch {
    return undefined;
  }
}

export function materializeRequest(
  materializer: RequestMaterializer,
  request: NormalizedRequest,
  workingDirectory: string,
  command?: ShellCommandContext,
): RequestMaterialization | undefined {
  try {
    return requestResult(runMaterializer(materializer, {
      command,
      requestArguments: request.arguments,
      resource: request.resource,
      workingDirectory,
    }));
  } catch {
    return undefined;
  }
}
