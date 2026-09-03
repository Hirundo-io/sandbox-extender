import { describe, expect, test } from "bun:test";

import { compileShell } from "../src/shell-parser.js";

describe("shell compiler", () => {
  test("compiles concurrent requests independently", async () => {
    const scripts = Array.from({ length: 32 }, (_, index) => `echo concurrent-${index}`);

    expect(await Promise.all(scripts.map((script) => compileShell(script)))).toEqual(
      scripts.map((script) => [{ source: script, words: script.split(" ") }]),
    );
  });

  test("compiles sequences, pipelines, and a terminal cd conjunction", async () => {
    expect(await compileShell("cd app && npm i zod | tee install.log")).toEqual([
      { source: "cd app", words: ["cd", "app"] },
      { source: "npm i zod", words: ["npm", "i", "zod"] },
      { source: "tee install.log", words: ["tee", "install.log"] },
    ]);
    expect(await compileShell("pwd; echo done", { dialect: "posix" })).toEqual([
      { source: "pwd", words: ["pwd"] },
      { source: "echo done", words: ["echo", "done"] },
    ]);
  });

  test("expands finite literal for loops and exposes iteration facts", async () => {
    expect(
      await compileShell('for item in one "two words"; do printf "%s\\n" "$item"; done'),
    ).toEqual([
      {
        controlFlow: "for",
        iteration: 0,
        repetition: "finite",
        role: "body",
        source: 'printf "%s\\n" "$item"',
        words: ["printf", "%s\\n", "one"],
      },
      {
        controlFlow: "for",
        iteration: 1,
        repetition: "finite",
        role: "body",
        source: 'printf "%s\\n" "$item"',
        words: ["printf", "%s\\n", "two words"],
      },
    ]);
  });

  test("supports safe unquoted loop variables and rejects field splitting", async () => {
    expect(
      (await compileShell("for item in one two; do echo $item; done"))?.map(
        (segment) => segment.words,
      ),
    ).toEqual([
      ["echo", "one"],
      ["echo", "two"],
    ]);
    expect(await compileShell('for item in "~"; do echo $item; done')).toEqual([
      {
        controlFlow: "for",
        iteration: 0,
        repetition: "finite",
        role: "body",
        source: "echo $item",
        words: ["echo", "~"],
      },
    ]);
    expect(await compileShell('for item in "two words"; do echo $item; done')).toBeUndefined();
  });

  test("rejects unquoted tilde and pathname expansion", async () => {
    for (const script of [
      "cd ~",
      "bun add zod --cwd ~/outside",
      "for loopVariable in outside; do echo ~/$loopVariable; done",
      "echo *.ts",
      "echo file?.ts",
      "echo [ab].ts",
      "for extension in ts; do echo *.$extension; done",
      "for extension in ts; do echo file?.$extension; done",
      "for extension in ts; do echo [ab].$extension; done",
    ]) {
      expect(await compileShell(script)).toBeUndefined();
    }
  });

  test("preserves quoted tilde and glob text as literal", async () => {
    expect(await compileShell('echo "~/literal" "*.ts" "file?.ts" "[ab].ts"')).toEqual([
      {
        source: 'echo "~/literal" "*.ts" "file?.ts" "[ab].ts"',
        words: ["echo", "~/literal", "*.ts", "file?.ts", "[ab].ts"],
      },
    ]);
    expect(await compileShell('for extension in ts; do echo "*.$extension"; done')).toEqual([
      {
        controlFlow: "for",
        iteration: 0,
        repetition: "finite",
        role: "body",
        source: 'echo "*.$extension"',
        words: ["echo", "*.ts"],
      },
    ]);
  });

  test.each(["while", "until"] as const)(
    "authorizes %s conditions and bodies with control-flow facts",
    async (kind) => {
      expect(await compileShell(`${kind} test -f ready; do echo waiting; done`)).toEqual([
        {
          controlFlow: kind,
          repetition: "potentially-unbounded",
          role: "condition",
          source: "test -f ready",
          words: ["test", "-f", "ready"],
        },
        {
          controlFlow: kind,
          repetition: "potentially-unbounded",
          role: "body",
          source: "echo waiting",
          words: ["echo", "waiting"],
        },
      ]);
    },
  );

  test("blocks conditional cd bypasses and mutations inside loops", async () => {
    expect(await compileShell("false && cd safe; npm install")).toBeUndefined();
    expect(await compileShell("cd safe || npm install")).toBeUndefined();
    expect(await compileShell("for item in one; do cd safe; npm install; done")).toBeUndefined();
    expect(await compileShell("while true; do export TARGET=unsafe; done")).toBeUndefined();
    expect(await compileShell("export TARGET=unsafe | cat")).toBeUndefined();
    expect(await compileShell("(echo unsafe) | cat")).toBeUndefined();
  });

  test("compiles brace groups and safe subshells", async () => {
    expect(await compileShell("{ echo one; echo two; }")).toEqual([
      { source: "echo one", words: ["echo", "one"] },
      { source: "echo two", words: ["echo", "two"] },
    ]);
    expect(await compileShell("(echo one; echo two)")).toEqual([
      { source: "echo one", words: ["echo", "one"] },
      { source: "echo two", words: ["echo", "two"] },
    ]);
  });

  test("expands literal function calls with positional arguments", async () => {
    const script = [
      'reply() { gh api "$1" -f "body=$2"; }',
      'reply "repos/acme/example/pulls/42/comments/987/replies" "Reviewed by Codex."',
    ].join("\n");

    expect(await compileShell(script)).toEqual([
      {
        source: 'gh api "$1" -f "body=$2"',
        words: [
          "gh",
          "api",
          "repos/acme/example/pulls/42/comments/987/replies",
          "-f",
          "body=Reviewed by Codex.",
        ],
      },
    ]);
  });

  test("supports declared nested functions and keeps call arguments isolated", async () => {
    const script = [
      'reply() { send "$1"; }',
      'send() { printf "%s\\n" "$1"; }',
      'reply "first reply"',
      'reply "second reply"',
    ].join("\n");

    expect((await compileShell(script))?.map((segment) => segment.words)).toEqual([
      ["printf", "%s\\n", "first reply"],
      ["printf", "%s\\n", "second reply"],
    ]);
  });

  test.each([
    "reply() { reply; }; reply",
    "first() { second; }; second() { first; }; first",
    "reply() { echo safe; }; reply > output",
    "reply() ( echo unsupported ); reply",
    "reply() { echo safe; } > output; reply",
    "reply() { echo safe; }; reply one two three four five six seven eight nine ten",
    "reply() { echo $@; }; reply one",
    "reply() { echo $*; }; reply one",
    "reply() { local value=safe; echo safe; }; reply",
    "reply() { return 0; }; reply",
    "reply() { echo safe; }; reply() { echo duplicate; }; reply",
    "reply; reply() { echo defined-too-late; }",
    "{ reply() { echo nested; }; reply; }",
  ])("abstains on unsupported function behavior: %s", async (script) => {
    expect(await compileShell(script)).toBeUndefined();
  });

  test("applies the expanded segment limit to function bodies", async () => {
    expect(
      await compileShell("reply() { echo one; echo two; }; reply", { maxSegments: 1 }),
    ).toBeUndefined();
  });

  test.each([
    "if true; then echo unsafe; fi",
    "case x in x) echo unsafe;; esac",
    "name=echo; $name unsafe",
    "echo $(printf unsafe)",
    "echo ${value:-$(printf unsafe)}",
    "echo $((1 + 2))",
    "echo <(printf unsafe)",
    "echo foo{one,two}",
    "echo @(one|two)",
    'echo $"translated"',
    "echo unsafe > output",
    "source script.sh",
    "npm i &&",
  ])("abstains on unsupported or invalid syntax: %s", async (script) => {
    expect(await compileShell(script)).toBeUndefined();
  });

  test("enforces loop and expanded-segment limits", async () => {
    expect(
      await compileShell("for item in one two; do echo $item; done", { maxIterations: 1 }),
    ).toBeUndefined();
    expect(
      await compileShell("for item in one two; do echo $item; echo done; done", { maxSegments: 3 }),
    ).toBeUndefined();
  });
});
