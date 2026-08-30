import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  type ActiveProfileStatus,
  activateProfile,
  disableProfile,
  evaluateForThread,
  getActiveProfileStatus,
  PolicyRepository,
} from "../src/index.js";
import { PolicyCore } from "../src/policy-core.js";
import { materializerIntegrity } from "../src/materializer-policy.js";
import type { Profile } from "../src/types.js";

const emptyPermissions = { env: [], ffi: [], net: [], read: [], run: [], sys: [], write: [] } as const;

function materializerReference(file: string, source: string) {
  return {
    file,
    integrity: materializerIntegrity(source, emptyPermissions, "2.8.1"),
    language: "typescript" as const,
    permissions: emptyPermissions,
    runtimeVersion: "2.8.1",
  };
}

const request = {
  action: "codex.unified_exec",
  arguments: { command: "gh pr diff 42" },
  resource: "/work/example",
  threadId: "thread-1",
};

async function createRepository(): Promise<{ repository: PolicyRepository; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "sandbox-extender-service-"));
  return { repository: new PolicyRepository(root), root };
}

async function writeProfile(root: string, id: string, policyRevision: string): Promise<void> {
  await mkdir(join(root, "profiles"), { recursive: true });
  await Bun.write(join(root, "profiles", `${id}.json`), JSON.stringify({
    allowedTargets: [request.resource],
    groupings: [{ id: "allow", policies: { allow: "permit(principal, action, resource);" } }],
    id,
    policyRevision,
  }));
}

function commitReview(root: string): string {
  for (const command of [
    ["git", "init", "--quiet"],
    ["git", "config", "user.email", "sandbox-extender@example.test"],
    ["git", "config", "user.name", "Sandbox Extender"],
    ["git", "add", "-A"],
    ["git", "commit", "--quiet", "-m", "Review profile"],
  ]) {
    const result = Bun.spawnSync({ cmd: command, cwd: root });
    if (result.exitCode !== 0) throw new Error(`could not run ${command.join(" ")}`);
  }
  const result = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: root, stdout: "pipe" });
  return new TextDecoder().decode(result.stdout).trim();
}

async function writeReviewedProfile(
  repository: PolicyRepository,
  id: string,
): Promise<string> {
  await repository.writeProposal({
    profile: {
      allowedTargets: [request.resource],
      groupings: [{ id: "allow", policies: { allow: "permit(principal, action, resource);" } }],
      id,
      policyRevision: "pending-review",
    },
    tests: [{ expected: "allow", name: "allows the request", request }],
  });
  const revision = commitReview(repository.root);
  await repository.promoteProposal(id, revision);
  return revision;
}

function stubRepository(profile: Profile, bindingOverrides: Record<string, unknown> = {}): PolicyRepository {
  const fingerprint = createHash("sha256").update(JSON.stringify({
    allowedTargets: [...profile.allowedTargets].sort(), groupings: profile.groupings, id: profile.id,
    policyRevision: profile.policyRevision, sessionContext: profile.sessionContext ?? [], targetScope: profile.targetScope,
    activationMaterializer: profile.activationMaterializer, requestMaterializer: profile.requestMaterializer,
  })).digest("hex");
  const binding = {
    allowedTargets: [...profile.allowedTargets],
    fingerprint,
    policyRevision: profile.policyRevision,
    profileId: profile.id,
    ...bindingOverrides,
  };
  return {
    appendAudit: async () => undefined,
    loadVerifiedProfile: async () => profile,
    readState: async () => ({ [request.threadId]: binding }),
    writeState: async () => undefined,
  } as unknown as PolicyRepository;
}

