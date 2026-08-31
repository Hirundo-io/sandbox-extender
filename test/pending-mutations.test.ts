import { describe, expect, test } from "bun:test";

import { PendingMutationCapacityError, PendingMutations } from "../src/pending-mutations.js";
import type { PreparedProfileMutation } from "../src/profile-mutations.js";

function mutation(name: string): PreparedProfileMutation {
  return { approvalDetails: {}, execute: async () => name };
}

describe("pending profile mutations", () => {
  test("removes expired entries before lookup and capacity checks", () => {
    let now = 0;
    const pending = new PendingMutations(1, 10, () => now);
    pending.remember("first", mutation("first"));
    expect(pending.get("first")).toBeDefined();
    expect(() => pending.remember("second", mutation("second"))).toThrow(
      PendingMutationCapacityError,
    );

    try {
      pending.remember("second", mutation("second"));
    } catch (error) {
      expect(error).toMatchObject({
        code: "pending_mutation_capacity_exceeded",
        retryable: true,
      });
    }

    now = 10;
    expect(pending.get("first")).toBeUndefined();
    expect(() => pending.remember("second", mutation("second"))).not.toThrow();
  });

  test("removes consumed entries", () => {
    const pending = new PendingMutations();
    pending.remember("approved", mutation("approved"));
    pending.delete("approved");
    expect(pending.get("approved")).toBeUndefined();
  });
});
