const SAFE_CHILD_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SHELL",
  "TERM",
  "COLORTERM",
  "FORCE_COLOR",
  "NO_COLOR",
] as const;

/**
 * Paper/Observe subprocesses receive only process/runtime settings required for
 * local execution. Trading credentials, proxy credentials, NODE_OPTIONS and
 * unrelated parent-shell configuration are deliberately not inherited.
 */
export function buildSafeChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of SAFE_CHILD_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}
