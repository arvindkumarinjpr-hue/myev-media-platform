import {
  wrapTransactionalConsumer,
  wrapExternalEffectConsumer,
  deriveExternalIdempotencyKey,
  type TransactionRunner,
  type ProcessedEventReaderWriter,
  type AdvisoryLockAcquirer,
  type ProcessedEventStore,
  type CategoryAExecute,
  type CategoryAConsumerDeps,
  type CategoryBConsumerDeps,
} from "./event-consumer-runtime";
import type { DomainEventRecord } from "./domain-event";
import type { ProcessorContext } from "../queue/queue-registry";

function domainEvent(overrides: Partial<DomainEventRecord> = {}): DomainEventRecord {
  return {
    id: "event-1",
    eventType: "content.published.v1",
    eventVersion: 1,
    workspaceId: null,
    correlationId: null,
    causationId: null,
    payload: { title: "hello" },
    occurredAt: new Date(),
    dispatchedAt: new Date(),
    ...overrides,
  };
}

function context(): ProcessorContext {
  return {
    jobId: "job-1",
    correlationId: "corr-1",
    attempt: 1,
    isCancelled: async () => false,
  };
}

class FakeTx {}

class InMemoryCategoryAFixture implements CategoryAConsumerDeps<FakeTx> {
  processed = new Map<string, true>();
  lockCalls: Array<{ domainEventId: string; consumerName: string }> = [];
  callOrder: string[] = [];
  runCount = 0;

  transactionRunner: TransactionRunner<FakeTx> = {
    run: async (fn) => {
      this.runCount += 1;
      return fn(new FakeTx());
    },
  };

  advisoryLockAcquirer: AdvisoryLockAcquirer<FakeTx> = {
    acquire: async (_tx, domainEventId, consumerName) => {
      this.lockCalls.push({ domainEventId, consumerName });
      this.callOrder.push("lock");
    },
  };

  processedEventReaderWriter: ProcessedEventReaderWriter<FakeTx> = {
    find: async (_tx, eventId, consumerName) => {
      this.callOrder.push("find");
      return this.processed.has(`${eventId}:${consumerName}`) ? { id: `${eventId}:${consumerName}` } : null;
    },
    create: async (_tx, eventId, consumerName) => {
      this.callOrder.push("create");
      this.processed.set(`${eventId}:${consumerName}`, true);
    },
  };
}

