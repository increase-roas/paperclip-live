import { REDACTED_VALUE, redactText } from "./redaction.js";

const SECRET_NAME = String.raw`(?:x[-_])?(?:authorization|(?:set[-_])?cookie|api[-_]?key|private[-_]?key|session[-_]?id|(?:client[-_])?secret|passw(?:or)?d|(?:(?:access|refresh|session|auth)[-_])?token|credential[s]?)`;
const SECRET_KEY = new RegExp(`^${SECRET_NAME}$`, "i");
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`\b(${SECRET_NAME}["']?\s*[:=]\s*)(?!\[REDACTED\])(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[\[{][\s\S]*|[^\s&,;})\]"']+)`,
  "gi",
);
const HEADER_LINE = /\b((?:authorization|(?:set-)?cookie)[ \t]*:[ \t]*)[^\r\n]+/gi;
const CREDENTIAL = /\b(?:(?:sk|ops|op)[-_]|gh[op]_)[a-z\d_.-]+/gi;
const AUTH_SCHEME = /\b((?:Bearer|Basic)[ \t]+)(?!\[REDACTED\])[^\s,"';)\]}]+/gi;
const URL_USER_INFO = /(\b[a-z][a-z\d+.-]*:\/\/)[^\s/?#]+@/gi;
const URL_PARAM = /([?&])([^=?&\s]+)=([^&#\r\n]*)/g;
const SECRET_PATH_NAMESPACE = /^(?:invites?|board-claim)$/i;

function decodeEscapes(value: string): string {
  return value
    .replace(/(?:%[\da-f]{2})+/gi, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    })
    .replace(/\\(?:u00|x)([\da-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function redactSecretPaths(value: string): string {
  return value.replace(/(?:\/|%(?:25){0,3}2f|\\(?:u00|x)2f)(?:\\(?:u00|x)[\da-f]{2}|[^\s?#"'<>\\])*/gi, (path) => {
    const segments = path.split("/");
    for (let index = 0; index < segments.length; index++) {
      let segment = segments[index];
      for (let pass = 0; pass < 4; pass++) {
        const decoded = decodeEscapes(segment);
        if (decoded === segment) break;
        segment = decoded;
      }
      const decodedSegments = segment.split("/");
      const namespace = decodedSegments.findIndex((part) => SECRET_PATH_NAMESPACE.test(part));
      if (namespace >= 0 && namespace < decodedSegments.length - 1) {
        // An encoded slash can pack the token into the namespace segment.
        segments[index] = [...decodedSegments.slice(0, namespace + 1), ":token"].join("/");
      } else {
        segments[index] = segment;
        if (namespace >= 0 && index + 1 < segments.length) segments[++index] = ":token";
      }
    }
    return segments.join("/");
  });
}

function redactParam(match: string, separator: string, key: string): string {
  return SECRET_KEY.test(decodeEscapes(key)) ? `${separator}${key}=${REDACTED_VALUE}` : match;
}

export function redactIncidentText(value: string, limit = 32_768): string {
  return redactText(decodeEscapes(redactSecretPaths(value.slice(0, 32_768).replace(URL_PARAM, redactParam)))
    .replace(URL_PARAM, redactParam)
    .replace(URL_USER_INFO, `$1${REDACTED_VALUE}@`)
    .replace(HEADER_LINE, `$1${REDACTED_VALUE}`)
    .replace(SECRET_ASSIGNMENT, `$1${REDACTED_VALUE}`)
    .replace(AUTH_SCHEME, `$1${REDACTED_VALUE}`)
    .replace(CREDENTIAL, REDACTED_VALUE)).slice(0, limit);
}

export function redactIncidentFields(fields: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth >= 5) return {};
  return Object.fromEntries(Object.entries(fields).slice(0, 32).map(([key, value]) => [
    redactIncidentText(key, 128),
    SECRET_KEY.test(decodeEscapes(key)) ? REDACTED_VALUE : redactValue(value, depth + 1),
  ]));
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth >= 5) return "[Truncated]";
  if (typeof value === "string") return redactIncidentText(value, 2048);
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => redactValue(entry, depth + 1));
  if (value !== null && typeof value === "object") {
    return redactIncidentFields(value as Record<string, unknown>, depth);
  }
  return value;
}
