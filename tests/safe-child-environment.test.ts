import { describe, expect, it } from "vitest";
import { buildSafeChildEnvironment } from "../src/operator/safe-child-environment.js";

describe("safe Paper/Observe child environment", () => {
  it("keeps only local runtime settings and drops credentials or code injection", () => {
    const child = buildSafeChildEnvironment({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      LANG: "zh_CN.UTF-8",
      TZ: "Asia/Shanghai",
      NODE_EXTRA_CA_CERTS: "/untrusted/cert.pem",
      NODE_OPTIONS: "--require=/tmp/inject.js",
      PRIVATE_KEY: "secret-private-key",
      SEED_PHRASE: "secret-seed",
      POLYMARKET_API_KEY: "secret-api-key",
      CLOB_API_SECRET: "secret-api-secret",
      HTTPS_PROXY: "https://user:password@example.invalid",
      HTTP_PROXY: "http://user:password@example.invalid",
      ALL_PROXY: "socks5://user:password@example.invalid",
      https_proxy: "https://lowercase:password@example.invalid",
      NODE_PATH: "/tmp/untrusted-node-path",
      SOURCE_CODE_COMMIT: "untrusted-environment-commit",
    });

    expect(child).toEqual({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      LANG: "zh_CN.UTF-8",
      TZ: "Asia/Shanghai",
    });
    expect(JSON.stringify(child)).not.toContain("secret");
    expect(child).not.toHaveProperty("NODE_OPTIONS");
    expect(child).not.toHaveProperty("HTTPS_PROXY");
    expect(child).not.toHaveProperty("HTTP_PROXY");
    expect(child).not.toHaveProperty("ALL_PROXY");
    expect(child).not.toHaveProperty("https_proxy");
    expect(child).not.toHaveProperty("NODE_PATH");
    expect(child).not.toHaveProperty("NODE_EXTRA_CA_CERTS");
    expect(child).not.toHaveProperty("SOURCE_CODE_COMMIT");
  });
});
