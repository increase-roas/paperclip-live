/**
 * Small, dependency-free redaction helpers shared by loggers, audit records
 * and tool payloads.
 *
 * The goal is to keep credential material out of logs and diagnostics, not to
 * classify personal data. Callers that know a field is sensitive should prefer
 * key-based redaction with `redactSensitive` over text heuristics.
 */

const REDACTED = "[REDACTED]";

const SENSITIVE_KEY =
  /^(?:authorization|cookie|set-cookie|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|private[_-]?key|credential|credentials|session[_-]?id)$/i;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|token)\b(\s*[:=]\s*)(["']?)([A-Za-z0-9._~+/=-]{8,})\3/gi,
    `$1$2${REDACTED}`,
  ],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
];

export function redactText(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export interface RedactOptions {
  /** Maximum object/array depth to walk. Deeper values become "[Truncated]". */
  maxDepth?: number;
  /** Maximum string length before truncation. */
  maxStringLength?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function redactSensitive(value: unknown, options: RedactOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? 6;
  const maxStringLength = options.maxStringLength ?? 4_000;
  const seen = new WeakSet<object>();

  const walk = (current: unknown, depth: number): unknown => {
    if (depth > maxDepth) return "[Truncated]";
    if (typeof current === "string") {
      const redacted = redactText(current);
      return redacted.length > maxStringLength
        ? `${redacted.slice(0, maxStringLength)}…`
        : redacted;
    }
    if (current === null || typeof current !== "object") return current;
    if (seen.has(current)) return "[Circular]";
    seen.add(current);

    if (Array.isArray(current)) {
      return current.map((entry) => walk(entry, depth + 1));
    }
    if (!isPlainObject(current)) return String(current);

    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(current)) {
      output[key] = SENSITIVE_KEY.test(key) ? REDACTED : walk(entry, depth + 1);
    }
    return output;
  };

  return walk(value, 0);
}

export const REDACTED_VALUE = REDACTED;
