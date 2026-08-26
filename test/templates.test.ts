import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { materializePullRequestProfile, PolicyCore, type CedarGrouping, type Profile } from "../src/index.js";
import { evaluateCedarGrouping } from "../src/cedar.js";

const sharedDirectory = join(process.cwd(), "shared");
const templateDirectory = join(sharedDirectory, "templates");

function runGit(workspace: string, ...arguments_: string[]): void {
  const result = Bun.spawnSync(["git", "-C", workspace, ...arguments_]);
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

async function template(name: string): Promise<Profile> {
  const candidate: unknown = JSON.parse(await readFile(join(templateDirectory, `${name}.json`), "utf8"));
  const profile = candidate as Omit<Profile, "allowedTargets"> & { allowedTargets: string[] };
  if (name === "babysitter") {
    const reviewedProfile = {
      ...profile,
      pullRequestBinding: {
        pullRequest: "acme/example#42",
        workspace: "/work/example",
      },
    } as unknown as Parameters<typeof materializePullRequestProfile>[0];
    const materialized = materializePullRequestProfile(reviewedProfile, (command) => {
      if (command[0] === "git") return "/work/example";
      return JSON.stringify({ url: "https://github.com/acme/example/pull/42" });
    });
    const { pullRequestBinding: _pullRequestBinding, ...staticProfile } = profile as typeof profile & {
      pullRequestBinding: unknown;
    };
    return {
      ...staticProfile,
      ...materialized,
      allowedTargets: new Set(materialized.allowedTargets),
      targetResolver: materialized.targetResolver && {
        ...materialized.targetResolver,
        file: join(sharedDirectory, materialized.targetResolver.file),
      },
    };
  }
  const allowedTargets = profile.allowedTargets.length > 0
    ? profile.allowedTargets
    : ["/work/example", "github:repository:acme/example"];
  return {
    ...profile,
    allowedTargets: new Set(allowedTargets),
    targetResolver: profile.targetResolver && {
      ...profile.targetResolver,
      file: join(sharedDirectory, profile.targetResolver.file),
    },
  };
}

describe("shipped profiles", () => {
  test("Scout permits GitHub inspection but not changes", async () => {
    const core = new PolicyCore();
    core.activate(await template("scout"), "thread-1");

    for (const command of [
      "gh pr diff 42 --repo acme/example",
      "gh pr view 42 --repo acme/example",
      "gh pr view 42 --repo=acme/example",
      "gh pr list --repo acme/example",
      "gh pr checks 42 --repo acme/example",
      "gh issue view 42 --repo acme/example",
      "gh issue list --repo acme/example",
      "gh run view 123 --repo acme/example",
      "gh run list --repo acme/example",
      "gh release view v1.0.0 --repo acme/example",
      "gh release list --repo acme/example",
      "gh workflow view build --repo acme/example",
      "gh workflow list --repo acme/example",
      "gh repo view --repo acme/example",
      "gh repo list --repo acme/example",
      "gh label list --repo acme/example",
    ]) {
      expect(core.evaluate({ action: "codex.unified_exec", arguments: { command }, resource: "/work/example", threadId: "thread-1" }).decision).toBe("allow");
    }
    for (const command of [
      "gh pr merge 42",
      "gh pr diff 42 && gh pr merge 42",
      "gh pr view 42 --repo acme/example --repo acme/example",
      "gh pr view 42 --repo acme/example --repo acme/other",
      "gh pr view 42 --repo=acme/example --repo=acme/other",
      "gh pr view 42 --repo acme/example --repo=acme/other",
      "gh pr view 42 --repo=acme/example --repo acme/other",
      "gh pr view 42 --repo acme/example --json title --json url",
    ]) {
      expect(core.evaluate({ action: "codex.unified_exec", arguments: { command }, resource: "/work/example", threadId: "thread-1" }).decision).toBe("abstain");
    }
  });

  test("Scout permits safe Git remotes and rejects executable remote helpers", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sandbox-extender-scout-"));
    try {
      const nested = join(workspace, "nested");
      await mkdir(nested);
      runGit(workspace, "init", "--quiet");
      runGit(workspace, "remote", "add", "origin", "https://github.com/acme/example.git");
      runGit(workspace, "remote", "add", "ssh-origin", "git@github.com:acme/example.git");
      runGit(workspace, "remote", "add", "helper", "ext::sh -c id");
      runGit(workspace, "remote", "add", "rewritten", "https://unsafe.example/acme/example.git");
      runGit(
        workspace,
        "config",
        "url.ext::sh -c id .insteadOf",
        "https://unsafe.example/",
      );
      runGit(nested, "init", "--quiet");
      runGit(nested, "remote", "add", "origin", "ext::sh -c id");

      const scout = await template("scout");
      const core = new PolicyCore();
      core.activate({
        ...scout,
        allowedTargets: new Set([...scout.allowedTargets, workspace]),
      }, "thread-1");

      for (const command of [
        "git fetch --dry-run origin",
        "git fetch --dry-run https://github.com/acme/example.git",
        "git ls-remote origin",
        "git ls-remote ssh-origin refs/heads/main",
        "git ls-remote --heads https://github.com/acme/example.git",
        "git ls-remote git@github.com:acme/example.git",
      ]) {
        const request = {
          action: "codex.unified_exec",
          arguments: { command },
          resource: workspace,
          threadId: "thread-1",
        };
        const result = core.evaluate(request);
        expect(result.decision).toBe("allow");
        expect(core.consumeToken(result.token!.id, request)).toBe(true);
      }

      for (const command of [
        "git fetch --dry-run ext::sh",
        "git fetch --dry-run helper",
        "git ls-remote 'ext::sh -c id'",
        "git ls-remote helper",
        "git ls-remote rewritten",
        "git ls-remote custom::payload",
        "git ls-remote ssh://-F/example.git",
        "git ls-remote --upload-pack=sh origin",
        "cd nested && git ls-remote origin",
      ]) {
        expect(core.evaluate({
          action: "codex.unified_exec",
          arguments: { command },
          resource: workspace,
          threadId: "thread-1",
        }).decision).toBe("abstain");
      }
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  test("Maker permits lock-focused dependency changes inside the effective workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sandbox-extender-maker-"));
    try {
      const nested = join(workspace, "packages", "app");
      await mkdir(nested, { recursive: true });
      const core = new PolicyCore();
      const maker = await template("maker");
      core.activate({ ...maker, allowedTargets: new Set([workspace]) }, "thread-1");

      for (const command of [
        "npm install zod --ignore-scripts --package-lock-only --global=false --workspaces=false --location=project --prefix . --cache .cache/npm",
        "npm remove zod --ignore-scripts --package-lock-only --global=false --workspaces=false --location=project --prefix . --cache .cache/npm",
        "bun add zod --ignore-scripts --lockfile-only --cwd . --cache-dir .cache/bun",
        "bun remove zod --ignore-scripts --lockfile-only --cwd . --cache-dir .cache/bun",
        "uv add requests --no-sync --no-build --no-sources --no-config --no-python-downloads --project . --cache-dir .cache/uv",
        "uv remove requests --no-sync --no-build --no-sources --no-config --no-python-downloads --project . --cache-dir .cache/uv",
        "uv lock --no-build --no-sources --no-config --no-python-downloads --project . --cache-dir .cache/uv",
        "pixi add python=3.12 --no-install --offline --no-config --manifest-path .",
        "pixi remove python --no-install --offline --no-config --manifest-path .",
        "pixi lock --no-install --offline --no-config --manifest-path .",
        "cd packages/app && bun add zod --ignore-scripts --lockfile-only --cwd . --cache-dir .cache/bun",
      ]) {
        const request = {
          action: "codex.unified_exec",
          arguments: { command },
          resource: workspace,
          threadId: "thread-1",
        };
        const result = core.evaluate(request);
        expect(result.decision).toBe("allow");
        expect(core.consumeToken(result.token!.id, request)).toBe(true);
      }
      const builtinRequest = {
        action: "codex.unified_exec",
        arguments: { command: "echo dependency-check" },
        resource: workspace,
        threadId: "thread-1",
      };
      const builtinResult = core.evaluate(builtinRequest);
      expect(builtinResult.decision).toBe("allow");
      expect(core.consumeToken(builtinResult.token!.id, builtinRequest)).toBe(true);
      expect(maker.sessionContext).toContain(
        "No high/critical known vulnerabilities; inspect lockfiles and audit data.",
      );
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  test("Maker abstains from destination, configuration, lifecycle, and interpreter escapes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sandbox-extender-maker-deny-"));
    const outside = await mkdtemp(join(tmpdir(), "sandbox-extender-maker-outside-"));
    try {
      await symlink(outside, join(workspace, "linked-cache"));
      const core = new PolicyCore();
      const maker = await template("maker");
      core.activate({ ...maker, allowedTargets: new Set([workspace]) }, "thread-1");

      for (const command of [
        "npm install zod",
        "npm install zod --global --ignore-scripts --package-lock-only --workspaces=false --location=project --prefix . --cache .cache/npm",
        "npm install zod --ignore-scripts=false --package-lock-only --global=false --workspaces=false --location=project --prefix . --cache .cache/npm",
        "npm install zod --ignore-scripts --ignore-scripts --package-lock-only --global=false --workspaces=false --location=project --prefix . --cache .cache/npm",
        "npm install zod --ignore-scripts --package-lock-only --global=false --workspaces=false --location=project --prefix ../outside --cache .cache/npm",
        "npm install zod --ignore-scripts --package-lock-only --global=false --workspaces=false --location=project --prefix . --cache /tmp/npm-cache",
        "npm install zod --ignore-scripts --package-lock-only --global=false --workspaces --location=project --prefix . --cache .cache/npm",
        "npm install zod --ignore-scripts --package-lock-only --global=false --workspaces=false --location=project --prefix . --cache .cache/npm --userconfig .npmrc",
        "npm exec eslint",
        "bun add zod --ignore-scripts --lockfile-only --cwd ../outside --cache-dir .cache/bun",
        "bun add zod --ignore-scripts --lockfile-only --cwd . --cache-dir /tmp/bun-cache",
        "bun add zod --trust --ignore-scripts --lockfile-only --cwd . --cache-dir .cache/bun",
        "bun add zod --ignore-scripts --ignore-scripts --lockfile-only --cwd . --cache-dir .cache/bun",
        "bun add zod --config ../bunfig.toml --ignore-scripts --lockfile-only --cwd . --cache-dir .cache/bun",
        "bun add zod --global --ignore-scripts --lockfile-only --cwd . --cache-dir .cache/bun",
        "bun add zod --filter app --ignore-scripts --lockfile-only --cwd . --cache-dir .cache/bun",
        "bun add zod --ignore-scripts --lockfile-only --cwd . --cache-dir linked-cache",
        "bun x eslint",
        "uv add requests --no-sync --no-build --no-sources --no-config --no-python-downloads --project ../outside --cache-dir .cache/uv",
        "uv add requests --no-sync --no-build --no-sources --no-config --no-python-downloads --project . --cache-dir /tmp/uv-cache",
        "uv add requests --script tool.py --no-sync --no-build --no-sources --no-config --no-python-downloads --project . --cache-dir .cache/uv",
        "uv add requests --workspace --no-sync --no-build --no-sources --no-config --no-python-downloads --project . --cache-dir .cache/uv",
        "uv add requests --config-file uv.toml --no-sync --no-build --no-sources --no-python-downloads --project . --cache-dir .cache/uv",
        "uv sync --no-build --no-sources --no-config --no-python-downloads --project . --cache-dir .cache/uv",
        "uv sync --locked --no-build --no-sources --no-config --no-env-file --no-python-downloads --no-install-project --no-install-workspace --project . --cache-dir .cache/uv",
        "uv sync --locked --no-build --no-sources --no-config --no-env-file --no-python-downloads --no-install-project --no-install-workspace --no-install-workspace --project . --cache-dir .cache/uv",
        "uv run python -c pass",
        "pixi add python --no-install --offline --no-config --manifest-path ../outside/pixi.toml",
        "pixi add python --no-install --offline --no-config --manifest-path . --config-file pixi.toml",
        "pixi add python --no-install --offline --no-config --manifest-path . --run-post-link-scripts",
        "pixi add --script tool.py python --no-install --offline --no-config --manifest-path .",
        "pixi add python --workspace default --no-install --offline --no-config --manifest-path .",
        "pixi install --offline --no-config --manifest-path .",
        "pixi global install python",
        "pixi run postinstall",
        "sh -c 'npm install zod'",
      ]) {
        expect(core.evaluate({
          action: "codex.unified_exec",
          arguments: { command },
          resource: workspace,
          threadId: "thread-1",
        }).decision).toBe("abstain");
      }
    } finally {
      await rm(workspace, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  test("Babysitter scopes inspection and comments to one explicit pull request", async () => {
    const core = new PolicyCore();
    core.activate(await template("babysitter"), "thread-1");

    for (const command of [
      "gh pr view 42 --repo acme/example",
      "gh pr diff 42 --repo acme/example",
      "gh pr checks 42 --repo acme/example",
      "gh pr checks 42 --repo acme/example --watch",
      'gh pr comment 42 --repo acme/example --body "Reviewed."',
      'gh api --method POST repos/acme/example/pulls/42/comments/987/replies -f body="Fixed in the latest revision."',
    ]) {
      expect(core.evaluate({ action: "codex.unified_exec", arguments: { command }, resource: "/work/example", threadId: "thread-1" }).decision).toBe("allow");
    }

    for (const command of [
      'gh pr comment 43 --repo acme/example --body "Reviewed."',
      'gh pr comment 42 --repo acme/other --body "Reviewed."',
      "gh pr comment --repo acme/example --body Reviewed.",
      "gh pr comment 42 --repo acme/example --body-file /tmp/private-note",
      "gh pr comment 42 --repo acme/example --body Reviewed. --body-file=/tmp/private-note",
      "gh pr comment 42 --repo acme/example --body Reviewed. -F /tmp/private-note",
      'gh pr comment 42 --repo acme/example -R evil/example --body "Reviewed."',
      "gh pr view 42 --repo acme/example --web",
      "gh pr view 42 --repo=acme/example",
      "gh pr checks 42 --repo acme/example --interval 5",
      "gh pr checks 42 --repo acme/example --watch --fail-fast",
      "gh pr view 042 --repo acme/example",
      "gh pr view --repo acme/example",
      "gh pr merge 42 --repo acme/example",
      'gh api --method POST repos/acme/example/pulls/43/comments/987/replies -f body="Wrong pull request."',
      'gh api --method POST repos/acme/other/pulls/42/comments/987/replies -f body="Wrong repository."',
      "gh api --method POST repos/acme/example/pulls/42/comments/987/replies",
      'gh api --method POST repos/acme/example/pulls/42/comments/987/replies -f body=""',
      'gh api --method POST repos/acme/example/pulls/42/comments/987/replies -f body=First -f body=Second',
      'gh api --method POST --method POST repos/acme/example/pulls/42/comments/987/replies -f body="Duplicate method."',
      'gh api --method=POST repos/acme/example/pulls/42/comments/987/replies -f body="Alternate method flag."',
      'gh api -X POST repos/acme/example/pulls/42/comments/987/replies -f body="Alternate method flag."',
      'gh api --method POST repos/acme/example/pulls/42/comments/987/replies --raw-field body="Alternate flag."',
      "gh api --method POST repos/acme/example/pulls/42/comments/987/replies -f body",
      'gh api --method POST repos/acme/example/pulls/42/comments/987 -f body="Alternate endpoint."',
      'gh api --method POST repos/acme/example/pulls/42/comments/987/replies/extra -f body="Alternate endpoint."',
      'gh api --method POST /repos/acme/example/pulls/42/comments/987/replies -f body="Alternate endpoint."',
      'gh api --method POST repos/acme/example/issues/42/comments -f body="Unrelated write."',
      'gh api --method PATCH repos/acme/example/pulls/42/comments/987/replies -f body="Wrong method."',
      'gh api graphql -f query="mutation { addPullRequestReviewThreadReply(input: {}) { clientMutationId } }"',
      'gh api --method POST repos/acme/example/pulls/42/comments/0/replies -f body="Invalid comment ID."',
      'gh api --method POST repos/acme/example/pulls/42/comments/0987/replies -f body="Ambiguous comment ID."',
      'gh api --method POST repos/acme/example/pulls/42/comments/987/replies -f body="Reviewed." --input payload.json',
    ]) {
      expect(core.evaluate({ action: "codex.unified_exec", arguments: { command }, resource: "/work/example", threadId: "thread-1" }).decision).toBe("abstain");
    }

    const multipleTargets = await template("babysitter");
    core.activate({
      ...multipleTargets,
      allowedTargets: new Set([
        "github:pull-request:acme/example#42",
        "github:pull-request:acme/example#43",
      ]),
    }, "thread-2");
    expect(core.evaluate({
      action: "codex.unified_exec",
      arguments: { command: "gh pr view 42 --repo acme/example" },
      resource: "/work/example",
      threadId: "thread-2",
    })).toEqual(expect.objectContaining({
      decision: "abstain",
      reason: "profile requires exactly one allowed target",
    }));
  });

  test("Babysitter's Cedar policy itself rejects another pull request", async () => {
    const babysitter = await template("babysitter");
    const grouping = babysitter.groupings[0] as CedarGrouping;
    expect(grouping.policies).toHaveProperty("allowReviewThreadReplies");

    for (const command of [
      "gh pr view 42 --repo acme/example",
      'gh api --method POST repos/acme/example/pulls/42/comments/987/replies -f body="Reviewed."',
    ]) {
      const request = {
        action: "codex.unified_exec",
        arguments: { command },
        resource: "/work/example",
        threadId: "thread-1",
      };
      const context = {
        policyRevision: babysitter.policyRevision,
        profileId: babysitter.id,
        request,
        resolvedTarget: "github:pull-request:acme/example#42",
      };

      expect(evaluateCedarGrouping(grouping, context)).toBe("allow");
      expect(evaluateCedarGrouping(grouping, {
        ...context,
        resolvedTarget: "github:pull-request:acme/example#43",
      })).toBe("abstain");
    }
  });
});
