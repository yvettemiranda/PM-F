import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Hecatonchires desktop launcher", () => {
  it("owns the Node server process directly and waits for graceful safety shutdown", () => {
    const source = readFileSync("scripts/launch-hecatonchires-ui.command", "utf8");

    expect(source).toContain('node --import tsx prototype/live-ui/server.mjs &');
    expect(source).not.toContain("pnpm operator:ui &");
    expect(source).toContain('wait "$SERVER_PID"');
  });
});
