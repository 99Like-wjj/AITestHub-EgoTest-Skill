export class LocalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LocalError';
  }
}
export function invariant(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new LocalError(code, message);
}
export function safeErrorCode(
  error: unknown,
  fallback = 'PLATFORM_OUTCOME_UNKNOWN',
): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(code)
    ? code
    : fallback;
}
