import { writeFileSync } from "node:fs";

const [readyFile, stoppedFile] = process.argv.slice(2);
if (!readyFile || !stoppedFile) {
  throw new Error("READY_AND_STOPPED_FILES_REQUIRED");
}

writeFileSync(readyFile, JSON.stringify({
  pid: process.pid,
  parentPid: process.ppid,
}));

let stopping = false;
const stop = (signal: NodeJS.Signals): void => {
  if (stopping) return;
  stopping = true;
  writeFileSync(stoppedFile, JSON.stringify({
    pid: process.pid,
    signal,
  }));
  process.exit(0);
};

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
setInterval(() => undefined, 1_000);
