import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  authorizeProfileMutation,
  consumeProfileMutationAuthorization,
  parseProfileMutationIntent,
} from "../src/mutation-authorization.js";
import type { ProfileMutationIntent } from "../src/mutation-authorization.js";

const activateFirstProfile = {
  arguments: { arguments: { repository: "acme/example" }, profileId: "first-profile" },
  operation: "activate_profile",
} as const satisfies ProfileMutationIntent;

const activateSecondProfile = {
  arguments: { arguments: { repository: "acme/other" }, profileId: "second-profile" },
  operation: "activate_profile",
} as const satisfies ProfileMutationIntent;

const disableProfile = {
  arguments: {},
  operation: "disable_profile",
} as const satisfies ProfileMutationIntent;

async function withAuthorizationRoot(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "sandbox-extender-authorization-"));
  try {
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

describe("profile mutation authorization", () => {
  test("parses mutation intents and rejects non-JSON argument values", async () => {
    expect(parseProfileMutationIntent(disableProfile)).toEqual(disableProfile);
    await withAuthorizationRoot(async (root) => {
      await expect(authorizeProfileMutation(root, "thread-1", {
        arguments: { invalid: undefined },
        operation: "disable_profile",
      } as unknown as ProfileMutationIntent)).rejects.toThrow("JSON values");
    });
  });
  test("rejects an authorization for another operation", async () => {
    await withAuthorizationRoot(async (root) => {
      await authorizeProfileMutation(root, "thread-1", activateFirstProfile);

      await expect(
        consumeProfileMutationAuthorization(root, "thread-1", disableProfile),
      ).rejects.toThrow("another operation");
      await expect(
        consumeProfileMutationAuthorization(root, "thread-1", activateFirstProfile),
      ).rejects.toThrow("authorization is required");
    });
  });

  test("rejects an authorization for different arguments", async () => {
    await withAuthorizationRoot(async (root) => {
      await authorizeProfileMutation(root, "thread-1", activateFirstProfile);

      await expect(
        consumeProfileMutationAuthorization(root, "thread-1", activateSecondProfile),
      ).rejects.toThrow("different arguments");
    });
  });

  test("accepts equivalent arguments with a different property order", async () => {
    await withAuthorizationRoot(async (root) => {
      const authorizedIntent = {
        arguments: {
          action: "codex.unified_exec",
          arguments: { cwd: "/workspace", command: "git status" },
          profileId: "review-profile",
          resource: "/workspace",
        },
        operation: "propose_profile",
      } as const satisfies ProfileMutationIntent;
      const consumedIntent = {
        arguments: {
          resource: "/workspace",
          profileId: "review-profile",
          arguments: { command: "git status", cwd: "/workspace" },
          action: "codex.unified_exec",
        },
        operation: "propose_profile",
      } as const satisfies ProfileMutationIntent;
      await authorizeProfileMutation(root, "thread-1", authorizedIntent);

      await expect(
        consumeProfileMutationAuthorization(root, "thread-1", consumedIntent),
      ).resolves.toBeUndefined();
    });
  });

  test("stores only a digest of canonical arguments", async () => {
    await withAuthorizationRoot(async (root) => {
      const distinctiveValue = "credential-value-that-must-not-be-persisted";
      const intent = {
        arguments: {
          action: "codex.unified_exec",
          arguments: { command: `deploy --token ${distinctiveValue}` },
          profileId: "deploy-profile",
          resource: "/workspace",
        },
        operation: "propose_profile",
      } as const satisfies ProfileMutationIntent;
      await authorizeProfileMutation(root, "thread-1", intent);

      const artifact = await readFile(
        join(root, "state", "mutation-authorization.json"),
        "utf8",
      );
      expect(artifact).not.toContain(distinctiveValue);
      await expect(
        consumeProfileMutationAuthorization(root, "thread-1", intent),
      ).resolves.toBeUndefined();
    });
  });

  test("rejects an expired authorization", async () => {
    await withAuthorizationRoot(async (root) => {
      const issuedAt = new Date("2026-08-26T10:00:00.000Z");
      await authorizeProfileMutation(root, "thread-1", activateFirstProfile, issuedAt);

      await expect(
        consumeProfileMutationAuthorization(
          root,
          "thread-1",
          activateFirstProfile,
          new Date("2026-08-26T10:02:00.000Z"),
        ),
      ).rejects.toThrow("has expired");
    });
  });

  test("binds an authorization to its host thread and consumes it once", async () => {
    await withAuthorizationRoot(async (root) => {
      await expect(
        consumeProfileMutationAuthorization(root, "thread-1", activateFirstProfile),
      ).rejects.toThrow("authorization is required");
      await authorizeProfileMutation(root, "thread-1", activateFirstProfile);
      await expect(
        consumeProfileMutationAuthorization(root, "thread-2", activateFirstProfile),
      ).rejects.toThrow("another thread");

      await authorizeProfileMutation(root, "thread-1", activateFirstProfile);
      await expect(
        consumeProfileMutationAuthorization(root, "thread-1", activateFirstProfile),
      ).resolves.toBeUndefined();
      await expect(
        consumeProfileMutationAuthorization(root, "thread-1", activateFirstProfile),
      ).rejects.toThrow("authorization is required");
    });
  });

  test("allows only one concurrent consumer to claim an authorization", async () => {
    await withAuthorizationRoot(async (root) => {
      await authorizeProfileMutation(root, "thread-1", activateFirstProfile);

      const results = await Promise.allSettled([
        consumeProfileMutationAuthorization(root, "thread-1", activateFirstProfile),
        consumeProfileMutationAuthorization(root, "thread-1", activateFirstProfile),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    });
  });
});
