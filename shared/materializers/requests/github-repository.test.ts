import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { materializeGitHubRepository, runGitHubRepositoryMaterializer } from "./github-repository.js";

const temporaryDirectories: string[] = [];

function candidate(words: readonly unknown[], resource = "/work", workingDirectory = resource): unknown {
  return { command: { words }, resource, workingDirectory };
}

function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), "repository-materializer-"));
  temporaryDirectories.push(directory);
  Bun.spawnSync(["git", "-C", directory, "init", "--quiet"]);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("GitHub repository request materializer", () => {
  test("materializes GitHub operations and counts duplicate long options", () => {
    expect(materializeGitHubRepository(candidate(["gh", "pr", "view", "--repo", "Acme/Example", "--json", "url", "--json=title"])))
      .toEqual({ argumentsSafe: true, duplicateOptionCount: 1, operation: "github.pr.view", remoteSafe: true,
        resource: "github:repository:acme/example" });
    expect(materializeGitHubRepository(candidate(["gh", "repo", "list", "--repo=acme/example"])))
      .toEqual(expect.objectContaining({ operation: "github.repo.list" }));
  });

  test("materializes safe Git remote inspection", () => {
    const directory = repository();
    Bun.spawnSync(["git", "-C", directory, "remote", "add", "origin", "https://github.com/acme/example.git"]);
    expect(materializeGitHubRepository(candidate(["git", "fetch", "--dry-run", "origin"], directory)))
      .toEqual(expect.objectContaining({ argumentsSafe: true, operation: "git.fetch", remoteSafe: true }));
    expect(materializeGitHubRepository(candidate(["git", "ls-remote", "--heads", "--", "origin", "refs/heads/main"], directory)))
      .toEqual(expect.objectContaining({ argumentsSafe: true, operation: "git.ls-remote", remoteSafe: true }));
  });

  test("reports unsafe and unavailable Git remotes", () => {
    const directory = repository();
    Bun.spawnSync(["git", "-C", directory, "remote", "add", "helper", "ext::sh -c id"]);
    expect(materializeGitHubRepository(candidate(["git", "ls-remote", "helper"], directory)))
      .toEqual(expect.objectContaining({ remoteSafe: false }));
    expect(materializeGitHubRepository(candidate(["git", "ls-remote", "missing"], directory)))
      .toEqual(expect.objectContaining({ remoteSafe: false }));
    expect(materializeGitHubRepository(candidate(["git", "ls-remote", "http://["], directory)))
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
