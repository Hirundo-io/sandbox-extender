type KubernetesOperation = { readonly operation: string; readonly resource: string };

function validCluster(value: string): boolean {
  return !value.includes("://") && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(value);
}

function validNamespace(value: string): boolean {
  return value.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value);
}

function validName(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    value
      .split(".")
      .every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
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

export function materializeKubernetesRequest(candidate: unknown): KubernetesOperation | undefined {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const input = candidate as Record<string, unknown>;
  const words = (input.command as { words?: unknown } | undefined)?.words;
  if (
    typeof input.originalCommand !== "string" ||
    (input.requestArguments as { command?: unknown } | undefined)?.command !==
      input.originalCommand ||
    !Array.isArray(words) ||
    words.length !== 12 ||
    !Array.from(words).every((word) => typeof word === "string")
  )
    return undefined;
  const [
    kubectl,
    contextFlag,
    cluster,
    serverFlag,
    server,
    tlsFlag,
    tlsServerName,
    namespaceFlag,
    namespace,
    ...command
  ] = words;
  if (
    kubectl !== "kubectl" ||
    contextFlag !== "--context" ||
    serverFlag !== "--server" ||
    tlsFlag !== "--tls-server-name" ||
    !validServer(server) ||
    !validTlsServerName(tlsServerName) ||
    namespaceFlag !== "--namespace" ||
    !validCluster(cluster) ||
    !validNamespace(namespace)
  )
    return undefined;
  let operation: string;
  let scope = "namespace";
  if (
    command.length === 3 &&
    command[0] === "rollout" &&
    command[1] === "status" &&
    command[2]?.startsWith("deployment/") &&
    validName(command[2].slice("deployment/".length))
  )
    operation = "deployment.readiness";
  else if (
    command.length === 3 &&
    command[0] === "get" &&
    command[1] === "deployments" &&
    command[2] === "-o=wide"
  )
    operation = "deployment.list";
  else if (
    command.length === 3 &&
    command[0] === "get" &&
    command[1] === "pods" &&
    command[2] === "-o=wide"
  )
    operation = "pod.list";
  else if (
    command.length === 3 &&
    command[0] === "describe" &&
    command[1] === "pod" &&
    validName(command[2])
  )
    operation = "pod.describe";
  else if (
    command.length === 3 &&
    command[0] === "get" &&
    command[1] === "events" &&
    command[2] === "--field-selector=reason=FailedScheduling"
  )
    operation = "scheduling.events";
  else if (
    command.length === 3 &&
    command[0] === "get" &&
    command[1] === "nodes" &&
    command[2] === "-o=wide"
  ) {
    operation = "node.list";
    scope = "cluster-nodes";
  } else if (
    command.length === 3 &&
    command[0] === "describe" &&
    command[1] === "node" &&
    validName(command[2])
  ) {
    operation = "node.describe";
    scope = "cluster-nodes";
  } else return undefined;
  return {
    operation,
    resource: kubernetesTarget(cluster, server, tlsServerName, namespace, scope),
  };
}

export async function runKubernetesRequestMaterializer(
  candidate: Promise<unknown>,
  write: (value: string) => void = console.log,
): Promise<boolean> {
  const materialized = materializeKubernetesRequest(await candidate);
  if (!materialized) return false;
  const { resource, ...context } = materialized;
  write(JSON.stringify({ context, resource }));
  return true;
}

export async function runKubernetesRequestMain(
  candidate: Promise<unknown>,
  exit: (code: number) => void = Deno.exit,
): Promise<void> {
  exit((await runKubernetesRequestMaterializer(candidate)) ? 0 : 1);
}

if (import.meta.main) await runKubernetesRequestMain(new Response(Deno.stdin.readable).json());
