import { isAbsolute, normalize } from "node:path";

type PulumiOperation = { readonly operation: string; readonly resource: string };

function validBackend(value: string): boolean {
  return /^(?:gs|s3|azblob|https|file):\/\/[^\s?#@]+$/.test(value);
}

function pulumiTarget(workspace: string, stack: string, backend: string): string {
  return `pulumi:${JSON.stringify([workspace, stack, backend])}`;
}

export function materializePulumiRequest(candidate: unknown): PulumiOperation | undefined {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const input = candidate as Record<string, unknown>;
  const words = (input.command as { words?: unknown } | undefined)?.words;
  if (
    typeof input.originalCommand !== "string" ||
    (input.requestArguments as { command?: unknown } | undefined)?.command !== input.originalCommand
  )
    return undefined;
  if (!Array.isArray(words) || !words.every((word) => typeof word === "string")) return undefined;
  const [env, backendAssignment, stackAssignment, pulumi, cwdFlag, workspace, ...command] = words;
  if (
    env !== "env" ||
    pulumi !== "pulumi" ||
    cwdFlag !== "--cwd" ||
    typeof input.resource !== "string" ||
    !isAbsolute(input.resource) ||
    normalize(input.resource) !== input.resource ||
    workspace !== input.resource ||
    input.workingDirectory !== workspace ||
    !backendAssignment?.startsWith("PULUMI_BACKEND_URL=") ||
    !stackAssignment?.startsWith("PULUMI_STACK=")
  )
    return undefined;
  const backend = backendAssignment.slice("PULUMI_BACKEND_URL=".length);
  const stack = stackAssignment.slice("PULUMI_STACK=".length);
  if (!validBackend(backend) || !/^[A-Za-z0-9][A-Za-z0-9_.\/-]*$/.test(stack)) return undefined;
  let operation: string;
  if (command.length === 2 && command[0] === "login" && command[1] === backend) {
    operation = "login";
  } else if (
    command.length === 4 &&
    command[0] === "stack" &&
    command[1] === "history" &&
    command[2] === "--stack" &&
    command[3] === stack
  ) {
    operation = "history";
  } else if (
    command[1] === "--stack" &&
    command[2] === stack &&
    ((command.length === 3 && command[0] === "preview") ||
      (command.length === 4 &&
        command[3] === "--yes" &&
        (command[0] === "up" || command[0] === "refresh")))
  ) {
    operation = command[0];
  } else return undefined;
  return { operation, resource: pulumiTarget(workspace, stack, backend) };
}

export async function runPulumiRequestMaterializer(
  candidate: Promise<unknown>,
  write: (value: string) => void = console.log,
): Promise<boolean> {
  const materialized = materializePulumiRequest(await candidate);
  if (!materialized) return false;
  const { resource, ...context } = materialized;
  write(JSON.stringify({ context, resource }));
  return true;
}

export async function runPulumiRequestMain(
  candidate: Promise<unknown>,
  exit: (code: number) => void = Deno.exit,
): Promise<void> {
  exit((await runPulumiRequestMaterializer(candidate)) ? 0 : 1);
}

if (import.meta.main) await runPulumiRequestMain(new Response(Deno.stdin.readable).json());
