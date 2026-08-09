import { ShutdownOutcomeTracker } from "./shutdown-outcome-tracker";

describe("ShutdownOutcomeTracker", () => {
  it("hasFailure is false with no recorded outcomes", () => {
    const tracker = new ShutdownOutcomeTracker();
    expect(tracker.hasFailure()).toBe(false);
  });

  it("hasFailure is false when every recorded outcome is GRACEFUL or FORCED", () => {
    const tracker = new ShutdownOutcomeTracker();
    tracker.record("ComponentA", "GRACEFUL");
    tracker.record("ComponentB", "FORCED");
    expect(tracker.hasFailure()).toBe(false);
  });

  it("hasFailure is true when any recorded outcome is FAILED", () => {
    const tracker = new ShutdownOutcomeTracker();
    tracker.record("ComponentA", "GRACEFUL");
    tracker.record("ComponentB", "FAILED");
    expect(tracker.hasFailure()).toBe(true);
  });

  it("record overwrites a component's prior outcome rather than accumulating", () => {
    const tracker = new ShutdownOutcomeTracker();
    tracker.record("ComponentA", "FAILED");
    tracker.record("ComponentA", "GRACEFUL");
    expect(tracker.hasFailure()).toBe(false);
    expect(tracker.getAll().size).toBe(1);
  });

  it("getAll returns a snapshot, not a live view", () => {
    const tracker = new ShutdownOutcomeTracker();
    tracker.record("ComponentA", "GRACEFUL");
    const snapshot = tracker.getAll();
    tracker.record("ComponentB", "FAILED");
    expect(snapshot.size).toBe(1);
    expect(tracker.getAll().size).toBe(2);
  });
});
