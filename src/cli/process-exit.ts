import type { WriteStream } from "node:tty";

async function flush(stream: WriteStream): Promise<void> {
  if (stream.destroyed || !stream.writable) return;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    stream.write("", (error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}

/**
 * Campaign runners may retain a dependency-owned worker after all durable
 * evidence has been committed. Flush both operator streams before forcing the
 * supervisor to return its final status to the launcher.
 */
export async function exitAfterFlushingStandardStreams(
  exitCode = process.exitCode ?? 0,
): Promise<never> {
  await Promise.all([flush(process.stdout), flush(process.stderr)]);
  process.exit(exitCode);
}
