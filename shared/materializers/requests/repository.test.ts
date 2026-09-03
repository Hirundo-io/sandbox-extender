import { describe, expect, test } from "bun:test";

import { materializeRepository, runGit, runRepositoryMaterializer } from "./repository.js";

function candidate(
  words: readonly unknown[],
  resource = "/work",
  workingDirectory = resource,
): unknown {
  return { command: { words }, resource, workingDirectory };
}

function gitRemote(remote?: string) {
  return (arguments_: readonly string[]) => {
    expect(arguments_.slice(0, -1)).toEqual(["-C", "/work", "ls-remote", "--get-url", "--"]);
    expect(typeof arguments_.at(-1)).toBe("string");
    return {
      code: remote === undefined ? 1 : 0,
      stdout: new TextEncoder().encode(remote ?? ""),
    };
  };
}

describe("repository request materializer", () => {
  test("materializes GitHub operations and counts duplicate long options", () => {
    expect(
      materializeRepository(
        candidate(["gh", "pr", "view", "--repo", "Acme/Example", "--json", "url", "--json=title"]),
      ),
    ).toEqual({
      argumentsSafe: true,
      duplicateOptionCount: 1,
      localSafe: false,
      operation: "github.pr.view",
      remoteSafe: true,
      resource: "github:repository:acme/example",
    });
    expect(materializeRepository(candidate(["gh", "repo", "list", "--repo=acme/example"]))).toEqual(
      expect.objectContaining({ operation: "github.repo.list" }),
    );
  });

  test("materializes safe Git remote inspection", () => {
    const execute = gitRemote("https://github.com/acme/example.git");
    expect(
      materializeRepository(candidate(["git", "fetch", "--dry-run", "origin"]), execute),
    ).toEqual(
      expect.objectContaining({ argumentsSafe: true, operation: "git.fetch", remoteSafe: true }),
    );
    expect(
      materializeRepository(
        candidate(["git", "ls-remote", "--heads", "--", "origin", "refs/heads/main"]),
        execute,
      ),
    ).toEqual(
      expect.objectContaining({
        argumentsSafe: true,
        operation: "git.ls-remote",
        remoteSafe: true,
      }),
    );
    expect(
      materializeRepository(
        candidate(["git", "ls-remote", "origin"]),
        gitRemote("git@github.com:acme/example.git"),
      ),
    ).toEqual(expect.objectContaining({ remoteSafe: true }));
  });

  test("materializes allowlisted local Git inspection", () => {
    for (const words of [
      ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "status"],
      ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--short"],
      ["git", "-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv"],
      [
        "git",
        "-c",
        "core.fsmonitor=false",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--check",
        "--name-only",
      ],
      ["git", "log", "HEAD"],
      ["git", "show", "HEAD"],
      ["git", "rev-parse", "HEAD"],
      ["git", "branch", "--show-current"],
      ["git", "config", "--get", "core.hooksPath"],
    ]) {
      expect(materializeRepository(candidate(words))).toEqual(
        expect.objectContaining({
          argumentsSafe: true,
          duplicateOptionCount: 0,
          localSafe: true,
          remoteSafe: false,
          resource: "/work",
        }),
      );
    }

    for (const words of [
      ["git", "status"],
      ["git", "-c", "core.fsmonitor=false", "status"],
      ["git", "diff", "--check"],
      ["git", "-c", "core.fsmonitor=false", "diff", "--check"],
    ]) {
      expect(materializeRepository(candidate(words))).toBeUndefined();
    }
  });

  test("does not bind local inspection from another directory", () => {
    expect(
      materializeRepository(
        candidate(
          ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "status"],
          "/work",
          "/work/nested",
        ),
      ),
    ).toEqual(expect.objectContaining({ localSafe: false }));
  });

  test("uses git to resolve a remote by default", () => {
    const output = {
      code: 0,
      stdout: new TextEncoder().encode("https://github.com/acme/example.git"),
    };
    class Command {
      outputSync() {
        return output;
      }
    }
    expect(runGit(["status"], Command)).toEqual(output);
  });

  test("reports unsafe and unavailable Git remotes", () => {
    expect(
      materializeRepository(candidate(["git", "ls-remote", "helper"]), gitRemote("ext::sh -c id")),
    ).toEqual(expect.objectContaining({ remoteSafe: false }));
    expect(materializeRepository(candidate(["git", "ls-remote", "missing"]), gitRemote())).toEqual(
      expect.objectContaining({ remoteSafe: false }),
    );
    expect(materializeRepository(candidate(["git", "ls-remote", "empty"]), gitRemote(""))).toEqual(
      expect.objectContaining({ remoteSafe: false }),
    );
    expect(
      materializeRepository(candidate(["git", "ls-remote", "multiple"]), gitRemote("one\ntwo")),
    ).toEqual(expect.objectContaining({ remoteSafe: false }));
    expect(
      materializeRepository(candidate(["git", "ls-remote", "http://["]), gitRemote("http://[")),
    ).toEqual(expect.objectContaining({ remoteSafe: false }));
    expect(
      materializeRepository(
        candidate(["git", "ls-remote", "origin"]),
        gitRemote("https://example.com/acme/repo.git"),
      ),
    ).toEqual(expect.objectContaining({ remoteSafe: false }));
  });

  test("writes the executable result and reports invalid input", async () => {
    const output: string[] = [];
    expect(
      await runRepositoryMaterializer(
        Promise.resolve(candidate(["gh", "repo", "view", "--repo", "acme/example"])),
        output.push.bind(output),
      ),
    ).toBe(true);
    expect(JSON.parse(output[0]!)).toEqual(
      expect.objectContaining({ resource: "github:repository:acme/example" }),
    );
    expect(await runRepositoryMaterializer(Promise.resolve({}))).toBe(false);
  });

  test.each([
    undefined,
    null,
    {},
    { command: null },
    candidate(["git", 1]),
    candidate(["other"]),
    candidate(Object.assign(["git", "fetch", "--dry-run"], { length: 4 })),
    candidate(["gh", "pr", "view"]),
    candidate(["gh", "pr", "view", "--repo", "invalid"]),
    candidate(["git", "fetch", "origin"]),
    candidate(["git", "fetch", "--dry-run", "-x"]),
    candidate(["git", "push", "origin"]),
    candidate(["git", "ls-remote", "--upload-pack=sh", "origin"]),
    candidate(["git", "status", "--porcelain"]),
    candidate(["git", "diff", "--output=/tmp/diff"]),
    candidate(["git", "log", "--config=alias.log=!sh"]),
    candidate(["git", "show", "--no-ext-diff"]),
    candidate(["git", "rev-parse", "--git-path", "hooks"]),
    candidate(["git", "branch", "--show-current", "main"]),
    candidate(["git", "config", "--get", "core.sshCommand"]),
  ])("rejects unsupported input %#", (value) =>
    expect(materializeRepository(value)).toBeUndefined(),
  );
});
