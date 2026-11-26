import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, rename, stat, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { redactIncidentFields, redactIncidentText } from "@paperclipai/shared/observability";
import { resolveDefaultLogsDir } from "../home-paths.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const BACKUPS = 3;
const MAX_PENDING_WRITES = 256;
const INCIDENT_WINDOW_MS = 5 * 60_000;

type ErrorSource = "server" | "client";
type ErrorSeverity = "error" | "fatal";

export interface ErrorRecordInput {
  source: ErrorSource;
  severity: ErrorSeverity;
  message: string;
  stack?: string;
  route?: string;
  method?: string;
  statusCode?: number;
  componentStack?: string;
  userAgent?: string;
  release?: string;
  meta?: Record<string, unknown>;
}

export interface ErrorRecord extends ErrorRecordInput {
  id: string;
  ts: string;
  fingerprint: string;
}

export interface ErrorLogQuery {
  q?: string;
  source?: ErrorSource;
  severity?: ErrorSeverity;
  since?: string;
  limit?: number;
}

let storageQueue = Promise.resolve();
let pendingWrites = 0;
const incidents = new Map<string, number>();

function inStorageOrder<T>(operation: () => Promise<T>): Promise<T> {
  const next = storageQueue.then(operation);
  storageQueue = next.then(() => {}, () => {});
  return next;
}

