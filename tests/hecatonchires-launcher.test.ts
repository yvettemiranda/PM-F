import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Hecatonchires desktop launcher", () => {
  it("owns the Node server process directly and waits for graceful safety shutdown", () => {
    const source = readFileSync("scripts/launch-hecatonchires-ui.command", "utf8");

    expect(source).toContain('node --import tsx prototype/live-ui/server.mjs &');
    expect(source).not.toContain("pnpm operator:ui &");
    expect(source).toContain('wait "$SERVER_PID"');
  });

  it("does not require pnpm merely to open the installed local application", () => {
    const source = readFileSync("scripts/launch-hecatonchires-ui.command", "utf8");

    expect(source).not.toContain("找不到 pnpm");
    expect(source).not.toContain("command -v pnpm");
    expect(source).toContain("resolve_node");
    expect(source).toContain("NODE_BIN");
  });
});
