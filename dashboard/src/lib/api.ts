const BASE = "/api";

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ─── Review Queue ──────────────────────────────────────────────────────────────

export interface ReviewQueueItem {
  id: string;
  timestamp: string;
  session_id: string;
  user_input: string;
  agent_output: string;
  routing_decision: string;
  routing_reason: string;
  annotations: Record<string, unknown>;
  flags_summary: {
    total_flags: number;
    high_confidence_flags: number;
    categories_flagged: string[];
  };
  risk_scores: Record<string, number> | null;
  boundary_spec: {
    permitted_scope: string;
    escalation_rules: string[];
    prohibited_actions: string[];
    permitted_language_level: string;
  };
}

export interface ReviewQueueResponse {
  items: ReviewQueueItem[];
  total: number;
}

export function fetchReviewQueue(): Promise<ReviewQueueResponse> {
  return request("/review-queue");
}

export function submitVerdict(
  id: string,
  verdict: "confirmed_failure" | "false_alarm" | "uncertain",
  failureCategory?: string,
  reviewerNotes?: string,
): Promise<{ success: boolean }> {
  return request(`/review-queue/${encodeURIComponent(id)}/verdict`, {
    method: "POST",
    body: JSON.stringify({
      verdict,
      failure_category: failureCategory,
      reviewer_notes: reviewerNotes,
    }),
  });
}

// ─── Classifier State ──────────────────────────────────────────────────────────

export interface CategoryState {
  prior: { alpha: number; beta: number };
  local_verdicts: { confirmed: number; false_alarm: number };
  posterior: { alpha: number; beta: number; mean: number };
  effective_sample_size: number;
}

export interface ClassifierState {
  categories: Record<string, CategoryState>;
  routing_thresholds: {
    escalate_now_safety: number;
    escalate_now: number;
    human_review: number;
    log_only: number;
  };
  interpretation: Record<
    string,
    {
      posterior_mean: number;
      would_route_to: string;
      data_strength: string;
    }
  >;
}

export function fetchClassifierState(): Promise<ClassifierState> {
  return request("/classifier-state");
}

// ─── Health ────────────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  server: string;
  version: string;
  schema_version: string;
  uptime_seconds: number;
  annotation_backend: string;
  classifier_backend: string;
  verdict_store: string;
  model: string;
  annotation_timeout_ms: number;
  api_key_configured: boolean;
  rate_limit_remaining: number;
  verdicts: {
    total: number;
    confirmed_failures: number;
    confirmation_rate: number;
  };
}

export function fetchHealth(): Promise<HealthResponse> {
  return request("/health");
}

// ─── Audit Log ─────────────────────────────────────────────────────────────────

export interface AuditEntry {
  ts: string;
  schema_version: string;
  session_id: string;
  routing_decision: string;
  total_flags: number;
  high_confidence_flags: number;
  categories_flagged: string[];
  annotation_latency_ms: number;
}

export interface AuditLogResponse {
  entries: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export function fetchAuditLog(params: {
  page?: number;
  pageSize?: number;
  routing_decision?: string;
  from?: string;
  to?: string;
}): Promise<AuditLogResponse> {
  const qs = new URLSearchParams();
  if (params.page != null) qs.set("page", String(params.page));
  if (params.pageSize != null) qs.set("pageSize", String(params.pageSize));
  if (params.routing_decision) qs.set("routing_decision", params.routing_decision);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  return request(`/audit-log?${qs.toString()}`);
}

// ─── Verdict Summary ───────────────────────────────────────────────────────────

export interface VerdictSummary {
  total: number;
  by_verdict: Record<string, number>;
  by_category: Record<string, Record<string, number>>;
}

export function fetchVerdictSummary(): Promise<VerdictSummary> {
  return request("/verdicts/summary");
}
