import { isAbsolute, normalize } from "node:path";

function validBackend(value: unknown): value is string {
  return typeof value === "string" && /^(?:gs|s3|azblob|https|file):\/\/[^\s?#@]+$/.test(value);
}

function pulumiTarget(workspace: string, stack: string, backend: string): string {
  return `pulumi:${JSON.stringify([workspace, stack, backend])}`;
}

export function materializePulumiActivation(candidate: unknown): string | undefined {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const { workspace, stack, backend } = candidate as Record<string, unknown>;
  if (
    typeof workspace !== "string" ||
    !isAbsolute(workspace) ||
    normalize(workspace) !== workspace ||
    typeof stack !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.\/-]*$/.test(stack) ||
    !validBackend(backend)
  )
    return undefined;
  return pulumiTarget(workspace, stack, backend);
}

export async function runPulumiActivationMaterializer(
  candidate: Promise<unknown>,
  write: (value: string) => void = console.log,
): Promise<boolean> {
  const target = materializePulumiActivation(await candidate);
  if (!target) return false;
  write(JSON.stringify({ targets: [target] }));
  return true;
}

export async function runPulumiActivationMain(
  candidate: Promise<unknown>,
  exit: (code: number) => void = Deno.exit,
): Promise<void> {
  exit((await runPulumiActivationMaterializer(candidate)) ? 0 : 1);
}

if (import.meta.main) await runPulumiActivationMain(new Response(Deno.stdin.readable).json());
