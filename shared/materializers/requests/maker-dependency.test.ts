import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalExistingAncestor,
  materializeMakerDependency,
  runMakerDependencyMaterializer,
} from "./maker-dependency.js";

const temporaryDirectories: string[] = [];

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "dependency-materializer-"));
  temporaryDirectories.push(directory);
  return directory;
}

function candidate(root: string, words: readonly unknown[], workingDirectory = root): unknown {
  return { command: { words }, resource: root, workingDirectory };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

describe("Maker dependency request materializer", () => {
  test.each([
    ["npm", ["npm", "install", "zod@4", "--ignore-scripts", "--cache", ".cache", "--prefix=."]],
    [
      "npm",
      [
        "npm",
        "install",
        "zod@4",
        "--ignore-scripts",
        "--package-lock-only",
        "--cache",
        ".cache",
        "--prefix=.",
      ],
    ],
    [
      "bun",
      [
        "bun",
        "add",
        "zod@4",
        "--ignore-scripts",
        "--lockfile-only",
        "--cache-dir",
        ".cache",
        "--cwd=.",
      ],
    ],
    [
      "uv",
      [
        "uv",
        "add",
        "requests>=2",
        "--no-build",
        "--no-config",
        "--no-python-downloads",
        "--no-sources",
        "--no-sync",
        "--cache-dir",
        ".cache",
        "--project=.",
      ],
    ],
    [
      "pixi",
      [
        "pixi",
        "add",
        "conda-forge::python=3.12",
        "--no-config",
        "--no-install",
        "--offline",
        "--manifest-path",
        ".",
      ],
    ],
  ])("materializes %s dependency operations", (manager, words) => {
    const root = workspace();
    expect(materializeMakerDependency(candidate(root, words))).toEqual(
      expect.objectContaining({
        duplicateOptionCount: 0,
        manager,
        npmPrefixValid: true,
        pathsWithinWorkspace: true,
        positionalsValid: true,
        resource: root,
        unknownOptionCount: 0,
      }),
    );
  });

  test("reports policy-relevant unsafe facts instead of deciding", () => {
    const root = workspace();
    const outside = workspace();
    symlinkSync(outside, join(root, "linked"));
    expect(
      materializeMakerDependency(
        candidate(root, [
          "npm",
          "remove",
          "bad@version",
          "--ignore-scripts",
          "--ignore-scripts",
          "--package-lock-only",
          "--unknown",
          "--cache",
          "linked",
        ]),
      ),
    ).toEqual(
      expect.objectContaining({
        duplicateOptionCount: 1,
        pathsWithinWorkspace: false,
        positionalsValid: false,
        unknownOptionCount: 1,
      }),
    );
  });

  test("handles commands without package arguments where allowed", () => {
    const root = workspace();
    expect(materializeMakerDependency(candidate(root, ["uv", "lock"]))).toEqual(
      expect.objectContaining({ command: "lock", positionalsValid: true }),
    );
    expect(materializeMakerDependency(candidate(root, ["pixi", "remove"]))).toEqual(
      expect.objectContaining({ positionalsValid: false }),
    );
  });

  test.each([
    ["install", "zod@."],
    ["install", "zod@.."],
    ["install", "@types/node@.."],
    ["update", undefined],
    ["up", undefined],
  ])("rejects unsafe npm %s positional %#", (command, positional) => {
    const root = workspace();
    const words = ["npm", command, ...(positional ? [positional] : [])];
    expect(materializeMakerDependency(candidate(root, words))).toEqual(
      expect.objectContaining({ positionalsValid: false }),
    );
  });

  test.each([
    ["bun", "install"],
    ["bun", "update"],
    ["pixi", "update"],
  ])("allows bulk %s %s positionals", (manager, command) => {
    const root = workspace();
    expect(materializeMakerDependency(candidate(root, [manager, command]))).toEqual(
      expect.objectContaining({ positionalsValid: true }),
    );
  });

  test("accepts a missing descendant of the effective workspace", () => {
    const root = workspace();
    expect(
      materializeMakerDependency(
        candidate(root, ["npm", "install", "zod", "--ignore-scripts", "--cache", "missing/cache"]),
      ),
    ).toEqual(expect.objectContaining({ pathsWithinWorkspace: true }));
  });

  test("allows an omitted npm prefix but only accepts dot when it is explicit", () => {
    const root = workspace();
    expect(materializeMakerDependency(candidate(root, ["npm", "install", "zod"]))).toEqual(
      expect.objectContaining({ npmPrefixValid: true }),
    );
    expect(
      materializeMakerDependency(candidate(root, ["npm", "install", "zod", "--prefix", "app"])),
    ).toEqual(expect.objectContaining({ npmPrefixValid: false }));
  });

  test("fails closed on an unreadable ancestor", () => {
    expect(
      canonicalExistingAncestor("/workspace", () => {
        throw { code: "EACCES" };
      }),
    ).toBeUndefined();
  });

  test("rejects an option whose required value is missing", () => {
    const root = workspace();
    expect(
      materializeMakerDependency(candidate(root, ["npm", "install", "zod", "--cache"])),
    ).toBeUndefined();
  });

  test("accepts a nested working directory and rejects escapes", () => {
    const root = workspace();
    const nested = join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    expect(materializeMakerDependency(candidate(root, ["bun", "remove", "zod"], nested))).toEqual(
      expect.objectContaining({ manager: "bun" }),
    );
    expect(
      materializeMakerDependency(candidate(root, ["bun", "remove", "zod"], tmpdir())),
    ).toBeUndefined();
  });

  test("writes the executable result and reports invalid input", async () => {
    const root = workspace();
    const output: string[] = [];
    expect(
      await runMakerDependencyMaterializer(
        Promise.resolve(candidate(root, ["uv", "lock"])),
        output.push.bind(output),
      ),
    ).toBe(true);
    expect(JSON.parse(output[0]!)).toEqual(expect.objectContaining({ resource: root }));
    expect(await runMakerDependencyMaterializer(Promise.resolve({}))).toBe(false);
  });

  test.each([
    undefined,
    null,
    {},
    { command: null },
    { resource: "relative", workingDirectory: "relative", command: { words: [] } },
    { resource: "/tmp", workingDirectory: "/tmp", command: { words: "npm" } },
    { resource: "/tmp", workingDirectory: "/tmp", command: { words: ["npm", 1] } },
    { resource: "/tmp", workingDirectory: "/tmp", command: { words: ["other"] } },
    { resource: "/tmp", workingDirectory: "/tmp", command: { words: ["constructor"] } },
    { resource: "/tmp", workingDirectory: "/tmp", command: { words: ["toString"] } },
    { resource: "/tmp", workingDirectory: "/tmp", command: { words: ["__proto__"] } },
    { resource: "/tmp", workingDirectory: "/tmp", command: { words: ["npm"] } },
    { resource: "/tmp", workingDirectory: "/tmp", command: { words: ["bun"] } },
    { resource: "/tmp", workingDirectory: "/tmp", command: { words: ["uv"] } },
    { resource: "/tmp", workingDirectory: "/tmp", command: { words: ["pixi"] } },
  ])("rejects unsupported input %#", (value) =>
    expect(materializeMakerDependency(value)).toBeUndefined(),
  );
});
