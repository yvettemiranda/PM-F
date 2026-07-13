export async function withExternalTimeout<T>(
  operation: string,
  timeoutMs: number,
  task: () => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("LIVE_EXTERNAL_TIMEOUT_CONFIG_INVALID");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`LIVE_EXTERNAL_TIMEOUT:${operation}:${timeoutMs}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