describe("policy service", () => {
  test("fails closed when the binding state cannot be read", async () => {
    const unavailableRepository = {
      readState: async () => {
        throw new Error("state is unavailable");
      },
    } as unknown as PolicyRepository;

    expect(await getActiveProfileStatus(unavailableRepository, request.threadId)).toEqual({
      reason: "policy repository is unavailable",
      status: "unavailable",
    });
    expect(await evaluateForThread(unavailableRepository, request)).toEqual({
      decision: "abstain",
      reason: "policy repository is unavailable",
    });
  });

  test("reports verification failures as unavailable instead of stale", async () => {
    const profile: Profile = {
      allowedTargets: new Set([request.resource]),
      groupings: [{ id: "allow", policies: { allow: "permit(principal, action, resource);" } }],
      id: "review",
      policyRevision: "a".repeat(40),
    };
    const unavailableRepository = stubRepository(profile);
    unavailableRepository.loadVerifiedProfile = async () => {
      throw new Error("Git repository is unavailable");
    };

    expect(await getActiveProfileStatus(unavailableRepository, request.threadId)).toEqual({
      reason: "policy repository is unavailable",
      status: "unavailable",
    });
    expect(await evaluateForThread(unavailableRepository, request)).toEqual({
      decision: "abstain",
      reason: "policy repository is unavailable",
    });
  });

  test("redacts credentials from active profile targets", async () => {
    const profile: Profile = {
      allowedTargets: new Set(["https://user:secret@example.test/repository"]),
      groupings: [{ id: "allow", policies: { allow: "permit(principal, action, resource);" } }],
      id: "review",
      policyRevision: "a".repeat(40),
    };

    const status: ActiveProfileStatus = await getActiveProfileStatus(
      stubRepository(profile),
      request.threadId,
    );
    expect(status).toEqual({
      allowedTargets: ["https://[redacted]@example.test/repository"],
      policyRevision: "a".repeat(40),
      profileId: "review",
      status: "active",
    });
  });

  test("reports an active Profile only when its binding still matches review", async () => {
    const { repository, root } = await createRepository();
    try {
      const revision = await writeReviewedProfile(repository, "review");
      await activateProfile(repository, request.threadId, "review");
      expect(await getActiveProfileStatus(repository, request.threadId)).toEqual({
        allowedTargets: [request.resource],
        policyRevision: revision,
        profileId: "review",
        status: "active",
      });

      await writeFile(join(root, "profiles", "review.json"), JSON.stringify({
        allowedTargets: ["github:repository:acme/other"],
        groupings: [{ id: "allow", policies: { allow: "permit(principal, action, resource);" } }],
        id: "review",
        policyRevision: revision,
      }));
      expect(await getActiveProfileStatus(repository, request.threadId)).toEqual({
        allowedTargets: [request.resource],
        policyRevision: revision,
        profileId: "review",
        reason: "active profile no longer matches review",
        status: "stale",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("freezes activation arguments into the thread binding", async () => {
    const { repository, root } = await createRepository();
    try {
      await mkdir(join(root, "materializers", "activation"), { recursive: true });
      await mkdir(join(root, "materializers", "requests"), { recursive: true });
      const activationSource = await readFile(
        join(process.cwd(), "shared", "materializers", "activation", "github-pull-request.ts"), "utf8",
      );
      const requestSource = await readFile(
        join(process.cwd(), "shared", "materializers", "requests", "github-pull-request.ts"), "utf8",
      );
      await writeFile(join(root, "materializers", "activation", "github-pull-request.ts"), activationSource);
      await writeFile(join(root, "materializers", "requests", "github-pull-request.ts"), requestSource);
      const pullRequestRequest = {
        action: "codex.unified_exec",
        arguments: { command: "gh pr view 42 --repo acme/example" },
        resource: process.cwd(),
        threadId: "thread-activation",
      };
      await repository.writeProposal({
        profile: {
          activationMaterializer: materializerReference(
            "materializers/activation/github-pull-request.ts", activationSource,
          ),
          allowedTargets: [],
          groupings: [{
            id: "view",
            policies: {
              allow: 'permit(principal, action, resource) when { context.materialized.operation == "github.pull-request.view" };',
            },
          }],
          id: "babysitter",
          policyRevision: "pending-review",
          requestMaterializer: materializerReference(
            "materializers/requests/github-pull-request.ts", requestSource,
          ),
          targetScope: "single",
        },
        tests: [{
          activationArguments: { pullRequest: 42, repository: "acme/example" },
          expected: "allow",
          name: "views the activated pull request",
          request: pullRequestRequest,
        }],
      });
      const revision = commitReview(root);
      await repository.promoteProposal("babysitter", revision);

      expect(await activateProfile(repository, pullRequestRequest.threadId, "babysitter", {
        pullRequest: 42,
        repository: "acme/example",
      })).toEqual(["github:pull-request:acme/example#42"]);
      expect((await repository.readState())[pullRequestRequest.threadId]?.allowedTargets)
        .toEqual(["github:pull-request:acme/example#42"]);
      const allowed = await evaluateForThread(repository, pullRequestRequest);
      expect(allowed.decision).toBe("allow");
      expect(allowed.token).toBeUndefined();
      expect((await evaluateForThread(repository, {
        ...pullRequestRequest,
        arguments: { command: "gh pr view 43 --repo acme/example" },
      })).decision).toBe("abstain");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("records inactive requests and reports stale bindings for missing profile files", async () => {
    const { repository, root } = await createRepository();
    try {
      expect(await evaluateForThread(repository, request)).toEqual({
        decision: "abstain",
        reason: "no active profile for thread",
      });
      expect(await readFile(join(root, "audit.yaml"), "utf8")).toContain("extension-request");

      await repository.writeState({ [request.threadId]: {
        allowedTargets: [request.resource],
        fingerprint: "0".repeat(64),
        policyRevision: "revision-1",
        profileId: "missing",
      } });
      expect(await evaluateForThread(repository, request)).toEqual({
        decision: "abstain",
        reason: "active profile no longer matches review",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("keeps ordinary command arguments while redacting recognizable secrets", async () => {
    const { repository, root } = await createRepository();
    const secret = "ghp_this-must-not-reach-the-audit-log";
    const password = "swordfish";
    const privateKey = "-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----";
    try {
      await evaluateForThread(repository, {
        ...request,
        arguments: {
          command: `gh pr view 42 --token ${secret} API_TOKEN=${password} https://user:${password}@example.test`,
          headers: ["Authorization", `Bearer ${secret}`],
          nested: { apiKey: secret, privateKey },
          ordinary: "gh pr view 42",
        },
      });

      const audit = await readFile(join(root, "audit.yaml"), "utf8");
      expect(audit).not.toContain(secret);
      expect(audit).not.toContain(password);
      expect(audit).not.toContain("private-key-material");
      expect(audit).toContain("[redacted]");
      expect(audit).toContain("gh pr view 42");
      expect(audit).toContain("command: gh pr view 42 --token [redacted]");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("redacts credentials inside nested JSON strings while retaining useful fields", async () => {
    const { repository, root } = await createRepository();
    const password = "json-password-must-not-reach-the-audit-log";
    const apiKey = "json-api-key-must-not-reach-the-audit-log";
    const refreshToken = "json-refresh-token-must-not-reach-the-audit-log";
    try {
      await evaluateForThread(repository, {
        ...request,
        arguments: {
          payload: JSON.stringify({
            batch: [{ action: "sync", apiKey }],
            context: { requestId: "request-42" },
            password,
            serialized: JSON.stringify({
              metadata: { environment: "staging" },
              refreshToken,
            }),
          }),
        },
      });

      const audit = await readFile(join(root, "audit.yaml"), "utf8");
      expect(audit).not.toContain(password);
      expect(audit).not.toContain(apiKey);
      expect(audit).not.toContain(refreshToken);
      expect(audit).toContain("request-42");
      expect(audit).toContain("sync");
      expect(audit).toContain("staging");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("preserves malformed JSON-like strings and ordinary headers", async () => {
    const { repository, root } = await createRepository();
    try {
      await evaluateForThread(repository, {
        ...request,
        arguments: {
          malformed: "{not json}",
          headers: ["Accept", "application/json", 42],
          headerObject: { headers: "plain" },
          primitives: [null, true, 42],
        },
      });
      const audit = await readFile(join(root, "audit.yaml"), "utf8");
      expect(audit).toContain("{not json}");
      expect(audit).toContain("application/json");
      expect(audit).toContain("plain");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("redacts unsupported audit values", async () => {
    const { repository, root } = await createRepository();
    try {
      await evaluateForThread(repository, { ...request, arguments: { unsupported: undefined } });
      expect(await readFile(join(root, "audit.yaml"), "utf8")).toContain("[unsupported audit value]");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("fails safe when JSON audit values exceed parsing or traversal bounds", async () => {
    const { repository, root } = await createRepository();
    const deeplyNestedSecret = "deeply-nested-secret-must-not-reach-the-audit-log";
    const oversizedSecret = "oversized-secret-must-not-reach-the-audit-log";
    let deeplyNested: unknown = { password: deeplyNestedSecret };
    for (let depth = 0; depth < 20; depth += 1) {
      deeplyNested = [deeplyNested];
    }
    try {
      await evaluateForThread(repository, {
        ...request,
        arguments: {
          deeplyNested: JSON.stringify(deeplyNested),
          oversized: JSON.stringify({
            padding: "x".repeat(64 * 1024),
            password: oversizedSecret,
          }),
        },
      });

      const audit = await readFile(join(root, "audit.yaml"), "utf8");
      expect(audit).not.toContain(deeplyNestedSecret);
      expect(audit).not.toContain(oversizedSecret);
      expect(audit).toContain("[redacted deeply nested audit value]");
      expect(audit).toContain("[redacted oversized JSON]");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("redacts common provider credentials without obscuring ordinary audit data", async () => {
    const { repository, root } = await createRepository();
    const gitlabToken = `glpat-${"a".repeat(20)}`;
    const pypiToken = `pypi-${"b".repeat(20)}`;
    const slackToken = `xoxb-1234567890-${"c".repeat(12)}`;
    const stripeSecret = `sk_live_${"d".repeat(20)}`;
    const webhookSecret = `whsec_${"e".repeat(20)}`;
    const awsAccessKey = `AKIA${"F".repeat(16)}`;
    const openAiToken = `sk-proj-${"g".repeat(20)}`;
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature1";
    const secrets = [
      gitlabToken,
      pypiToken,
      slackToken,
      stripeSecret,
      webhookSecret,
      awsAccessKey,
      openAiToken,
      jwt,
      "aws-shared-secret",
      "connection-account-key",
      "connection-password",
      "query-token",
    ];
    try {
      await evaluateForThread(repository, {
        ...request,
        arguments: {
          command: [
            `glab auth status --token ${gitlabToken}`,
            `-H 'X-Gitlab-Token: ${gitlabToken}'`,
            `--header 'Stripe-Signature: ${webhookSecret}'`,
            `AWS_SECRET_ACCESS_KEY=aws-shared-secret`,
          ].join(" "),
          configuration: {
            databaseUrl: "postgres://user:connection-password@example.test/database",
            openaiApiKey: openAiToken,
          },
          connection: "Endpoint=https://example.test;AccountKey=connection-account-key;Password=connection-password",
          credentialsUrl: "https://example.test/callback?access_token=query-token",
          headers: { "X-Slack-Signature": slackToken },
          providers: `${pypiToken} ${stripeSecret} ${awsAccessKey} ${jwt}`,
          ordinary: "gh pr view 42 https://user@example.test/path?mode=read 1.2.3 pk_test_publishable",
        },
      });

      const audit = await readFile(join(root, "audit.yaml"), "utf8");
      for (const secret of secrets) expect(audit).not.toContain(secret);
      expect(audit).toContain("gh pr view 42");
      expect(audit).toContain("https://user@example.test/path?mode=read");
      expect(audit).toContain("1.2.3");
      expect(audit).toContain("pk_test_publishable");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("preserves ordinary command headers", async () => {
    const { repository, root } = await createRepository();
    try {
      await evaluateForThread(repository, { ...request, arguments: { command: "curl -H 'Accept: application/json' example.test" } });
      expect(await readFile(join(root, "audit.yaml"), "utf8")).toContain("Accept: application/json");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("abstains when an active binding no longer matches its reviewed profile", async () => {
    const profile: Profile = {
      allowedTargets: new Set([request.resource]), groupings: [], id: "reviewed",
      policyRevision: "a".repeat(40),
    };
    expect(await evaluateForThread(stubRepository(profile, { fingerprint: "mismatch" }), request)).toEqual({
      decision: "abstain", reason: "active profile no longer matches review",
    });
  });

  test("fails closed when an allow token cannot be consumed", async () => {
    const profile: Profile = {
      allowedTargets: new Set([request.resource]),
      groupings: [{ evaluate: () => "allow", id: "allow" }], id: "reviewed", policyRevision: "a".repeat(40),
    };
    const repository = stubRepository(profile);
    let auditEntry: Readonly<Record<string, unknown>> | undefined;
    repository.appendAudit = async (entry) => {
      auditEntry = entry;
    };
    const originalConsumeToken = PolicyCore.prototype.consumeToken;
    PolicyCore.prototype.consumeToken = async () => false;
    try {
      const result = await evaluateForThread(repository, request);
      expect(result.decision).toBe("abstain");
      expect(auditEntry).toEqual(expect.objectContaining({
        decision: "abstain",
        reason: "authorization token is unavailable",
      }));
    } finally {
      PolicyCore.prototype.consumeToken = originalConsumeToken;
    }
  });

  test("fails closed when recording an allowed evaluation fails", async () => {
    const profile: Profile = {
      allowedTargets: new Set([request.resource]),
      groupings: [{ evaluate: () => "allow", id: "allow" }], id: "reviewed", policyRevision: "a".repeat(40),
    };
    const repository = stubRepository(profile);
    repository.appendAudit = async () => {
      throw new Error("audit is unavailable");
    };

    expect(await evaluateForThread(repository, request)).toEqual({
      decision: "abstain",
      reason: "policy repository is unavailable",
    });
  });

  test("rejects pending and multi-target single-scope activation", async () => {
    const pending: Profile = { allowedTargets: new Set(["one"]), groupings: [], id: "pending", policyRevision: "pending-review" };
    await expect(activateProfile(stubRepository(pending), request.threadId, pending.id)).rejects.toThrow("reviewed");
    const multiple: Profile = { allowedTargets: new Set(["one", "two"]), groupings: [], id: "multiple",
      policyRevision: "a".repeat(40), targetScope: "single" };
    await expect(activateProfile(stubRepository(multiple), request.threadId, multiple.id)).rejects.toThrow("exactly one target");
  });

  test("requires review before activation and removes the thread binding on disable", async () => {
    const { repository, root } = await createRepository();
    try {
      await writeProfile(root, "pending", "pending-review");
      await expect(activateProfile(repository, request.threadId, "pending")).rejects.toThrow("reviewed");

      const revision = await writeReviewedProfile(repository, "reviewed");
      const profileFile = join(root, "profiles", "reviewed.json");
      const reviewedProfile = JSON.parse(await readFile(profileFile, "utf8")) as Record<string, unknown>;
      await writeFile(profileFile, JSON.stringify({
        ...reviewedProfile,
        sessionContext: ["unreviewed instruction"],
      }));
      await expect(activateProfile(repository, "thread-2", "reviewed")).rejects.toThrow(
        "does not match policy revision",
      );

      await writeFile(profileFile, JSON.stringify(reviewedProfile));
      await activateProfile(repository, request.threadId, "reviewed");
      expect((await evaluateForThread(repository, request)).decision).toBe("allow");
      await writeFile(profileFile, JSON.stringify({
        ...reviewedProfile,
        groupings: [{ id: "allow", policies: { allow: "permit(principal, action, resource); permit(principal, action, resource);" } }],
      }));
      expect(await evaluateForThread(repository, request)).toEqual({
        decision: "abstain",
        reason: "active profile no longer matches review",
      });

      await writeProfile(root, "reviewed", "a".repeat(40));
      expect(await evaluateForThread(repository, request)).toEqual({
        decision: "abstain",
        reason: "policy repository is unavailable",
      });
      expect(revision).toHaveLength(40);
      await disableProfile(repository, request.threadId);
      expect(await repository.readState()).toEqual({});
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

});
