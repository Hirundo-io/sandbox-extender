import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  authorizeProfileMutation,
  consumeProfileMutationAuthorization,
} from "../src/mutation-authorization.js";

describe("profile mutation authorization", () => {
  test("requires and consumes a user-created authorization for its thread", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-extender-authorization-"));
    try {
      await mkdir(join(root, "state"));
      await expect(consumeProfileMutationAuthorization(root, "thread-1"))
        .rejects.toThrow("authorization is required");
      await authorizeProfileMutation(root, "thread-1");
      await expect(consumeProfileMutationAuthorization(root, "thread-2"))
        .rejects.toThrow("another thread");
      await expect(consumeProfileMutationAuthorization(root, "thread-1"))
        .resolves.toBeUndefined();
      await expect(consumeProfileMutationAuthorization(root, "thread-1"))
        .rejects.toThrow("authorization is required");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
