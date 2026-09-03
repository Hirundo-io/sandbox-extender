import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PolicyCore, type CedarGrouping, type Profile } from "../src/index.js";
import { evaluateCedarGrouping } from "../src/cedar.js";
import {
  materializeGitHubPullRequest,
  reviewThreadsQuery,
} from "../shared/materializers/requests/github-pull-request.js";
import { materializeMakerDependency } from "../shared/materializers/requests/maker-dependency.js";
import { runFixtureGit } from "./git-fixture.js";

const sharedDirectory = join(process.cwd(), "shared");
const profileTemplateDirectory = join(sharedDirectory, "profile-templates");
const workspaceTarget = process.cwd();
const emptyPermissions = { env: [], ffi: [], net: [], read: [], run: [], sys: [], write: [] };
const watcherPullRequestFields =
  "number,url,state,mergedAt,closedAt,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision";
const watcherChecksFields = "name,state,bucket,link,workflow,event,startedAt,completedAt";

function runGit(workspace: string, ...arguments_: string[]): void {
  const result = runFixtureGit(workspace, arguments_);
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

function reviewThreadsCommand(repository = "acme/example", pullRequest = 42): string {
  const [owner, name] = repository.split("/");
  return `gh api graphql --paginate --slurp -f owner=${owner} -f repo=${name} -F pr=${pullRequest} -f 'query=${reviewThreadsQuery}'`;
}

async function profileTemplate(name: string): Promise<Profile> {
  const candidate: unknown = JSON.parse(
    await readFile(join(profileTemplateDirectory, `${name}.json`), "utf8"),
  );
  const profile = candidate as Omit<Profile, "allowedTargets"> & { allowedTargets: string[] };
  const allowedTargets =
    name === "babysitter"
      ? ["github:pull-request:acme/example#42"]
      : name === "maker"
        ? [workspaceTarget]
        : [workspaceTarget, "github:repository:acme/example"];
  return {
    ...profile,
    allowedTargets: new Set(allowedTargets),
    activationMaterializer: profile.activationMaterializer && {
      ...profile.activationMaterializer,
      file: join(sharedDirectory, profile.activationMaterializer.file),
      reviewedSource: await readFile(
        join(sharedDirectory, profile.activationMaterializer.file),
        "utf8",
      ),
    },
    requestMaterializer: profile.requestMaterializer && {
      ...profile.requestMaterializer,
      file: join(sharedDirectory, profile.requestMaterializer.file),
      reviewedSource: await readFile(
        join(sharedDirectory, profile.requestMaterializer.file),
        "utf8",
      ),
    },
  };
}

describe("shipped Profile templates", () => {
  test("declares only permissions used by each materializer", async () => {
    const babysitter = await profileTemplate("babysitter");
    const maker = await profileTemplate("maker");
    const scout = await profileTemplate("scout");

    expect(babysitter.activationMaterializer?.permissions).toEqual({
      ...emptyPermissions,
      run: ["gh"],
    });
    expect(babysitter.requestMaterializer?.permissions).toEqual({
      ...emptyPermissions,
      env: ["NODE_ENV"],
      read: ["$WORKING_DIRECTORY"],
      run: ["gh"],
    });
    expect(maker.activationMaterializer?.permissions).toEqual(emptyPermissions);
    expect(maker.requestMaterializer?.permissions).toEqual({
      ...emptyPermissions,
      read: ["$REQUEST_RESOURCE", "$WORKING_DIRECTORY"],
    });
    expect(scout.activationMaterializer?.permissions).toEqual(emptyPermissions);
    expect(scout.requestMaterializer?.permissions).toEqual({ ...emptyPermissions, run: ["git"] });

    for (const profile of [babysitter, maker, scout]) {
      expect(profile.activationMaterializer?.reviewedSource).not.toMatch(/\bBun\b/);
      expect(profile.requestMaterializer?.reviewedSource).not.toMatch(/\bBun\b/);
    }
  });

  test("request materializers describe disallowed operations for Cedar", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sandbox-extender-materialized-facts-"));
    try {
      const makerOperation = materializeMakerDependency({
        command: { words: ["npm", "install", "zod"] },
        resource: workspace,
        workingDirectory: workspace,
      });
      expect(makerOperation).toEqual(
        expect.objectContaining({
          command: "install",
          manager: "npm",
          optionCount: 0,
        }),
      );

      const pullRequestOperation = materializeGitHubPullRequest({
        command: { words: ["gh", "pr", "merge", "42", "--repo", "acme/example"] },
      });
      expect(pullRequestOperation).toEqual(
        expect.objectContaining({
          operation: "github.pull-request.merge",
          resource: "github:pull-request:acme/example#42",
        }),
      );

      const maker = await profileTemplate("maker");
      const { resource: _resource, ...materialized } = makerOperation!;
      expect(
        evaluateCedarGrouping(maker.groupings[0] as CedarGrouping, {
          materialized,
          policyRevision: maker.policyRevision,
          profileId: maker.id,
          request: {
            action: "codex.unified_exec",
            arguments: { command: "npm install zod" },
            resource: workspace,
            threadId: "t",
          },
          resolvedTarget: workspace,
        }),
      ).toBe("abstain");
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  test("Scout permits GitHub inspection but not changes", async () => {
    const core = new PolicyCore();
    core.activate(await profileTemplate("scout"), "thread-1");

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
      expect(
        (
          await core.evaluate({
            action: "codex.unified_exec",
            arguments: { command },
            resource: workspaceTarget,
            threadId: "thread-1",
          })
        ).decision,
      ).toBe("allow");
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
      expect(
        (
          await core.evaluate({
            action: "codex.unified_exec",
            arguments: { command },
            resource: workspaceTarget,
            threadId: "thread-1",
          })
        ).decision,
      ).toBe("abstain");
    }
  }, 20_000);

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
      runGit(workspace, "config", "url.ext::sh -c id .insteadOf", "https://unsafe.example/");
      runGit(nested, "init", "--quiet");
      runGit(nested, "remote", "add", "origin", "ext::sh -c id");

      const scout = await profileTemplate("scout");
      const core = new PolicyCore();
      core.activate(
        {
          ...scout,
          allowedTargets: new Set([...scout.allowedTargets, workspace]),
        },
        "thread-1",
      );

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
        const result = await core.evaluate(request);
        if (result.decision !== "allow") throw new Error(`${command}: ${result.reason}`);
        expect(await core.consumeToken(result.token!.id, request)).toBe(true);
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
        expect(
          (
            await core.evaluate({
              action: "codex.unified_exec",
              arguments: { command },
              resource: workspace,
              threadId: "thread-1",
            })
          ).decision,
        ).toBe("abstain");
      }
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  }, 20_000);

  test("Maker permits script-free npm installs inside the effective workspace", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "sandbox-extender-maker-")));
    try {
      const nested = join(workspace, "packages", "app");
      await mkdir(nested, { recursive: true });
      await mkdir(join(workspace, "~", "literal"), { recursive: true });
      const core = new PolicyCore();
      const maker = await profileTemplate("maker");
      core.activate({ ...maker, allowedTargets: new Set([workspace]) }, "thread-1");

      for (const command of [
        "npm install zod --ignore-scripts --global=false --workspaces=false --location=project",
        "npm install zod --ignore-scripts --global=false --workspaces=false --location=project --prefix . --cache .cache/npm",
        "npm install zod --ignore-scripts --package-lock-only --global=false --workspaces=false --location=project --prefix . --cache .cache/npm",
        "npm remove zod --ignore-scripts --global=false --workspaces=false --location=project --prefix . --cache .cache/npm",
        "bun add zod --ignore-scripts --lockfile-only --cwd . --cache-dir .cache/bun",
        "bun remove zod --ignore-scripts --lockfile-only --cwd . --cache-dir .cache/bun",
        "uv add requests --no-sync --no-build --no-sources --no-config --no-python-downloads --project . --cache-dir .cache/uv",
        "uv remove requests --no-sync --no-build --no-sources --no-config --no-python-downloads --project . --cache-dir .cache/uv",
        "uv lock --no-build --no-sources --no-config --no-python-downloads --project . --cache-dir .cache/uv",
        "pixi add python=3.12 --no-install --offline --no-config --manifest-path .",
        "pixi remove python --no-install --offline --no-config --manifest-path .",
        "pixi lock --no-install --offline --no-config --manifest-path .",
        "cd packages/app && bun add zod --ignore-scripts --lockfile-only --cwd . --cache-dir .cache/bun",
        'cd "~/literal" && bun add zod --ignore-scripts --lockfile-only --cwd . --cache-dir .cache/bun',
      ]) {
        const request = {
          action: "codex.unified_exec",
          arguments: { command },
          resource: workspace,
          threadId: "thread-1",
        };
        const result = await core.evaluate(request);
        if (result.decision !== "allow") throw new Error(`${command}: ${result.reason}`);
        expect(await core.consumeToken(result.token!.id, request)).toBe(true);
      }
      const builtinRequest = {
        action: "codex.unified_exec",
        arguments: { command: "echo dependency-check" },
        resource: workspace,
        threadId: "thread-1",
      };
      const builtinResult = await core.evaluate(builtinRequest);
      expect(builtinResult.decision).toBe("allow");
      expect(await core.consumeToken(builtinResult.token!.id, builtinRequest)).toBe(true);
      expect(maker.sessionContext).toContain(
        "No high/critical known vulnerabilities; inspect lockfiles and audit data.",
      );
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  }, 20_000);

  test("Maker abstains from destination, configuration, lifecycle, and interpreter escapes", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "sandbox-extender-maker-deny-")));
    const outside = await mkdtemp(join(tmpdir(), "sandbox-extender-maker-outside-"));
    try {
      await symlink(outside, join(workspace, "linked-cache"));
      const core = new PolicyCore();
      const maker = await profileTemplate("maker");
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
        "npm install zod --ignore-scripts --global=false --workspaces=false --location=project --prefix packages/app",
        "npm install zod@.. --ignore-scripts --global=false --workspaces=false --location=project --prefix . --cache .cache/npm",
        "npm update --ignore-scripts --global=false --workspaces=false --location=project --prefix . --cache .cache/npm",
        "npm up --ignore-scripts --global=false --workspaces=false --location=project --prefix . --cache .cache/npm",
        "npm exec eslint",
        "bun add zod --ignore-scripts --lockfile-only --cwd ~/outside --cache-dir .cache/bun",
        "cd ~",
        "cd ~/outside",
        "cd ~ && bun add zod --ignore-scripts --lockfile-only --cwd . --cache-dir .cache/bun",
        "cd ~/outside && bun add zod --ignore-scripts --lockfile-only --cwd . --cache-dir .cache/bun",
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
        expect(
          (
            await core.evaluate({
              action: "codex.unified_exec",
              arguments: { command },
              resource: workspace,
              threadId: "thread-1",
            })
          ).decision,
        ).toBe("abstain");
      }
    } finally {
      await rm(workspace, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  }, 30_000);

  test("Babysitter scopes inspection and comments to one explicit pull request", async () => {
    const core = new PolicyCore();
    core.activate(await profileTemplate("babysitter"), "thread-1");

    for (const command of [
      "gh pr view 42 --repo acme/example",
      "gh pr diff 42 --repo acme/example",
      "gh pr checks 42 --repo acme/example",
      "gh pr checks 42 --repo acme/example --watch",
      `gh -R acme/example pr view 42 --json ${watcherPullRequestFields}`,
      `gh -R acme/example pr checks 42 --json ${watcherChecksFields}`,
      'gh pr comment 42 --repo acme/example --body "Reviewed."',
      'gh api --method POST repos/acme/example/issues/42/comments -f body="_Replying as Codex. Reviewed."',
      "gh api 'repos/acme/example/issues/42/comments?per_page=100&page=1'",
      "gh api 'repos/acme/example/pulls/42/reviews?per_page=100&page=1'",
      reviewThreadsCommand(),
      'view_pr() { gh pr view "$1" --repo "$2"; }\nview_pr 42 acme/example',
      'comment() { gh api --method POST repos/acme/example/issues/42/comments -f "body=$1"; }\ncomment "_Replying as Codex. Reviewed."',
    ]) {
      const result = await core.evaluate({
        action: "codex.unified_exec",
        arguments: { command },
        resource: workspaceTarget,
        threadId: "thread-1",
      });
      expect({ command, decision: result.decision }).toEqual({
        command,
        decision: "allow",
      });
    }

    expect(
      (
        await core.evaluate({
          action: "codex.unified_exec",
          arguments: {
            command:
              'gh api --method POST repos/acme/example/pulls/42/comments/987/replies -f body="_Replying as Codex. Fixed in the latest revision."',
          },
          resource: workspaceTarget,
          threadId: "thread-1",
        })
      ).decision,
    ).toBe("abstain");

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
      "gh api --method POST repos/acme/example/pulls/42/comments/987/replies -f body=First -f body=Second",
      'gh api --method POST --method POST repos/acme/example/pulls/42/comments/987/replies -f body="Duplicate method."',
      'gh api --method=POST repos/acme/example/pulls/42/comments/987/replies -f body="Alternate method flag."',
      'gh api -X POST repos/acme/example/pulls/42/comments/987/replies -f body="Alternate method flag."',
      'gh api --method POST repos/acme/example/pulls/42/comments/987/replies --raw-field body="Alternate flag."',
      "gh api --method POST repos/acme/example/pulls/42/comments/987/replies -f body",
      'gh api --method POST repos/acme/example/pulls/42/comments/987 -f body="Alternate endpoint."',
      'gh api --method POST repos/acme/example/pulls/42/comments/987/replies/extra -f body="Alternate endpoint."',
      'gh api --method POST /repos/acme/example/pulls/42/comments/987/replies -f body="Alternate endpoint."',
      'gh api --method POST repos/acme/example/issues/42/comments -f body="Unrelated write."',
      'gh api --method POST repos/acme/example/issues/43/comments -f body="_Replying as Codex. Wrong pull request."',
      'gh api --method POST repos/acme/other/issues/42/comments -f body="_Replying as Codex. Wrong repository."',
      'gh api --method POST repos/acme/example/issues/42/comments -f body=""',
      'gh api --method POST repos/acme/example/issues/42/comments -F body="_Replying as Codex. Unsafe field form."',
      "gh auth status",
      "gh auth token",
      "gh api user",
      "gh api user --jq .login",
      "gh api rate_limit",
      "gh api repos/acme/example/actions/secrets",
      "show_token() { gh auth token; }\nshow_token",
      'gh api --method PATCH repos/acme/example/pulls/42/comments/987/replies -f body="Wrong method."',
      'gh api graphql -f query="mutation { addPullRequestReviewThreadReply(input: {}) { clientMutationId } }"',
      reviewThreadsCommand("acme/other"),
      reviewThreadsCommand("acme/example", 43),
      `${reviewThreadsCommand()} --paginate`,
      "gh api graphql -f 'query=query { viewer { login } }' -F owner=acme -F name=example -F number=42",
      'gh api --method POST repos/acme/example/pulls/42/comments/0/replies -f body="Invalid comment ID."',
      'gh api --method POST repos/acme/example/pulls/42/comments/0987/replies -f body="Ambiguous comment ID."',
      'gh api --method POST repos/acme/example/pulls/42/comments/987/replies -f body="Reviewed." --input payload.json',
    ]) {
      expect(
        (
          await core.evaluate({
            action: "codex.unified_exec",
            arguments: { command },
            resource: workspaceTarget,
            threadId: "thread-1",
          })
        ).decision,
      ).toBe("abstain");
    }

    const multipleTargets = await profileTemplate("babysitter");
    core.activate(
      {
        ...multipleTargets,
        allowedTargets: new Set([
          "github:pull-request:acme/example#42",
          "github:pull-request:acme/example#43",
        ]),
      },
      "thread-2",
    );
    expect(
      await core.evaluate({
        action: "codex.unified_exec",
        arguments: { command: "gh pr view 42 --repo acme/example" },
        resource: workspaceTarget,
        threadId: "thread-2",
      }),
    ).toEqual(
      expect.objectContaining({
        decision: "abstain",
        reason: "profile requires exactly one allowed target",
      }),
    );
  }, 30_000);

  test("Babysitter's Cedar policy decides from materialized request facts", async () => {
    const babysitter = await profileTemplate("babysitter");
    const grouping = babysitter.groupings[0] as CedarGrouping;
    expect(grouping.policies).toHaveProperty("allowReviewThreadReplies");

    for (const command of [
      "gh pr view 42 --repo acme/example",
      'gh api --method POST repos/acme/example/pulls/42/comments/987/replies -f body="_Replying as Codex. Reviewed."',
      reviewThreadsCommand(),
    ]) {
      const request = {
        action: "codex.unified_exec",
        arguments: { command },
        resource: workspaceTarget,
        threadId: "thread-1",
      };
      const context = {
        materialized: {
          bodyPresent: true,
          operation:
            command === reviewThreadsCommand()
              ? "github.pull-request.review-threads"
              : command.startsWith("gh api")
                ? "github.review-comment.reply"
                : "github.pull-request.view",
          trailingArgumentCount: 0,
          trailingArguments: [],
        },
        policyRevision: babysitter.policyRevision,
        profileId: babysitter.id,
        request,
        resolvedTarget: "github:pull-request:acme/example#42",
      };

      expect(evaluateCedarGrouping(grouping, context)).toBe("allow");
      expect(
        evaluateCedarGrouping(grouping, {
          ...context,
          materialized: { ...context.materialized, operation: "github.pull-request.merge" },
        }),
      ).toBe("abstain");
    }

    const checksRequest = {
      action: "codex.unified_exec",
      arguments: { command: "gh pr checks 42 --json name,state,bucket,link,workflow" },
      resource: workspaceTarget,
      threadId: "thread-1",
    };
    const checksContext = {
      materialized: {
        bodyPresent: false,
        operation: "github.pull-request.checks",
        trailingArgumentCount: 2,
        trailingArguments: ["--json", "name,state,bucket,link,workflow"],
      },
      policyRevision: babysitter.policyRevision,
      profileId: babysitter.id,
      request: checksRequest,
      resolvedTarget: "github:pull-request:acme/example#42",
    };
    expect(evaluateCedarGrouping(grouping, checksContext)).toBe("allow");
    expect(
      evaluateCedarGrouping(grouping, {
        ...checksContext,
        materialized: {
          ...checksContext.materialized,
          trailingArguments: ["--json", "name,state,bucket,link,workflow,event"],
        },
      }),
    ).toBe("abstain");
    for (const operation of [
      "github.pull-request.conversation-comments",
      "github.pull-request.reviews",
      "github.actions.runs",
      "github.actions.jobs",
      "github.actions.run-view",
      "github.actions.rerun-failed",
    ]) {
      expect(
        evaluateCedarGrouping(grouping, {
          ...checksContext,
          materialized: {
            ...checksContext.materialized,
            operation,
            trailingArgumentCount: 0,
            trailingArguments: [],
          },
        }),
      ).toBe("allow");
    }
  });
});