export function redactErrorRecord(record: ErrorRecordInput): ErrorRecordInput {
  return {
    source: record.source,
    severity: record.severity,
    message: redactIncidentText(record.message, 2048),
    stack: record.stack && redactIncidentText(record.stack, 8192),
    route: record.route && redactIncidentText(record.route.split(/[?#]/, 1)[0], 1024),
    method: record.method && redactIncidentText(record.method, 16),
    statusCode: record.statusCode,
    componentStack: record.componentStack && redactIncidentText(record.componentStack, 4096),
    userAgent: record.userAgent && redactIncidentText(record.userAgent, 512),
    release: record.release && redactIncidentText(record.release, 128),
    meta: record.meta && redactIncidentFields(record.meta),
  };
}

function errorLogPath(): string {
  return join(resolveDefaultLogsDir(), "ir-errors.jsonl");
}

function filePath(base: string, rotation: number): string {
  return rotation === 0 ? base : `${base}.${rotation}`;
}

async function optional<T>(operation: Promise<T>): Promise<T | undefined> {
  try {
    return await operation;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function appendRecord(path: string, record: ErrorRecord): Promise<void> {
  let line = `${JSON.stringify(record)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const existing = await optional(stat(path));
  if (existing?.size && existing.size + Buffer.byteLength(line) > MAX_FILE_BYTES) {
    for (let index = BACKUPS; index > 0; index--) {
      await optional(rename(filePath(path, index - 1), filePath(path, index)));
    }
  } else if (existing?.size) {
    const file = await open(path, "r");
    try {
      const tail = Buffer.alloc(1);
      const { bytesRead } = await file.read(tail, 0, 1, existing.size - 1);
      if (bytesRead && tail[0] !== 10) line = `\n${line}`;
    } finally {
      await file.close();
    }
  }
  await appendFile(path, line, { mode: 0o600 });
}

function makeRecord(input: ErrorRecordInput): ErrorRecord {
  const record = redactErrorRecord(input);
  const fingerprint = createHash("sha256").update(JSON.stringify([
    record.source, record.message, record.route, record.statusCode,
    record.stack?.split("\n", 2)[1],
  ])).digest("hex").slice(0, 32);
  return { ...record, id: randomUUID(), ts: new Date().toISOString(), fingerprint };
}

async function relayIncident(record: ErrorRecord): Promise<void> {
  const url = process.env.IR_ERROR_INCIDENT_WEBHOOK_URL?.trim();
  if (!url) return;
  const now = Date.now();
  for (const [fingerprint, expiresAt] of incidents) {
    if (expiresAt > now) break;
    incidents.delete(fingerprint);
  }
  if (incidents.has(record.fingerprint) || incidents.size >= 1024) return;
  incidents.set(record.fingerprint, now + INCIDENT_WINDOW_MS);

  const { id, ts, source, severity, fingerprint, message, route, method, statusCode, release } = record;
  const token = process.env.IR_ERROR_INCIDENT_WEBHOOK_TOKEN;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ id, ts, source, severity, fingerprint, message, route, method, statusCode, release }),
    signal: AbortSignal.timeout(3000),
    redirect: "error",
  });
  await response.body?.cancel();
}

async function recordError(input: ErrorRecordInput): Promise<ErrorRecord> {
  if (pendingWrites >= MAX_PENDING_WRITES) throw new Error("IR error log is busy");
  const record = makeRecord(input);
  const path = errorLogPath();
  pendingWrites++;
  try {
    await inStorageOrder(() => appendRecord(path, record));
  } finally {
    pendingWrites--;
  }
  void relayIncident(record).catch(() => {});
  return record;
}

export function recordClientError(input: Omit<ErrorRecordInput, "source">): Promise<ErrorRecord> {
  return recordError({ ...input, source: "client" });
}

export function recordServerError(input: Omit<ErrorRecordInput, "source">): void {
  void recordError({ ...input, source: "server" }).catch(() => {});
}

interface LogSnapshot {
  file: FileHandle;
  size: number;
}

async function openSnapshot(): Promise<LogSnapshot[]> {
  const files: LogSnapshot[] = [];
  const path = errorLogPath();
  try {
    for (let index = 0; index <= BACKUPS; index++) {
      const file = await optional(open(filePath(path, index), "r"));
      if (!file) continue;
      const snapshot = { file, size: 0 };
      files.push(snapshot);
      snapshot.size = (await file.stat()).size;
    }
    return files;
  } catch (error) {
    await closeSnapshot(files);
    throw error;
  }
}

function closeSnapshot(files: LogSnapshot[]) {
  return Promise.allSettled(files.map(({ file }) => file.close()));
}

function parseRecord(line: string): ErrorRecord | undefined {
  try {
    const item: ErrorRecord = JSON.parse(line);
    if (typeof item?.id === "string" && typeof item.message === "string") return item;
  } catch {
    // A process can stop during its final append.
  }
}

function matches(item: ErrorRecord, filters: ErrorLogQuery, q: string, since: number | undefined): boolean {
  return (!filters.source || item.source === filters.source)
    && (!filters.severity || item.severity === filters.severity)
    && (since === undefined || Date.parse(item.ts) >= since)
    && (!q || [item.message, item.route, item.stack, item.fingerprint]
      .some((value) => typeof value === "string" && value.toLowerCase().includes(q)));
}

async function scanLog(
  { file, size }: LogSnapshot,
  matchesRecord: (record: ErrorRecord) => boolean,
  limit: number,
) {
  const latest: ErrorRecord[] = [];
  if (size === 0) return { count: 0, latest };
  const input = file.createReadStream({ encoding: "utf8", end: size - 1, autoClose: false });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let count = 0;
  for await (const line of lines) {
    const record = parseRecord(line);
    if (!record || !matchesRecord(record)) continue;
    if (limit) latest[count % limit] = record;
    count++;
  }
  const boundary = limit ? count % limit : 0;
  return { count, latest: latest.slice(boundary).concat(latest.slice(0, boundary)).reverse() };
}

export async function queryErrorLog(filters: ErrorLogQuery = {}) {
  const limit = Math.min(500, Math.max(1, Math.floor(filters.limit ?? 100)));
  const q = filters.q?.toLowerCase() ?? "";
  const since = filters.since ? Date.parse(filters.since) : undefined;
  const files = await inStorageOrder(openSnapshot);
  const items: ErrorRecord[] = [];
  let total = 0;
  try {
    for (const file of files) {
      const { count, latest } = await scanLog(file, (item) => matches(item, filters, q, since), limit - items.length);
      total += count;
      items.push(...latest);
    }
  } finally {
    await closeSnapshot(files);
  }
  return { total, items, sentryEnabled: Boolean(process.env.SENTRY_DSN) };
}
