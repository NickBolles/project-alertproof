type LogContext = Record<string, unknown>;

const SENSITIVE_KEY =
  /(authorization|auth.?token|secret|password|credential|payload|body|destination)/i;

function safeValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => safeValue("item", item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([childKey, child]) => [childKey, safeValue(childKey, child)],
      ),
    );
  }
  return value;
}

function write(
  level: "info" | "warn" | "error",
  event: string,
  context: LogContext = {},
): void {
  if (process.env.ALERTPROOF_LOG_LEVEL === "silent") return;
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...Object.fromEntries(
      Object.entries(context).map(([key, value]) => [
        key,
        safeValue(key, value),
      ]),
    ),
  };
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export const logger = {
  info: (event: string, context?: LogContext) => write("info", event, context),
  warn: (event: string, context?: LogContext) => write("warn", event, context),
  error: (event: string, context?: LogContext) =>
    write("error", event, context),
};
