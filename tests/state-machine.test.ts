import { describe, expect, it } from "vitest";
import { MONITOR_TRANSITIONS, REPLAY_TRANSITIONS, SIGNAL_TRANSITIONS, transition } from "../src/domain/state-machine.js";

describe("state machines", () => {
  it("allows the normal monitor startup path", () => {
    expect(transition(MONITOR_TRANSITIONS, "UNCONFIGURED", "IDENTIFYING")).toBe("IDENTIFYING");
    expect(transition(MONITOR_TRANSITIONS, "IDENTIFYING", "BASELINING")).toBe("BASELINING");
  });

  it("rejects an illegal monitor transition", () => {
    expect(() => transition(MONITOR_TRANSITIONS, "UNCONFIGURED", "ONLINE")).toThrow(/Illegal transition/);
  });

  it("treats replay outcomes as terminal", () => {
    expect(() => transition(REPLAY_TRANSITIONS, "PASSED", "RUNNING")).toThrow(/Illegal transition/);
  });

  it("keeps signal validation separate from execution state", () => {
    expect(transition(SIGNAL_TRANSITIONS, "VALIDATING", "READY")).toBe("READY");
    expect(() => transition(SIGNAL_TRANSITIONS, "PUBLISHED", "READY")).toThrow(/Illegal transition/);
  });
});
