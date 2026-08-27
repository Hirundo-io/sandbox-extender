import { isAbsolute, resolve } from "node:path";

export function materializeLocalWorkspaceActivation(candidate: unknown): string | undefined {
  if (typeof candidate !== "object" || candidate === null || !("workspace" in candidate)) return undefined;
  const workspace = candidate.workspace;
  return typeof workspace === "string" && isAbsolute(workspace) ? resolve(workspace) : undefined;
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

if (import.meta.main && !await runLocalWorkspaceActivationMaterializer(new Response(Deno.stdin.readable).json())) {
  Deno.exit(1);
}
