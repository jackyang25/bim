import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AnthropicAnnotator } from "./annotator.js";
import type { AnnotatorBackend } from "./annotator.js";
import { BayesianClassifier } from "./classifier.js";
import type { ClassifierBackend } from "./classifier.js";
import { UniformPrior, ConfigPrior, PooledPrior } from "./prior.js";
import type { PriorSource } from "./prior.js";
import { route } from "./router.js";
import { LocalJsonVerdictStore } from "./verdict-store.js";
import type { VerdictStore } from "./verdict-store.js";
import { AuditLog } from "./audit-log.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import type {
  BoundarySpec,
  CheckBoundaryIntegrityInput,
  CheckBoundaryIntegrityOutput,
  SubmitReviewVerdictInput,
} from "./types.js";

// ─── Prior source factory ────────────────────────────────────────────────────

function createPriorSource(store: VerdictStore): PriorSource {
  switch (config.prior.source) {
    case "config":
      if (!config.prior.configPath) {
        logger.warn("prior_config_path_missing", { fallback: "UniformPrior" });
        return new UniformPrior();
      }
      return new ConfigPrior(config.prior.configPath);
    case "pooled":
      return new PooledPrior(store);
    case "uniform":
    default:
      return new UniformPrior();
  }
}

// ─── Wiring point ─────────────────────────────────────────────────────────────
// Swap implementations here to change backends.

const annotator: AnnotatorBackend = new AnthropicAnnotator();
const store: VerdictStore = new LocalJsonVerdictStore();
const priorSource: PriorSource = createPriorSource(store);
const classifier: ClassifierBackend = new BayesianClassifier(store, priorSource);
const auditLog = new AuditLog(config.storage.auditLogPath);
const SERVER_START = Date.now();

// ─── Startup checks ───────────────────────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  logger.warn("ANTHROPIC_API_KEY not set — annotation calls will fail and route to human_review");
}

logger.info("server_starting", {
  version: config.server.version,
  schema_version: config.server.schemaVersion,
  model: config.annotation.model,
  annotation_timeout_ms: config.annotation.timeoutMs,
  max_requests_per_minute: config.limits.maxRequestsPerMinute,
});

// ─── Rate limiter — sliding window ───────────────────────────────────────────
// Protects against a misbehaving client flooding the annotation API.
// In-memory; resets on server restart. Applies only to check_boundary_integrity
// since that is the only tool with a paid external API call.

class RateLimiter {
  private timestamps: number[] = [];
  private readonly windowMs = 60_000;
  private readonly max: number;

  constructor(maxPerMinute: number) {
    this.max = maxPerMinute;
  }

  check(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.max) return false;
    this.timestamps.push(now);
    return true;
  }

  remaining(): number {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    return Math.max(0, this.max - this.timestamps.length);
  }
}

const rateLimiter = new RateLimiter(config.limits.maxRequestsPerMinute);

// ─── Input validation helper ──────────────────────────────────────────────────

function errorResponse(message: string, code: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: code, message }) }],
    isError: true as const,
  };
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: config.server.name,
  version: config.server.version,
});

// ─── Tool: check_boundary_integrity ──────────────────────────────────────────

const HistoryExchangeSchema = z.object({
  user_input: z.string(),
  agent_output: z.string(),
});

const BoundarySpecSchema = z.object({
  permitted_scope: z.string().describe("What the agent is allowed to do"),
  escalation_rules: z.array(z.string()).describe("Red-flag conditions that MUST trigger escalation"),
  prohibited_actions: z.array(z.string()).describe("Things the agent must never do"),
  permitted_language_level: z.string().describe("Level of clinical language allowed"),
});

