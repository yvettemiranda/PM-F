import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];
const childProcesses: ChildProcess[] = [];

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("TIMED_OUT_WAITING_FOR_OPERATOR_WORKER");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

async function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return await new Promise<number | null>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error("TIMED_OUT_WAITING_FOR_OPERATOR_LAUNCHER")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolvePromise(code);
    });
  });
}

afterEach(() => {
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("operator worker lifecycle", () => {
  it("flushes campaign output before forcing an otherwise-leaking worker to exit", async () => {
    const fixture = join(projectRoot, "tests/fixtures/process-exit-after-flush.ts");
    const child = spawn(process.execPath, ["--import", "tsx", fixture], {
      cwd: projectRoot,
      stdio: "pipe",
    });
    childProcesses.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });

    expect(await waitForExit(child)).toBe(7);
    expect(stdout).toContain("CAMPAIGN_FINALIZED\n");
    expect(stderr).toContain("CAMPAIGN_STDERR_FLUSHED\n");
  }, 10_000);

  it("tracks and terminates the actual TypeScript worker process", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ni-k-operator-lifecycle-"));
    temporaryDirectories.push(directory);
    const readyFile = join(directory, "ready.json");
    const stoppedFile = join(directory, "stopped.json");
    const trackedPidFile = join(directory, "tracked-pid.txt");
    const fixture = join(projectRoot, "tests/fixtures/operator-signal-worker.ts");
    const shell = `
      PROJECT_ROOT="$1"
      source "$PROJECT_ROOT/操作入口/lib/common.sh"
      operator_tsx "$2" "$3" "$4" &
      tracked_pid=$!
      print -r -- "$tracked_pid" > "$5"
      wait "$tracked_pid"
    `;
    const child = spawn("/bin/zsh", ["-c", shell, "operator-lifecycle", projectRoot, fixture, readyFile, stoppedFile, trackedPidFile], {
      cwd: projectRoot,
      stdio: "pipe",
    });
    childProcesses.push(child);

    await waitUntil(() => {
      try {
        return readFileSync(readyFile, "utf8").length > 0
          && readFileSync(trackedPidFile, "utf8").length > 0;
      } catch {
        return false;
      }
    });

    const worker = JSON.parse(readFileSync(readyFile, "utf8")) as { pid: number };
    const trackedPid = Number(readFileSync(trackedPidFile, "utf8").trim());
    expect(trackedPid).toBe(worker.pid);

    process.kill(trackedPid, "SIGTERM");
    expect(await waitForExit(child)).toBe(0);
    const stopped = JSON.parse(readFileSync(stoppedFile, "utf8")) as { pid: number; signal: string };
    expect(stopped).toEqual({ pid: trackedPid, signal: "SIGTERM" });
    expect(() => process.kill(trackedPid, 0)).toThrow();
  }, 10_000);
});
