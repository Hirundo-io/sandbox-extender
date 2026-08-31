import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export function materializeLocalWorkspaceActivation(candidate: unknown): string | undefined {
  if (typeof candidate !== "object" || candidate === null || !("workspace" in candidate))
    return undefined;
  const workspace = candidate.workspace;
  if (typeof workspace !== "string" || !isAbsolute(workspace)) return undefined;
  try {
    return realpathSync(resolve(workspace));
  } catch {
    return undefined;
  }
}

export async function runLocalWorkspaceActivationMaterializer(
  candidate: Promise<unknown>,
  write: (value: string) => void = console.log,
): Promise<boolean> {
  const target = materializeLocalWorkspaceActivation(await candidate);
  if (!target) return false;
  write(JSON.stringify({ targets: [target] }));
  return true;
}

// prettier-ignore
void (import.meta.main && Deno.exit((await runLocalWorkspaceActivationMaterializer(new Response(Deno.stdin.readable).json())) ? 0 : 1));