server.tool(
  "check_boundary_integrity",
  "Checks whether a clinical AI agent's output respected its defined operational boundaries. Returns an annotation and routing decision. Does NOT evaluate clinical accuracy.",
  {
    user_input: z.string().describe("What the user said to the clinical agent"),
    agent_output: z.string().describe("What the clinical agent responded"),
    session_id: z.string().describe("Identifier for the conversation session"),
    session_history: z.array(HistoryExchangeSchema).optional().describe("Previous exchanges in this session"),
    boundary_spec: BoundarySpecSchema.describe("The boundary rules this agent is supposed to follow"),
  },
  async (input) => {
    const typed = input as CheckBoundaryIntegrityInput;
    const timestamp = new Date().toISOString();
    const t0 = Date.now();

    // ── Rate limit ────────────────────────────────────────────────────────────
    if (!rateLimiter.check()) {
      logger.warn("rate_limit_exceeded", { session_id: typed.session_id });
      return errorResponse(
        `Rate limit exceeded — maximum ${config.limits.maxRequestsPerMinute} requests per minute`,
        "rate_limit_exceeded"
      );
    }

    // ── Input size limits ─────────────────────────────────────────────────────
    if (typed.user_input.length > config.limits.maxUserInputChars) {
      return errorResponse(
        `user_input exceeds maximum length of ${config.limits.maxUserInputChars} characters`,
        "input_too_large"
      );
    }
    if (typed.agent_output.length > config.limits.maxAgentOutputChars) {
      return errorResponse(
        `agent_output exceeds maximum length of ${config.limits.maxAgentOutputChars} characters`,
        "input_too_large"
      );
    }
    if (
      typed.session_history &&
      typed.session_history.length > config.limits.maxSessionHistoryItems
    ) {
      return errorResponse(
        `session_history exceeds maximum of ${config.limits.maxSessionHistoryItems} items`,
        "input_too_large"
      );
    }

    // ── Validate boundary_spec ────────────────────────────────────────────────
    const spec = typed.boundary_spec as BoundarySpec;
    const missingFields: string[] = [];
    if (!spec.permitted_scope) missingFields.push("permitted_scope");
    if (!spec.escalation_rules?.length) missingFields.push("escalation_rules");
    if (!spec.prohibited_actions?.length) missingFields.push("prohibited_actions");
    if (!spec.permitted_language_level) missingFields.push("permitted_language_level");

    if (missingFields.length > 0) {
      return errorResponse(
        `boundary_spec is missing required fields: ${missingFields.join(", ")}`,
        "missing_boundary_spec_fields"
      );
    }

    logger.info("check_started", {
      session_id: typed.session_id,
      has_session_history: !!typed.session_history?.length,
      user_input_chars: typed.user_input.length,
      agent_output_chars: typed.agent_output.length,
    });

    // ── Pipeline: annotate → classify → route ─────────────────────────────────
    try {
      const annotations = await annotator.annotate(
        typed.user_input,
        typed.agent_output,
        spec,
        typed.session_history
      );

      const classifierOutput = await classifier.classify(annotations);
      const { routing_decision, routing_reason, flags_summary } = route(classifierOutput);

      const annotation_latency_ms = Date.now() - t0;

      const output: CheckBoundaryIntegrityOutput = {
        session_id: typed.session_id,
        timestamp,
        schema_version: config.server.schemaVersion,
        routing_decision,
        routing_reason,
        annotations,
        flags_summary,
      };

      logger.info("check_complete", {
        session_id: typed.session_id,
        routing_decision,
        total_flags: flags_summary.total_flags,
        annotation_latency_ms,
      });

      auditLog.append({
        ts: timestamp,
        schema_version: config.server.schemaVersion,
        session_id: typed.session_id,
        routing_decision,
        total_flags: flags_summary.total_flags,
        high_confidence_flags: flags_summary.high_confidence_flags,
        categories_flagged: flags_summary.categories_flagged,
        annotation_latency_ms,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    } catch (err) {
      const annotation_latency_ms = Date.now() - t0;

      logger.error("check_failed", {
        session_id: typed.session_id,
        error: String(err),
        annotation_latency_ms,
      });

      // Fail safe
      const output: CheckBoundaryIntegrityOutput = {
        session_id: typed.session_id,
        timestamp,
        schema_version: config.server.schemaVersion,
        routing_decision: "human_review",
        routing_reason: "annotation_service_unavailable — defaulting to human review",
        annotations: {
          scope_integrity: {
            diagnostic_language_detected: false,
            treatment_recommendation_detected: false,
            scope_exceeded: false,
            confidence: "low",
            evidence: null,
          },
          escalation_integrity: {
            red_flag_detected: false,
            escalation_present: null,
            urgency_appropriate: null,
            red_flags_found: [],
            confidence: "low",
            evidence: null,
          },
          input_boundary_integrity: {
            input_in_scope: true,
            redirect_performed: null,
            out_of_scope_answer_attempted: false,
            confidence: "low",
            evidence: null,
          },
          interaction_pattern_integrity: {
            repeat_query_detected: false,
            user_escalation_pattern: false,
            unmet_needs_pattern: false,
            confidence: null,
            evidence: null,
          },
        },
        flags_summary: {
          total_flags: 0,
          high_confidence_flags: 0,
          categories_flagged: [],
        },
      };

      auditLog.append({
        ts: timestamp,
        schema_version: config.server.schemaVersion,
        session_id: typed.session_id,
        routing_decision: "human_review",
        total_flags: 0,
        high_confidence_flags: 0,
        categories_flagged: [],
        annotation_latency_ms,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    }
  }
);

// ─── Tool: submit_review_verdict ──────────────────────────────────────────────

server.tool(
  "submit_review_verdict",
  "Submits a human reviewer's verdict on a previously flagged interaction. Stores the verdict for future Bayesian classification.",
  {
    session_id: z.string().describe("Session ID of the flagged interaction"),
    timestamp: z.string().describe("Timestamp from the original check_boundary_integrity output"),
    verdict: z.enum(["confirmed_failure", "false_alarm", "uncertain"]).describe("Reviewer verdict"),
    site_id: z.string().optional().describe("Site identifier — which deployment generated this verdict"),
    reviewer_notes: z.string().optional(),
    failure_category: z
      .enum(["scope", "escalation", "input_boundary", "interaction_pattern"])
      .optional(),
  },
  async (input) => {
    const result = await store.store(input as SubmitReviewVerdictInput);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ─── Tool: get_classifier_state ───────────────────────────────────────────────

server.tool(
  "get_classifier_state",
  "Returns the current Bayesian classifier state: per-category priors, local verdict counts, posterior estimates, active routing thresholds, and effective sample sizes. Read-only — use this to understand how the system is currently scoring each category.",
  {},
  async () => {
    const state = (classifier as BayesianClassifier).getState();

    const output = {
      ...state,
      routing_thresholds: {
        escalate_now_safety: config.routing.tEscalateSafety,
        escalate_now: config.routing.tEscalate,
        human_review: config.routing.tReview,
        log_only: config.routing.tNoise,
      },
      interpretation: Object.fromEntries(
        (["scope", "escalation", "input_boundary", "interaction_pattern"] as const).map((cat) => {
          const c = state.categories[cat];
          const mean = c.posterior.mean;
          let routing: string;
          if (cat === "escalation" && mean >= config.routing.tEscalateSafety) {
            routing = "escalate_now";
          } else if (mean >= config.routing.tEscalate) {
            routing = "escalate_now";
          } else if (mean >= config.routing.tReview) {
            routing = "human_review";
          } else if (mean >= config.routing.tNoise) {
            routing = "log_only";
          } else {
            routing = "pass";
          }
          return [cat, {
            posterior_mean: Math.round(mean * 1000) / 1000,
            would_route_to: routing,
            data_strength: c.effective_sample_size <= 2 ? "prior only"
              : c.effective_sample_size <= 12 ? "weak (prior-dominated)"
              : c.effective_sample_size <= 50 ? "moderate"
              : "strong (data-dominated)",
          }];
        })
      ),
    };

    logger.info("classifier_state_requested");

    return {
      content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    };
  }
);

// ─── Tool: health_check ───────────────────────────────────────────────────────

server.tool(
  "health_check",
  "Returns server status, configuration, and operational metrics.",
  {},
  async () => {
    const verdicts = store.getAll();
    const confirmed = verdicts.filter((v) => v.verdict === "confirmed_failure").length;

    const health = {
      status: "ok",
      server: config.server.name,
      version: config.server.version,
      schema_version: config.server.schemaVersion,
      uptime_seconds: Math.floor((Date.now() - SERVER_START) / 1000),
      annotation_backend: (annotator as AnthropicAnnotator).backendName ?? "AnthropicAnnotator",
      classifier_backend: (classifier as BayesianClassifier).backendName,
      verdict_store: (store as LocalJsonVerdictStore).storeName ?? "LocalJsonVerdictStore",
      model: config.annotation.model,
      annotation_timeout_ms: config.annotation.timeoutMs,
      api_key_configured: !!process.env.ANTHROPIC_API_KEY,
      rate_limit_remaining: rateLimiter.remaining(),
      verdicts: {
        total: verdicts.length,
        confirmed_failures: confirmed,
        confirmation_rate:
          verdicts.length > 0
            ? Math.round((confirmed / verdicts.length) * 100) / 100
            : 0,
      },
    };

    logger.info("health_check", { uptime_seconds: health.uptime_seconds });

    return {
      content: [{ type: "text", text: JSON.stringify(health, null, 2) }],
    };
  }
);

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  logger.info("shutdown_initiated", { signal });
  try {
    await server.close();
    logger.info("shutdown_complete");
  } catch (err) {
    logger.error("shutdown_error", { error: String(err) });
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT",  () => void shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  logger.error("uncaught_exception", { error: String(err), stack: err.stack });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled_rejection", { reason: String(reason) });
  process.exit(1);
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("server_ready", {
    name: config.server.name,
    version: config.server.version,
  });
}

main().catch((err) => {
  logger.error("startup_failed", { error: String(err) });
  process.exit(1);
});
