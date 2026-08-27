import { describe, expect, test } from "bun:test";

import { materializeGitHubRepository, runGitHubRepositoryMaterializer } from "./github-repository.js";

function candidate(words: readonly unknown[], resource = "/work", workingDirectory = resource): unknown {
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

describe("GitHub repository request materializer", () => {
  test("materializes GitHub operations and counts duplicate long options", () => {
    expect(materializeGitHubRepository(candidate(["gh", "pr", "view", "--repo", "Acme/Example", "--json", "url", "--json=title"])))
      .toEqual({ argumentsSafe: true, duplicateOptionCount: 1, operation: "github.pr.view", remoteSafe: true,
        resource: "github:repository:acme/example" });
    expect(materializeGitHubRepository(candidate(["gh", "repo", "list", "--repo=acme/example"])))
      .toEqual(expect.objectContaining({ operation: "github.repo.list" }));
  });

  test("materializes safe Git remote inspection", () => {
    const execute = gitRemote("https://github.com/acme/example.git");
    expect(materializeGitHubRepository(candidate(["git", "fetch", "--dry-run", "origin"]), execute))
      .toEqual(expect.objectContaining({ argumentsSafe: true, operation: "git.fetch", remoteSafe: true }));
    expect(materializeGitHubRepository(
      candidate(["git", "ls-remote", "--heads", "--", "origin", "refs/heads/main"]),
      execute,
    ))
      .toEqual(expect.objectContaining({ argumentsSafe: true, operation: "git.ls-remote", remoteSafe: true }));
  });

  test("reports unsafe and unavailable Git remotes", () => {
    expect(materializeGitHubRepository(candidate(["git", "ls-remote", "helper"]), gitRemote("ext::sh -c id")))
      .toEqual(expect.objectContaining({ remoteSafe: false }));
    expect(materializeGitHubRepository(candidate(["git", "ls-remote", "missing"]), gitRemote()))
      .toEqual(expect.objectContaining({ remoteSafe: false }));
    expect(materializeGitHubRepository(candidate(["git", "ls-remote", "http://["]), gitRemote("http://[")))
      .toEqual(expect.objectContaining({ remoteSafe: false }));
  });

  test("writes the executable result and reports invalid input", async () => {
    const output: string[] = [];
    expect(await runGitHubRepositoryMaterializer(Promise.resolve(
      candidate(["gh", "repo", "view", "--repo", "acme/example"]),
    ), output.push.bind(output))).toBe(true);
    expect(JSON.parse(output[0]!)).toEqual(expect.objectContaining({ resource: "github:repository:acme/example" }));
    expect(await runGitHubRepositoryMaterializer(Promise.resolve({}))).toBe(false);
  });

  test.each([
    undefined, null, {}, { command: null }, candidate(["git", 1]), candidate(["other"]),
    candidate(["gh", "pr", "view"]), candidate(["gh", "pr", "view", "--repo", "invalid"]),
    candidate(["git", "fetch", "origin"]), candidate(["git", "fetch", "--dry-run", "-x"]),
    candidate(["git", "push", "origin"]), candidate(["git", "ls-remote", "--upload-pack=sh", "origin"]),
  ])("rejects unsupported input %#", (value) => expect(materializeGitHubRepository(value)).toBeUndefined());
});
