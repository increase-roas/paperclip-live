import { redactSensitive } from "./redaction.js";
import type { TraceContext } from "./trace.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface StructuredLogRecord {
  /** ISO-8601 timestamp. */
  time: string;
  level: LogLevel;
  service: string;
  message: string;
  traceId?: string;
  requestId?: string;
  context?: Record<string, unknown>;
}

export type StructuredLogSink = (record: StructuredLogRecord, line: string) => void;

export interface StructuredLoggerOptions {
  service: string;
  level?: LogLevel;
  trace?: TraceContext;
  context?: Record<string, unknown>;
  sink?: StructuredLogSink;
  now?: () => Date;
}

export interface StructuredLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): StructuredLogger;
  withTrace(trace: TraceContext): StructuredLogger;
}

function defaultSink(record: StructuredLogRecord, line: string): void {
  const write = record.level === "error" || record.level === "warn" ? console.error : console.log;
  write(line);
}

/**
 * Creates a JSON-line logger. Every field passes through `redactSensitive`
 * before it reaches the sink, so a stray token in a context object cannot
 * leak into logs.
 */
export function createStructuredLogger(options: StructuredLoggerOptions): StructuredLogger {
  const minimum = LEVEL_WEIGHT[options.level ?? "info"];
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());

  const build = (
    trace: TraceContext | undefined,
    baseContext: Record<string, unknown> | undefined,
  ): StructuredLogger => {
    const emit = (level: LogLevel, message: string, context?: Record<string, unknown>) => {
      if (LEVEL_WEIGHT[level] < minimum) return;
      const record: StructuredLogRecord = {
        time: now().toISOString(),
        level,
        service: options.service,
        message,
      };
      if (trace) {
        record.traceId = trace.traceId;
        record.requestId = trace.requestId;
      }
      const merged = { ...baseContext, ...context };
      if (Object.keys(merged).length > 0) {
        record.context = redactSensitive(merged) as Record<string, unknown>;
      }
      sink(record, JSON.stringify(record));
    };

    return {
      debug: (message, context) => emit("debug", message, context),
      info: (message, context) => emit("info", message, context),
      warn: (message, context) => emit("warn", message, context),
      error: (message, context) => emit("error", message, context),
      child: (context) => build(trace, { ...baseContext, ...context }),
      withTrace: (nextTrace) => build(nextTrace, baseContext),
    };
  };

  return build(options.trace, options.context);
}
