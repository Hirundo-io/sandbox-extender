import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  materializePulumiActivation,
  runPulumiActivationMain,
  runPulumiActivationMaterializer,
} from "../shared/materializers/activation/pulumi-local.js";
import {
  materializePulumiRequest,
  runPulumiRequestMain,
  runPulumiRequestMaterializer,
} from "../shared/materializers/requests/pulumi-local.js";
import { verifyMaterializerIntegrity } from "../src/materializer-policy.js";
import { materializeActivation } from "../src/materializer-runtime.js";
import { PolicyCore, type Profile } from "../src/index.js";

const backend = "gs://team-pulumi-state";
const stack = "org/project/dev";

function command(
  workspace: string,
  operation: string,
  selectedBackend = backend,
  selectedStack = stack,
): string {
  return `env PULUMI_BACKEND_URL=${selectedBackend} PULUMI_STACK=${selectedStack} pulumi --cwd ${workspace} ${operation}`;
}

function requestInput(workspace: string, operation: string) {
  const fullCommand = command(workspace, operation);
  return {
    command: { words: fullCommand.split(" ") },
    originalCommand: fullCommand,
    requestArguments: { command: fullCommand },
    resource: workspace,
    workingDirectory: workspace,
  };
}

async function profile(name: string, target: string): Promise<Profile> {
  const root = join(process.cwd(), "shared");
  const template = JSON.parse(
    await readFile(join(root, "profile-templates", `${name}.json`), "utf8"),
  );
  const activationSource = await readFile(join(root, template.activationMaterializer.file), "utf8");
  const requestSource = await readFile(join(root, template.requestMaterializer.file), "utf8");
  verifyMaterializerIntegrity(template.activationMaterializer, activationSource);
  verifyMaterializerIntegrity(template.requestMaterializer, requestSource);
  return {
    ...template,
    allowedTargets: new Set([target]),
    activationMaterializer: {
      ...template.activationMaterializer,
      reviewedSource: activationSource,
    },
    requestMaterializer: { ...template.requestMaterializer, reviewedSource: requestSource },
  };
}

