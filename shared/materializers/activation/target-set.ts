export function materializeTargetSetActivation(candidate: unknown): readonly string[] | undefined {
  if (typeof candidate !== "object" || candidate === null || !("targets" in candidate)) return undefined;
  const values = candidate.targets;
  return Array.isArray(values) && values.length > 0 &&
    values.every((value) => typeof value === "string" && value.length > 0) &&
    new Set(values).size === values.length
    ? values
    : undefined;
}

export async function runTargetSetActivationMaterializer(
  candidate: Promise<unknown>,
  write: (value: string) => void = console.log,
): Promise<boolean> {
  const materialized = materializeTargetSetActivation(await candidate);
  if (!materialized) return false;
  write(JSON.stringify({ targets: materialized }));
  return true;
}

if (import.meta.main && !await runTargetSetActivationMaterializer(new Response(Deno.stdin.readable).json())) {
  Deno.exit(1);
}
