import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalExistingAncestor,
  materializeMakerDependency,
  materializeMakerActivation,
  materializeMakerRequest,
  runMakerMaterializer,
  runMakerDependencyMaterializer,
} from "./maker-dependency.js";

const temporaryDirectories: string[] = [];

function workspace(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "dependency-materializer-")));
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

  test.each([
    ["pixi.toml", "[pypi-options]\nno-build = true", true],
    ["pixi.toml", "[workspace.pypi-options]\nno-build = true", true],
    ["pyproject.toml", "[tool.pixi.workspace.pypi-options]\nno-build = true", true],
    [
      "pixi.toml",
      "[workspace.pypi-options]\nno-build = true\n[environments.ci]\nno-default-feature=true\nfeatures=[]",
      true,
    ],
    ...["false", "'bad'", "[]", "[1]"].map(
      (value) =>
        ["pixi.toml", `environments=${value}\n[pypi-options]\nno-build=true`, false] as const,
    ),
    ...[
      "false",
      "'bad'",
      "[1]",
      "{features=['ci'], no-default-feature='true'}",
      "{features=false}",
    ].map(
      (value) =>
        ["pixi.toml", `[pypi-options]\nno-build=true\n[environments]\nci=${value}`, false] as const,
    ),
    ["pyproject.toml", "[tool.pixi.pypi-options]\nno-build = true", true],
    ["pyproject.toml", "[tool.uv]\nno-build = true", false],
    ["pixi.toml", "[pypi-options]\nno-build = false", false],
    ["pixi.toml", "[pypi-options]\nno-build = ['a']", false],
    ["pixi.toml", "# no-build = true", false],
    ["pixi.toml", "[pypi-options]\nno-build = 'true'", false],
    ["pixi.toml", "[pypi-options]\nno-build = true\nno-build = false", false],
    [
      "pixi.toml",
      "[pypi-options]\nno-build = true\n[environments.ci]\nno-default-feature=true",
      false,
    ],
    ["pixi.toml", "[pypi-options]\nno-build = true\n[environments]\nci=['test']", true],
    ["pixi.toml", "[pypi-options]\nno-build = true\n[environments.ci]\nfeatures=['test']", true],
  ])("checks %s no-build configuration %#", (name, manifest, expected) => {
    const root = workspace();
    writeFileSync(join(root, name), manifest);
    expect(
      materializeMakerDependency(
        candidate(root, ["pixi", "lock", "--manifest-path", name]),
        (path) => readFileSync(path, "utf8"),
      )?.pypiNoBuild,
    ).toBe(expected);
  });

  test("checks no-build on features that replace the default environment", () => {
    const root = workspace();
    const words = ["pixi", "lock", "--manifest-path", "pixi.toml"];
    for (const [setting, expected] of [
      ["true", true],
      ["false", false],
    ] as const) {
      writeFileSync(
        join(root, "pixi.toml"),
        `[pypi-options]
no-build = true
[feature.ci.pypi-options]
no-build = ${setting}
[environments.ci]
no-default-feature = true
features = ["ci"]
`,
      );
      expect(
        materializeMakerDependency(candidate(root, words), (path) => readFileSync(path, "utf8"))
          ?.pypiNoBuild,
      ).toBe(expected);
    }
  });

  test("fails closed if the runtime manifest reader is unavailable", () => {
    const root = workspace();
    expect(
      materializeMakerDependency(candidate(root, ["pixi", "lock", "--manifest-path", "pixi.toml"]))
        ?.pypiNoBuild,
    ).toBe(false);
  });

  test("rejects missing, directory-discovered, and escaped manifests", () => {
    const root = workspace();
    const outside = workspace();
    writeFileSync(join(outside, "pixi.toml"), "[pypi-options]\nno-build=true");
    symlinkSync(join(outside, "pixi.toml"), join(root, "pixi.toml"));
    for (const name of ["pixi.toml", ".", "missing/pyproject.toml", "../pixi.toml"]) {
      expect(
        materializeMakerDependency(
          candidate(root, ["pixi", "lock", "--manifest-path", name]),
          (path) => readFileSync(path, "utf8"),
        )?.pypiNoBuild,
      ).toBe(false);
    }
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

function gitFacts(root: string, overrides: Readonly<Record<string, string | undefined>> = {}) {
  const facts: Readonly<Record<string, string | undefined>> = {
    "rev-parse --show-toplevel": root,
    "symbolic-ref --quiet --short HEAD": "feature",
    "check-ref-format refs/heads/feature": "",
    "remote get-url --push --all origin": "https://github.com/acme/repo.git",
    "rev-parse --git-path hooks": ".git/hooks",
    ...overrides,
  };
  return (_workspace: string, args: readonly string[]) => facts[args.join(" ")];
}

describe("Maker push grants", () => {
  test("freezes workspace, GitHub remote, branch and repository hook directory", () => {
    const root = workspace();
    const git = gitFacts(root);
    const activation = materializeMakerActivation({ workspace: root, push: true }, git);
    expect(activation).toHaveLength(2);
    const result = materializeMakerRequest(
      candidate(root, ["git", "push", "origin", "HEAD:refs/heads/feature"]),
      git,
    );
    expect(result?.resource).toBe(activation![1]!);
    expect(materializeMakerActivation({ workspace: root }, git)).toEqual([root]);
    expect(materializeMakerRequest(candidate(root, ["npm", "install", "zod"]), git)).toHaveProperty(
      "manager",
      "npm",
    );
    expect(
      materializeMakerActivation(
        { workspace: root, push: true },
        gitFacts(root, { "config --show-scope --get core.hooksPath": "local\t.hooks" }),
      ),
    ).toHaveLength(2);
  });
  test.each([
    ["rev-parse --show-toplevel", "/elsewhere"],
    ["symbolic-ref --quiet --short HEAD", undefined],
    ["symbolic-ref --quiet --short HEAD", "bad name"],
    ["check-ref-format refs/heads/feature", undefined],
    ["remote get-url --push --all origin", "ext::evil"],
    [
      "remote get-url --push --all origin",
      "https://github.com/acme/repo.git\nhttps://github.com/acme/other.git",
    ],
    ["remote get-url --push --all origin", undefined],
    ["config --get-all remote.origin.mirror", "true"],
    ["config --get-all push.followTags", "true"],
    ["config --get-all push.recurseSubmodules", "on-demand"],
    ["config --get-all push.gpgSign", "true"],
    ["config --get-all remote.origin.receivepack", "evil"],
    ["config --get-all remote.origin.vcs", "evil"],
    ["config --get-all push.pushOption", "evil"],
    ["config --get-all core.sshCommand", "evil"],
    ["config --get-all core.gitProxy", "evil"],
    ["config --get-all remote.origin.proxy", "evil"],
    ["config --show-scope --get core.hooksPath", "global\t.hooks"],
    ["config --show-scope --get core.hooksPath", "local\t/elsewhere/hooks"],
    ["rev-parse --git-path hooks", undefined],
  ])("rejects unsafe metadata %s", (key, value) => {
    const root = workspace();
    const git = gitFacts(root, { [key!]: value });
    expect(materializeMakerActivation({ workspace: root, push: true }, git)).toBeUndefined();
    expect(
      materializeMakerRequest(
        candidate(root, ["git", "push", "origin", "HEAD:refs/heads/feature"]),
        git,
      ),
    ).toBeUndefined();
  });
  test("accepts explicit disabled extra push behavior", () => {
    const root = workspace();
    expect(
      materializeMakerActivation(
        { workspace: root, push: true },
        gitFacts(root, {
          "config --get-all push.followTags": "false",
          "config --get-all push.recurseSubmodules": "no",
        }),
      ),
    ).toHaveLength(2);
  });
  test("fails closed on missing workspaces, invalid input, and metadata errors", () => {
    const root = workspace();
    const git = gitFacts(root);
    for (const value of [
      undefined,
      {},
      { workspace: "relative" },
      { workspace: root, push: "true" },
      { workspace: join(root, "missing"), push: true },
    ])
      expect(materializeMakerActivation(value, git)).toBeUndefined();
    for (const value of [
      { command: { words: ["git"] } },
      candidate(root, ["git", "push"]),
      candidate(root, ["git", "push", "origin", "HEAD:refs/heads/main"]),
      candidate(join(root, "missing"), ["git"]),
      candidate(root, ["git"], "/elsewhere"),
    ])
      expect(materializeMakerRequest(value, git)).toBeUndefined();
    mkdirSync(join(root, "nested"));
    expect(
      materializeMakerRequest(candidate(root, ["git"], join(root, "nested")), git),
    ).toBeUndefined();
    expect(
      materializeMakerActivation({ workspace: root, push: true }, () => {
        throw new Error("unavailable");
      }),
    ).toBeUndefined();
  });
  test("executes activation and request output with the runtime Git reader", async () => {
    const root = workspace();
    const facts = gitFacts(root);
    let fail = false;
    const original = Object.getOwnPropertyDescriptor(globalThis, "Deno");
    Object.defineProperty(globalThis, "Deno", {
      configurable: true,
      value: {
        readTextFileSync: () => "[pypi-options]\nno-build=true",
        Command: class {
          constructor(
            _command: string,
            readonly options: { args: readonly string[] },
          ) {}
          outputSync() {
            const value = facts(root, this.options.args.slice(2));
            return {
              success: !fail && value !== undefined,
              code: fail ? 128 : value === undefined ? 1 : 0,
              stdout: new TextEncoder().encode(value ?? ""),
            };
          }
        },
      },
    });
    try {
      const output: string[] = [];
      expect(
        materializeMakerRequest(candidate(root, ["pixi", "lock", "--manifest-path", "pixi.toml"])),
      ).toHaveProperty("pypiNoBuild", true);
      expect(
        await runMakerMaterializer(
          Promise.resolve({ workspace: root, push: true }),
          output.push.bind(output),
        ),
      ).toBe(true);
      expect(JSON.parse(output[0]!).targets).toHaveLength(2);
      expect(
        await runMakerMaterializer(
          Promise.resolve(candidate(root, ["git", "push", "origin", "HEAD:refs/heads/feature"])),
          output.push.bind(output),
        ),
      ).toBe(true);
      expect(await runMakerMaterializer(Promise.resolve({ workspace: "relative" }))).toBe(false);
      expect(await runMakerMaterializer(Promise.resolve({}))).toBe(false);
      fail = true;
      expect(materializeMakerActivation({ workspace: root, push: true })).toBeUndefined();
    } finally {
      if (original) Object.defineProperty(globalThis, "Deno", original);
      else Reflect.deleteProperty(globalThis, "Deno");
    }
  });
});
