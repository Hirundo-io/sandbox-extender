function validCluster(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("://") &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(value)
  );
}

function validNamespace(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)
  );
}

function validServer(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("https://") || /[\s\\?#]/.test(value))
    return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === ""
    );
  } catch {
    return false;
  }
}

function validTlsServerName(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 253 && /^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(value)
  );
}

function kubernetesTarget(
  cluster: string,
  server: string,
  tlsServerName: string,
  namespace: string,
  scope: string,
): string {
  return `kubernetes:${JSON.stringify([cluster, server, tlsServerName, namespace, scope])}`;
}

export function materializeKubernetesActivation(candidate: unknown): readonly string[] | undefined {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const { cluster, server, tlsServerName, namespace, allowClusterWideNodes } = candidate as Record<
    string,
    unknown
  >;
  if (
    !validCluster(cluster) ||
    !validServer(server) ||
    !validTlsServerName(tlsServerName) ||
    !validNamespace(namespace) ||
    typeof allowClusterWideNodes !== "boolean"
  )
    return undefined;
  const targets = [kubernetesTarget(cluster, server, tlsServerName, namespace, "namespace")];
  if (allowClusterWideNodes)
    targets.push(kubernetesTarget(cluster, server, tlsServerName, namespace, "cluster-nodes"));
  return targets;
}

export async function runKubernetesActivationMaterializer(
  candidate: Promise<unknown>,
  write: (value: string) => void = console.log,
): Promise<boolean> {
  const targets = materializeKubernetesActivation(await candidate);
  if (!targets) return false;
  write(JSON.stringify({ targets }));
  return true;
}

export async function runKubernetesActivationMain(
  candidate: Promise<unknown>,
  exit: (code: number) => void = Deno.exit,
): Promise<void> {
  exit((await runKubernetesActivationMaterializer(candidate)) ? 0 : 1);
}

if (import.meta.main) await runKubernetesActivationMain(new Response(Deno.stdin.readable).json());
