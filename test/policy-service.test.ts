import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PolicyRepository } from "../src/policy-repository.js";
import { activateProfile, disableProfile, evaluateForThread } from "../src/policy-service.js";

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

describe("policy service", () => {
  test("records inactive requests and fails closed for missing profile files", async () => {
    const { repository, root } = await createRepository();
    try {
      expect(await evaluateForThread(repository, request)).toEqual({
        decision: "abstain",
        reason: "no active profile for thread",
      });
      expect(await readFile(join(root, "audit.yaml"), "utf8")).toContain("extension-request");

      await repository.writeState({ [request.threadId]: {
        fingerprint: "0".repeat(64),
        policyRevision: "revision-1",
        profileId: "missing",
      } });
      expect(await evaluateForThread(repository, request)).toEqual({
        decision: "abstain",
        reason: "policy repository is unavailable",
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
        reason: "policy repository is unavailable",
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
