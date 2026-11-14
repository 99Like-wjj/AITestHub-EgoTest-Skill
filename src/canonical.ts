import { createHash } from 'node:crypto';
import { invariant, LocalError } from './errors.js';
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export function canonical(value: unknown): string {
  const visit = (x: unknown, depth: number): string => {
    invariant(
      depth <= 64,
      'JSON_LIMIT',
      'JSON nesting exceeds the supported limit.',
    );
    if (x === null || typeof x === 'boolean' || typeof x === 'string')
      return JSON.stringify(x);
    if (typeof x === 'number' && Number.isFinite(x)) return JSON.stringify(x);
    if (Array.isArray(x))
      return `[${x.map((y) => visit(y, depth + 1)).join(',')}]`;
    invariant(
      typeof x === 'object' &&
        x !== null &&
        (Object.getPrototypeOf(x) === Object.prototype ||
          Object.getPrototypeOf(x) === null),
      'INVALID_JSON',
      'Expected plain JSON data.',
    );
    return `{${Object.keys(x)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${visit((x as Record<string, unknown>)[k], depth + 1)}`,
      )
      .join(',')}}`;
  };
  return visit(value, 0);
}
export const digest = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');
export const bytesHash = (value: Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

/** Native JSON validation plus a token walk rejects ambiguous duplicate keys. */
export function parseJson(text: string): unknown {
  invariant(
    Buffer.byteLength(text, 'utf8') <= 16 * 1024 * 1024,
    'JSON_LIMIT',
    'JSON exceeds 16MiB.',
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new LocalError('INVALID_JSON', 'JSON is not complete and valid.');
  }
  const tokens =
    text
      .replace(/^\uFEFF/, '')
      .match(
        /"(?:\\.|[^"\\])*"|[{}\[\],:]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g,
      ) ?? [];
  let at = 0;
  const walk = (depth: number): void => {
    invariant(
      depth <= 64,
      'JSON_LIMIT',
      'JSON nesting exceeds the supported limit.',
    );
    const token = tokens[at++];
    if (token === '{') {
      const keys = new Set<string>();
      if (tokens[at] !== '}')
        for (;;) {
          const key = JSON.parse(tokens[at++]!) as string;
          invariant(
            !keys.has(key),
            'DUPLICATE_JSON_KEY',
            'JSON contains a duplicate object key.',
          );
          keys.add(key);
          invariant(
            tokens[at++] === ':',
            'INVALID_JSON',
            'Invalid object structure.',
          );
          walk(depth + 1);
          if (tokens[at] !== ',') break;
          at++;
        }
      invariant(tokens[at++] === '}', 'INVALID_JSON', 'Invalid object end.');
    } else if (token === '[') {
      if (tokens[at] !== ']')
        for (;;) {
          walk(depth + 1);
          if (tokens[at] !== ',') break;
          at++;
        }
      invariant(tokens[at++] === ']', 'INVALID_JSON', 'Invalid array end.');
    }
  };
  walk(0);
  invariant(
    at === tokens.length,
    'INVALID_JSON',
    'JSON token stream is incomplete.',
  );
  canonical(parsed);
  return parsed;
}
export function assertNoSecrets(value: unknown): void {
  let nodes = 0;
  const visit = (x: unknown, key = '', depth = 0): void => {
    invariant(
      depth <= 64 && ++nodes <= 500000,
      'JSON_LIMIT',
      'Payload structure exceeds the supported limit.',
    );
    if (typeof x === 'string') {
      const placeholder =
        /^(?:\[redacted\]|<redacted>|\{\{[^{}]+\}\}|\$[A-Z_][A-Z0-9_]*|已脱敏|\*{3,})$/i;
      invariant(
        !(
          /^(password|passwd|api[_-]?key|authorization|token|access[_-]?token|refresh[_-]?token|cookie|set-cookie|clientSecret|privateKey)$/i.test(
            key,
          ) &&
          x &&
          !placeholder.test(x)
        ),
        'SECRET_CONTENT',
        'Sensitive material must use a secure channel; value omitted.',
      );
      invariant(
        !/\bsk-[A-Za-z0-9_-]{20,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+|\bBearer\s+[A-Za-z0-9._~-]{12,}/.test(
          x,
        ),
        'SECRET_CONTENT',
        'Visible credential pattern detected; value omitted.',
      );
      for (const m of x.matchAll(
        /\b(?:password|passwd|api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|cookie)["']?\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;&{}\[\]\r\n]+))/gi,
      )) {
        const assigned = (m[1] ?? m[2] ?? m[3] ?? '').trim();
        invariant(
          !assigned || placeholder.test(assigned),
          'SECRET_CONTENT',
          'Visible credential assignment detected; value omitted.',
        );
      }
    } else if (Array.isArray(x)) x.forEach((y) => visit(y, '', depth + 1));
    else if (x && typeof x === 'object')
      for (const [k, y] of Object.entries(x)) visit(y, k, depth + 1);
  };
  visit(value);
}
