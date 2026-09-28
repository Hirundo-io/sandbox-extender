import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  materializeKubernetesActivation,
  runKubernetesActivationMain,
  runKubernetesActivationMaterializer,
} from "../shared/materializers/activation/kubernetes-diagnostics.js";
import {
  materializeKubernetesRequest,
  runKubernetesRequestMain,
  runKubernetesRequestMaterializer,
} from "../shared/materializers/requests/kubernetes-diagnostics.js";
import { verifyMaterializerIntegrity } from "../src/materializer-policy.js";
import { materializeActivation } from "../src/materializer-runtime.js";
import { PolicyCore, type Profile } from "../src/index.js";

const cluster = "gke_project_region_cluster";
const server = "https://api.example.test:6443/cluster";
const tlsServerName = "api.internal.example.test";
const namespace = "workloads";

function command(
  operation: string,
  selectedCluster = cluster,
  selectedNamespace = namespace,
  selectedServer = server,
  selectedTlsServerName = tlsServerName,
): string {
  return `kubectl --context ${selectedCluster} --server ${selectedServer} --tls-server-name ${selectedTlsServerName} --namespace ${selectedNamespace} ${operation}`;
}

function requestInput(operation: string) {
  const fullCommand = command(operation);
  return {
    command: { words: fullCommand.split(" ") },
    originalCommand: fullCommand,
    requestArguments: { command: fullCommand },
  };
}

async function profile(targets: readonly string[]): Promise<Profile> {
  const root = join(process.cwd(), "shared");
  const template = JSON.parse(
    await readFile(join(root, "profile-templates/kubernetes-diagnostics.json"), "utf8"),
  );
  const activationSource = await readFile(join(root, template.activationMaterializer.file), "utf8");
  const requestSource = await readFile(join(root, template.requestMaterializer.file), "utf8");
  verifyMaterializerIntegrity(template.activationMaterializer, activationSource);
  verifyMaterializerIntegrity(template.requestMaterializer, requestSource);
  return {
    ...template,
    allowedTargets: new Set(targets),
    activationMaterializer: {
      ...template.activationMaterializer,
      reviewedSource: activationSource,
    },
    requestMaterializer: { ...template.requestMaterializer, reviewedSource: requestSource },
  };
}

