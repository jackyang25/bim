/**
 * Centralised configuration — all tunable values read from environment variables.
 * Change behaviour by setting env vars; no code changes required.
 *
 * See .env.example for the full documented surface.
 */

function int(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function float(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  server: {
    name: "boundary-integrity-monitor",
    version: "0.1.0",
    schemaVersion: "1.0",           // Bump when annotation schema changes
  },

  annotation: {
    model: str("ANNOTATION_MODEL", "claude-sonnet-4-20250514"),
    timeoutMs: int("ANNOTATION_TIMEOUT_MS", 30_000),
    maxRetries: int("ANNOTATION_MAX_RETRIES", 1),
  },

  limits: {
    maxUserInputChars:       int("MAX_USER_INPUT_CHARS",       10_000),
    maxAgentOutputChars:     int("MAX_AGENT_OUTPUT_CHARS",     10_000),
    maxSessionHistoryItems:  int("MAX_SESSION_HISTORY_ITEMS",  20),
    maxRequestsPerMinute:    int("MAX_REQUESTS_PER_MINUTE",    60),
  },

  // Prior source for the Bayesian classifier.
  // PRIOR_SOURCE: "uniform" | "config" | "pooled"
  //   uniform — Beta(1,1) per category, zero knowledge (default)
  //   config  — loads per-category priors from PRIOR_CONFIG_PATH JSON file
  //   pooled  — computes priors from shared verdict pool
  // PRIOR_CONFIG_PATH: path to JSON file (only used when PRIOR_SOURCE=config)
  prior: {
    source: str("PRIOR_SOURCE", "uniform") as "uniform" | "config" | "pooled",
    configPath: process.env.PRIOR_CONFIG_PATH,
  },

  // Bayesian routing thresholds — calibrated empirically from verdict data.
  // Exposed here so they can be tuned per deployment without code changes.
  routing: {
    tEscalateSafety: float("T_ESCALATE_SAFETY", 0.70), // Escalation category
    tEscalate:       float("T_ESCALATE",        0.85), // Other categories
    tReview:         float("T_REVIEW",          0.40),
    tNoise:          float("T_NOISE",           0.10),
  },

  storage: {
    verdictsPath: process.env.VERDICTS_PATH,   // undefined = default path
    auditLogPath: process.env.AUDIT_LOG_PATH,  // undefined = default path
  },
} as const;
