import { describe, expect, it } from "vitest";
import { MONITOR_TRANSITIONS, PAPER_EXECUTION_TRANSITIONS, PAPER_POSITION_TRANSITIONS, REPLAY_TRANSITIONS, SIGNAL_TRANSITIONS, transition } from "../src/domain/state-machine.js";

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

  it("separates Paper Execution and Position transitions", () => {
    expect(transition(PAPER_EXECUTION_TRANSITIONS, "WAITING_EXECUTION", "PARTIALLY_EXECUTED")).toBe("PARTIALLY_EXECUTED");
    expect(transition(PAPER_EXECUTION_TRANSITIONS, "EXIT_PENDING", "EXECUTED")).toBe("EXECUTED");
    expect(transition(PAPER_POSITION_TRANSITIONS, "OPEN", "PARTIALLY_CLOSED")).toBe("PARTIALLY_CLOSED");
    expect(transition(PAPER_POSITION_TRANSITIONS, "SETTLEMENT_PENDING", "REDEEMED")).toBe("REDEEMED");
    expect(() => transition(PAPER_POSITION_TRANSITIONS, "OPEN", "REDEEMED")).toThrow("Illegal transition");
  });

  it("allows Paper positions to freeze and recover only to active holding states", () => {
    expect(transition(PAPER_POSITION_TRANSITIONS, "OPEN", "FROZEN")).toBe("FROZEN");
    expect(transition(PAPER_POSITION_TRANSITIONS, "PARTIALLY_CLOSED", "FROZEN")).toBe("FROZEN");
    expect(transition(PAPER_POSITION_TRANSITIONS, "FROZEN", "OPEN")).toBe("OPEN");
    expect(() => transition(PAPER_POSITION_TRANSITIONS, "FROZEN", "REDEEMED")).toThrow("Illegal transition");
  });
});
