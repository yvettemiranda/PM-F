// Minimal long-running process used to test OS liveness and SIGKILL detection.
process.stdout.write("READY\n");
setInterval(() => undefined, 1_000);