describe("wrapTransactionalConsumer (Category A)", () => {
  it("executes the business callback and records ProcessedEvent on first delivery", async () => {
    const fixture = new InMemoryCategoryAFixture();
    let executed = false;
    const execute: CategoryAExecute<FakeTx, string> = async (_tx, event) => {
      executed = true;
      return `handled:${event.id}`;
    };

    const outcome = await wrapTransactionalConsumer(fixture, domainEvent(), "content-projection", context(), execute);

    expect(executed).toBe(true);
    expect(outcome).toEqual({ outcome: "EXECUTED", result: "handled:event-1" });
    expect(fixture.processed.has("event-1:content-projection")).toBe(true);
  });

  it("skips the business callback entirely when ProcessedEvent already exists in the same tx", async () => {
    const fixture = new InMemoryCategoryAFixture();
    fixture.processed.set("event-1:content-projection", true);
    let executed = false;
    const execute: CategoryAExecute<FakeTx, string> = async () => {
      executed = true;
      return "should-not-happen";
    };

    const outcome = await wrapTransactionalConsumer(fixture, domainEvent(), "content-projection", context(), execute);

    expect(executed).toBe(false);
    expect(outcome).toEqual({ outcome: "ALREADY_PROCESSED" });
  });

  it("acquires the advisory lock before checking ProcessedEvent", async () => {
    const fixture = new InMemoryCategoryAFixture();
    await wrapTransactionalConsumer(fixture, domainEvent(), "content-projection", context(), async () => "r");
    expect(fixture.callOrder).toEqual(["lock", "find", "create"]);
  });

  it("acquires the lock for the exact (domainEventId, consumerName) pair", async () => {
    const fixture = new InMemoryCategoryAFixture();
    await wrapTransactionalConsumer(fixture, domainEvent({ id: "event-42" }), "content-projection", context(), async () => "r");
    expect(fixture.lockCalls).toEqual([{ domainEventId: "event-42", consumerName: "content-projection" }]);
  });

  it("passes the exact same tx instance to the lock, the lookup, the business callback, and the insert", async () => {
    const seenTx: unknown[] = [];
    const fixture = new InMemoryCategoryAFixture();
    fixture.advisoryLockAcquirer = {
      acquire: async (tx) => {
        seenTx.push(tx);
      },
    };
    fixture.processedEventReaderWriter = {
      find: async (tx) => {
        seenTx.push(tx);
        return null;
      },
      create: async (tx) => {
        seenTx.push(tx);
      },
    };
    const execute: CategoryAExecute<FakeTx, void> = async (tx) => {
      seenTx.push(tx);
    };

    await wrapTransactionalConsumer(fixture, domainEvent(), "content-projection", context(), execute);

    expect(seenTx).toHaveLength(4);
    expect(new Set(seenTx).size).toBe(1);
  });

  it("invokes the transaction runner exactly once per execution — no nested transaction", async () => {
    const fixture = new InMemoryCategoryAFixture();
    await wrapTransactionalConsumer(fixture, domainEvent(), "content-projection", context(), async () => "r");
    expect(fixture.runCount).toBe(1);
  });

  it("propagates a business callback failure and never calls ProcessedEvent.create", async () => {
    const fixture = new InMemoryCategoryAFixture();
    const createSpy = jest.fn(fixture.processedEventReaderWriter.create);
    fixture.processedEventReaderWriter.create = createSpy;
    const execute: CategoryAExecute<FakeTx, never> = async () => {
      throw new Error("business logic failed");
    };

    await expect(wrapTransactionalConsumer(fixture, domainEvent(), "content-projection", context(), execute)).rejects.toThrow(
      "business logic failed",
    );
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("propagates a ProcessedEvent.create failure without swallowing or reinterpreting it", async () => {
    const fixture = new InMemoryCategoryAFixture();
    fixture.processedEventReaderWriter.create = async () => {
      throw new Error("unique constraint violation");
    };

    await expect(
      wrapTransactionalConsumer(fixture, domainEvent(), "content-projection", context(), async () => "r"),
    ).rejects.toThrow("unique constraint violation");
  });
});

class InMemoryCategoryBFixture implements CategoryBConsumerDeps {
  processed = new Map<string, true>();

  processedEventStore: ProcessedEventStore = {
    find: async (eventId, consumerName) => (this.processed.has(`${eventId}:${consumerName}`) ? { id: `${eventId}:${consumerName}` } : null),
    create: async (eventId, consumerName) => {
      this.processed.set(`${eventId}:${consumerName}`, true);
    },
  };
}

describe("wrapExternalEffectConsumer (Category B)", () => {
  it("invokes the external effect and records ProcessedEvent on first delivery", async () => {
    const fixture = new InMemoryCategoryBFixture();
    let called = false;
    const outcome = await wrapExternalEffectConsumer(fixture, domainEvent(), "email-notifier", context(), async () => {
      called = true;
      return "sent";
    });

    expect(called).toBe(true);
    expect(outcome).toEqual({ outcome: "EXECUTED", result: "sent" });
    expect(fixture.processed.has("event-1:email-notifier")).toBe(true);
  });

  it("skips the external effect entirely when already processed", async () => {
    const fixture = new InMemoryCategoryBFixture();
    fixture.processed.set("event-1:email-notifier", true);
    let called = false;

    const outcome = await wrapExternalEffectConsumer(fixture, domainEvent(), "email-notifier", context(), async () => {
      called = true;
      return "sent";
    });

    expect(called).toBe(false);
    expect(outcome).toEqual({ outcome: "ALREADY_PROCESSED" });
  });

  it("passes the deterministic domainEventId:consumerName idempotency key to the external effect", async () => {
    const fixture = new InMemoryCategoryBFixture();
    let receivedKey: string | undefined;

    await wrapExternalEffectConsumer(fixture, domainEvent({ id: "event-99" }), "email-notifier", context(), async (_event, _ctx, idempotencyKey) => {
      receivedKey = idempotencyKey;
      return "sent";
    });

    expect(receivedKey).toBe("event-99:email-notifier");
    expect(receivedKey).toBe(deriveExternalIdempotencyKey("event-99", "email-notifier"));
  });

  it("propagates an external-effect failure and never calls ProcessedEvent.create", async () => {
    const fixture = new InMemoryCategoryBFixture();
    const createSpy = jest.fn(fixture.processedEventStore.create);
    fixture.processedEventStore.create = createSpy;

    await expect(
      wrapExternalEffectConsumer(fixture, domainEvent(), "email-notifier", context(), async () => {
        throw new Error("external API failed");
      }),
    ).rejects.toThrow("external API failed");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("propagates a ProcessedEvent.create failure without swallowing or reinterpreting it", async () => {
    const fixture = new InMemoryCategoryBFixture();
    fixture.processedEventStore.create = async () => {
      throw new Error("unique constraint violation");
    };

    await expect(
      wrapExternalEffectConsumer(fixture, domainEvent(), "email-notifier", context(), async () => "sent"),
    ).rejects.toThrow("unique constraint violation");
  });

  it("depends on no transaction object of any kind — only find/create exist on the store", () => {
    const fixture = new InMemoryCategoryBFixture();
    expect("transactionRunner" in fixture).toBe(false);
    expect(Object.keys(fixture.processedEventStore).sort()).toEqual(["create", "find"]);
  });
});
