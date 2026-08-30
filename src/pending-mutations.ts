import type { PreparedProfileMutation } from "./profile-mutations.js";

type PendingMutation = {
  readonly expiresAt: number;
  readonly mutation: PreparedProfileMutation;
};

export class PendingMutationCapacityError extends Error {
  readonly code = "pending_mutation_capacity_exceeded";
  readonly retryable = true;

  constructor() {
    super(
      "pending profile mutation capacity reached; retry after an approval is consumed or expires",
    );
    this.name = "PendingMutationCapacityError";
  }
}

export class PendingMutations {
  readonly #capacity: number;
  readonly #entries = new Map<string, PendingMutation>();
  readonly #now: () => number;
  readonly #ttlMilliseconds: number;

  constructor(capacity = 128, ttlMilliseconds = 120_000, now = Date.now) {
    this.#capacity = capacity;
    this.#now = now;
    this.#ttlMilliseconds = ttlMilliseconds;
  }

  #pruneExpired(): void {
    const now = this.#now();
    for (const [nonce, pending] of this.#entries) {
      if (pending.expiresAt <= now) this.#entries.delete(nonce);
    }
  }

  delete(nonce: string): void {
    this.#entries.delete(nonce);
  }

  get(nonce: string): PreparedProfileMutation | undefined {
    this.#pruneExpired();
    return this.#entries.get(nonce)?.mutation;
  }

  remember(nonce: string, mutation: PreparedProfileMutation): void {
    this.#pruneExpired();
    if (!this.#entries.has(nonce) && this.#entries.size >= this.#capacity) {
      throw new PendingMutationCapacityError();
    }
    this.#entries.set(nonce, {
      expiresAt: this.#now() + this.#ttlMilliseconds,
      mutation,
    });
  }
}