describe("local Pulumi profiles", () => {
  test("activation requires an absolute normalized workspace, stack and backend", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "pulumi-profile-")));
    try {
      expect(materializePulumiActivation({ workspace, stack, backend })).toBe(
        `pulumi:${JSON.stringify([workspace, stack, backend])}`,
      );
      const reviewed = await profile(
        "pulumi-preview",
        `pulumi:${JSON.stringify([workspace, stack, backend])}`,
      );
      expect(
        materializeActivation(reviewed.activationMaterializer!, { workspace, stack, backend }),
      ).toEqual({
        targets: [`pulumi:${JSON.stringify([workspace, stack, backend])}`],
      });
      const output: string[] = [];
      expect(
        await runPulumiActivationMaterializer(
          Promise.resolve({ workspace, stack, backend }),
          (value) => output.push(value),
        ),
      ).toBe(true);
      expect(JSON.parse(output[0]!)).toEqual({
        targets: [`pulumi:${JSON.stringify([workspace, stack, backend])}`],
      });
      expect(
        await runPulumiActivationMaterializer(
          Promise.resolve({ workspace: "relative", stack, backend }),
        ),
      ).toBe(false);
      const exitCodes: number[] = [];
      await runPulumiActivationMain(Promise.resolve({ workspace, stack, backend }), (code) =>
        exitCodes.push(code),
      );
      await runPulumiActivationMain(
        Promise.resolve({ workspace: "relative", stack, backend }),
        (code) => exitCodes.push(code),
      );
      expect(exitCodes).toEqual([0, 1]);
      for (const arguments_ of [
        { workspace, stack },
        { workspace, backend },
        { stack, backend },
        { workspace: "relative", stack, backend },
        { workspace, stack: "", backend },
        { workspace, stack, backend: "https://user:secret@example.com" },
        { workspace: workspace + "/../other", stack, backend },
      ])
        expect(materializePulumiActivation(arguments_)).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("each profile allows only its operations on the frozen target", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "pulumi-profile-")));
    try {
      const target = materializePulumiActivation({ workspace, stack, backend })!;
      const operations = {
        "pulumi-preview": [
          "login " + backend,
          "stack history --stack " + stack,
          "preview --stack " + stack,
        ],
        "pulumi-up": [
          "login " + backend,
          "stack history --stack " + stack,
          "preview --stack " + stack,
          "up --stack " + stack + " --yes",
        ],
        "pulumi-refresh": [
          "login " + backend,
          "stack history --stack " + stack,
          "refresh --stack " + stack + " --yes",
        ],
      };
      for (const [name, allowed] of Object.entries(operations)) {
        const core = new PolicyCore();
        core.activate(await profile(name, target), "test-thread");
        for (const operation of allowed) {
          const result = await core.evaluate({
            action: "codex.unified_exec",
            arguments: { command: command(workspace, operation) },
            resource: workspace,
            threadId: "test-thread",
          });
          expect(result, `${name}: ${operation}`).toMatchObject({ decision: "allow" });
        }
        expect(
          (
            await core.evaluate({
              action: "other.unified_exec",
              arguments: { command: command(workspace, allowed[0]!) },
              resource: workspace,
              threadId: "test-thread",
            })
          ).decision,
        ).toBe("abstain");
        expect(
          (
            await core.evaluate({
              action: "claude.Bash",
              arguments: { command: command(workspace, allowed[0]!) },
              resource: workspace,
              threadId: "test-thread",
            })
          ).decision,
        ).toBe("allow");
        for (const operation of [
          "up --stack " + stack + " --yes",
          "refresh --stack " + stack + " --yes",
          "destroy --stack " + stack + " --yes",
          "stack rm --stack " + stack,
          "preview --stack other",
          "up --stack " + stack + " --yes --skip-preview",
          "refresh --stack " + stack + " --yes --clear-pending-creates",
          "login gs://other-state",
          "preview --stack " + stack + " --show-secrets",
        ].filter((operation) => !allowed.includes(operation))) {
          expect(
            (
              await core.evaluate({
                action: "codex.unified_exec",
                arguments: { command: command(workspace, operation) },
                resource: workspace,
                threadId: "test-thread",
              })
            ).decision,
          ).toBe("abstain");
        }
        for (const rejected of [
          command(workspace, "preview --stack " + stack, "gs://other-state"),
          command(workspace, "preview --stack " + stack, backend, "other"),
          command(join(workspace, "other"), "preview --stack " + stack),
          "pixi run " + command(workspace, "preview --stack " + stack),
          command(workspace, "preview --stack " + stack) + " && pulumi destroy",
          command(workspace, "login " + backend) +
            " && " +
            command(workspace, "stack history --stack " + stack),
        ]) {
          expect(
            (
              await core.evaluate({
                action: "codex.unified_exec",
                arguments: { command: rejected },
                resource: workspace,
                threadId: "test-thread",
              })
            ).decision,
          ).toBe("abstain");
        }
      }
      expect(
        materializePulumiRequest({
          command: { words: ["pulumi", "destroy"] },
          resource: workspace,
          workingDirectory: workspace,
        }),
      ).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 60_000);

  test("request materializer returns typed facts for exact invocations", async () => {
    const workspace = "/workspace";
    const target = `pulumi:${JSON.stringify([workspace, stack, backend])}`;
    for (const [operation, expected] of [
      ["login " + backend, "login"],
      ["stack history --stack " + stack, "history"],
      ["preview --stack " + stack, "preview"],
      ["up --stack " + stack + " --yes", "up"],
      ["refresh --stack " + stack + " --yes", "refresh"],
    ]) {
      const input = requestInput(workspace, operation);
      expect(materializePulumiRequest(input)).toEqual({ operation: expected, resource: target });
      const output: string[] = [];
      expect(
        await runPulumiRequestMaterializer(Promise.resolve(input), (value) => output.push(value)),
      ).toBe(true);
      expect(JSON.parse(output[0]!)).toEqual({
        context: { operation: expected },
        resource: target,
      });
    }
    expect(
      await runPulumiRequestMaterializer(Promise.resolve(requestInput(workspace, "destroy"))),
    ).toBe(false);
    const exitCodes: number[] = [];
    await runPulumiRequestMain(
      Promise.resolve(requestInput(workspace, "login " + backend)),
      (code) => exitCodes.push(code),
    );
    await runPulumiRequestMain(Promise.resolve(requestInput(workspace, "destroy")), (code) =>
      exitCodes.push(code),
    );
    expect(exitCodes).toEqual([0, 1]);
  });
});
