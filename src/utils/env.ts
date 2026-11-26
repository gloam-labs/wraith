export interface ReadIntEnvOptions {
  /** Fallback returned when the variable is unset, empty, or invalid. */
  defaultValue: number;
  /** Minimum allowed whole number (inclusive). */
  min?: number;
  /** Maximum allowed whole number (inclusive). */
  max?: number;
  /** Environment object to read from (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Warning logger (defaults to `console.warn`). */
  warn?: (message: string) => void;
}

function describeBounds(min?: number, max?: number): string {
  if (min !== undefined && max !== undefined) {
    return `a whole number between ${min} and ${max}`;
  }
  if (min !== undefined) {
    return `a whole number >= ${min}`;
  }
  if (max !== undefined) {
    return `a whole number <= ${max}`;
  }
  return "a whole number";
}

/**
 * Read a whole number from an environment variable with optional bounds.
 *
 * Rejects empty strings, partial numbers (e.g. `6s`, `10k`), decimals, and
 * out-of-range values by logging one warning naming the variable and returning
 * `defaultValue` without throwing.
 */
export function readIntEnv(name: string, options: ReadIntEnvOptions): number {
  const {
    defaultValue,
    min,
    max,
    env = process.env,
    warn = console.warn,
  } = options;

  const raw = env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    warn(
      `[env] Invalid ${name}=${JSON.stringify(raw)} (expected ${describeBounds(min, max)}); using default ${defaultValue}.`,
    );
    return defaultValue;
  }

  const parsed = Number(trimmed);
  if (
    !Number.isSafeInteger(parsed) ||
    (min !== undefined && parsed < min) ||
    (max !== undefined && parsed > max)
  ) {
    warn(
      `[env] Out-of-range ${name}=${JSON.stringify(raw)} (expected ${describeBounds(min, max)}); using default ${defaultValue}.`,
    );
    return defaultValue;
  }

  return parsed;
}