describe("Kubernetes diagnostics profile", () => {
  test("activation freezes cluster, namespace, and explicit node scope", async () => {
    const namespaced = `kubernetes:${JSON.stringify([cluster, server, tlsServerName, namespace, "namespace"])}`;
    const nodes = `kubernetes:${JSON.stringify([cluster, server, tlsServerName, namespace, "cluster-nodes"])}`;
    expect(
      materializeKubernetesActivation({
        server,
        tlsServerName,
        cluster,
        namespace,
        allowClusterWideNodes: false,
      }),
    ).toEqual([namespaced]);
    expect(
      materializeKubernetesActivation({
        server,
        tlsServerName,
        cluster,
        namespace,
        allowClusterWideNodes: true,
      }),
    ).toEqual([namespaced, nodes]);
    const reviewed = await profile([namespaced, nodes]);
    expect(
      materializeActivation(reviewed.activationMaterializer!, {
        server,
        tlsServerName,
        cluster,
        namespace,
        allowClusterWideNodes: true,
      }),
    ).toEqual({ targets: [namespaced, nodes] });
    const output: string[] = [];
    expect(
      await runKubernetesActivationMaterializer(
        Promise.resolve({ server, tlsServerName, cluster, namespace, allowClusterWideNodes: true }),
        (value) => output.push(value),
      ),
    ).toBe(true);
    expect(JSON.parse(output[0]!)).toEqual({ targets: [namespaced, nodes] });
    const codes: number[] = [];
    await runKubernetesActivationMain(
      Promise.resolve({ server, tlsServerName, cluster, namespace, allowClusterWideNodes: false }),
      (code) => codes.push(code),
    );
    await runKubernetesActivationMain(
      Promise.resolve({ server, tlsServerName, cluster, namespace }),
      (code) => codes.push(code),
    );
    expect(codes).toEqual([0, 1]);
    for (const invalid of [
      null,
      {},
      { server, tlsServerName, cluster, namespace },
      { server, tlsServerName, cluster: "", namespace, allowClusterWideNodes: false },
      {
        server,
        tlsServerName,
        cluster: "https://user:secret@example.test",
        namespace,
        allowClusterWideNodes: false,
      },
      { server, tlsServerName, cluster, namespace: "Other", allowClusterWideNodes: false },
      { server, tlsServerName, cluster, namespace: "team.apps", allowClusterWideNodes: false },
      { server, tlsServerName, cluster, namespace: "a".repeat(64), allowClusterWideNodes: false },
      { server, tlsServerName, cluster, namespace, allowClusterWideNodes: "yes" },
    ])
      expect(materializeKubernetesActivation(invalid)).toBeUndefined();
    expect(
      await runKubernetesActivationMaterializer(
        Promise.resolve({ server, tlsServerName, cluster, namespace }),
      ),
    ).toBe(false);
  });

  test("permits observed inspection and keeps node reads behind the cluster-wide grant", async () => {
    const namespaced = materializeKubernetesActivation({
      server,
      tlsServerName,
      cluster,
      namespace,
      allowClusterWideNodes: false,
    })!;
    const allTargets = materializeKubernetesActivation({
      server,
      tlsServerName,
      cluster,
      namespace,
      allowClusterWideNodes: true,
    })!;
    const namespacedCommands = [
      "rollout status deployment/api",
      "get deployments -o=wide",
      "get pods -o=wide",
      "describe pod api-123",
      "get events --field-selector=reason=FailedScheduling",
    ];
    const nodeCommands = ["get nodes -o=wide", "describe node worker-1"];
    for (const [targets, allowed] of [
      [namespaced, namespacedCommands],
      [allTargets, [...namespacedCommands, ...nodeCommands]],
    ] as const) {
      const core = new PolicyCore();
      core.activate(await profile(targets), "test-thread");
      for (const operation of allowed) {
        const result = await core.evaluate({
          action: "codex.unified_exec",
          arguments: { command: command(operation) },
          resource: process.cwd(),
          threadId: "test-thread",
        });
        expect(result, operation).toMatchObject({ decision: "allow" });
      }
      expect(
        (
          await core.evaluate({
            action: "other.unified_exec",
            arguments: { command: command(allowed[0]!) },
            resource: process.cwd(),
            threadId: "test-thread",
          })
        ).decision,
      ).toBe("abstain");
      expect(
        (
          await core.evaluate({
            action: "claude.Bash",
            arguments: { command: command(allowed[0]!) },
            resource: process.cwd(),
            threadId: "test-thread",
          })
        ).decision,
      ).toBe("allow");
      for (const rejected of [
        ...nodeCommands.filter((value) => !allowed.includes(value)).map((value) => command(value)),
        command("get pods -o=wide", cluster, namespace, "https://other.example.test"),
        command("get pods -o=wide", cluster, namespace, server, "other.example.test"),
        command("get pods -o=wide").replace(` --server ${server}`, ""),
        command("get pods -o=wide") + " --server https://other.example.test",
        command("get secrets"),
        command("describe secret prod"),
        command("delete pod api-123"),
        command("scale deployment api --replicas=0"),
        command("get pods --all-namespaces"),
        command("get pods -o=json"),
        command("describe pod other/escaped"),
        command("get events --field-selector=type=Warning"),
        command("get pods -o=wide", "other-cluster"),
        command("get pods -o=wide", cluster, "other-namespace"),
        command("get pods -o=wide") + " && " + command("describe pod api-123"),
      ]) {
        const result = await core.evaluate({
          action: "codex.unified_exec",
          arguments: { command: rejected },
          resource: process.cwd(),
          threadId: "test-thread",
        });
        expect(result, rejected).toMatchObject({ decision: "abstain" });
      }
    }
  }, 60_000);

  test("rejects unsafe endpoints and TLS names before freezing or materializing targets", () => {
    const activation = { cluster, server, tlsServerName, namespace, allowClusterWideNodes: false };
    for (const invalidServer of [
      undefined,
      "",
      "https://[",
      "http://api.example.test",
      "https://user:secret@api.example.test",
      "https://api.example.test?token=secret",
      "https://api.example.test#fragment",
      "https://api.example.test/ white",
      "https://api.example.test\\other",
    ]) {
      expect(
        materializeKubernetesActivation({ ...activation, server: invalidServer }),
      ).toBeUndefined();
      const input = requestInput("get pods -o=wide");
      input.command.words[4] = invalidServer as string;
      expect(materializeKubernetesRequest(input)).toBeUndefined();
    }
    for (const invalidTls of [undefined, "", "bad name", "a".repeat(254)]) {
      expect(
        materializeKubernetesActivation({ ...activation, tlsServerName: invalidTls }),
      ).toBeUndefined();
      const input = requestInput("get pods -o=wide");
      input.command.words[6] = invalidTls as string;
      expect(materializeKubernetesRequest(input)).toBeUndefined();
    }
  });

  test("malformed argv fails closed without throwing or writing output", async () => {
    const valid = requestInput("get pods -o=wide");
    const malformed: unknown[][] = [];
    for (let length = 0; length < valid.command.words.length; length++) {
      malformed.push(valid.command.words.slice(0, length));
    }
    for (let index = 0; index < valid.command.words.length; index++) {
      const sparse: unknown[] = [...valid.command.words];
      delete sparse[index];
      malformed.push(sparse);
      const nonString: unknown[] = [...valid.command.words];
      nonString[index] = null;
      malformed.push(nonString);
    }
    const output: string[] = [];
    for (const words of malformed) {
      const input = { ...valid, command: { words } };
      expect(materializeKubernetesRequest(input)).toBeUndefined();
      expect(
        await runKubernetesRequestMaterializer(Promise.resolve(input), (value) =>
          output.push(value),
        ),
      ).toBe(false);
    }
    expect(output).toEqual([]);
  });

  test("request materializer emits only typed diagnostics", async () => {
    const expected = [
      ["rollout status deployment/api", "deployment.readiness", "namespace"],
      ["get deployments -o=wide", "deployment.list", "namespace"],
      ["get pods -o=wide", "pod.list", "namespace"],
      ["describe pod api-123", "pod.describe", "namespace"],
      ["get events --field-selector=reason=FailedScheduling", "scheduling.events", "namespace"],
      ["get nodes -o=wide", "node.list", "cluster-nodes"],
      ["describe node worker-1", "node.describe", "cluster-nodes"],
    ];
    for (const [operation, name, scope] of expected) {
      const input = requestInput(operation);
      const resource = `kubernetes:${JSON.stringify([cluster, server, tlsServerName, namespace, scope])}`;
      expect(materializeKubernetesRequest(input)).toEqual({ operation: name, resource });
      const output: string[] = [];
      expect(
        await runKubernetesRequestMaterializer(Promise.resolve(input), (value) =>
          output.push(value),
        ),
      ).toBe(true);
      expect(JSON.parse(output[0]!)).toEqual({ context: { operation: name }, resource });
    }
    const codes: number[] = [];
    await runKubernetesRequestMain(Promise.resolve(requestInput("get pods -o=wide")), (code) =>
      codes.push(code),
    );
    await runKubernetesRequestMain(Promise.resolve(requestInput("get secrets")), (code) =>
      codes.push(code),
    );
    expect(codes).toEqual([0, 1]);
    expect(
      await runKubernetesRequestMaterializer(Promise.resolve(requestInput("get secrets"))),
    ).toBe(false);
    expect(materializeKubernetesRequest(null)).toBeUndefined();
    expect(materializeKubernetesRequest({ command: { words: ["kubectl"] } })).toBeUndefined();
    expect(
      materializeKubernetesRequest(requestInput("describe pod " + "a".repeat(254))),
    ).toBeUndefined();
    expect(
      materializeKubernetesRequest(requestInput("describe node " + "a".repeat(64))),
    ).toBeUndefined();
    expect(
      materializeKubernetesRequest({
        ...requestInput("get pods -o=wide"),
        command: { words: command("get pods -o=wide", cluster, "team.apps").split(" ") },
      }),
    ).toBeUndefined();
  });
});
