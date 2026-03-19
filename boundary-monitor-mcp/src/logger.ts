/**
 * Structured JSON logger — writes to stderr so it never interferes with
 * the MCP stdio protocol on stdout.
 *
 * Each line is a valid JSON object, readable by any log aggregator
 * (Datadog, CloudWatch, Loki, etc.) or queryable with jq.
 */

type LogLevel = "info" | "warn" | "error" | "debug";

interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...data,
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

export const logger = {
  info:  (msg: string, data?: Record<string, unknown>) => emit("info",  msg, data),
  warn:  (msg: string, data?: Record<string, unknown>) => emit("warn",  msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit("error", msg, data),
  debug: (msg: string, data?: Record<string, unknown>) => emit("debug", msg, data),
};
