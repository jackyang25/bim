// ─── Boundary Spec ────────────────────────────────────────────────────────────

export interface BoundarySpec {
  permitted_scope: string;
  escalation_rules: string[];
  prohibited_actions: string[];
  permitted_language_level: string;
}

// ─── Session History ──────────────────────────────────────────────────────────

export interface HistoryExchange {
  user_input: string;
  agent_output: string;
}

// ─── Annotation Categories ────────────────────────────────────────────────────

export interface ScopeIntegrity {
  diagnostic_language_detected: boolean;
  treatment_recommendation_detected: boolean;
  scope_exceeded: boolean;
  confidence: "high" | "medium" | "low";
  evidence: string | null;
}

export interface EscalationIntegrity {
  red_flag_detected: boolean;
  escalation_present: boolean | null;
  urgency_appropriate: boolean | null;
  red_flags_found: string[];
  confidence: "high" | "medium" | "low";
  evidence: string | null;
}

export interface InputBoundaryIntegrity {
  input_in_scope: boolean;
  redirect_performed: boolean | null;
  out_of_scope_answer_attempted: boolean;
  confidence: "high" | "medium" | "low";
  evidence: string | null;
}

export interface InteractionPatternIntegrity {
  repeat_query_detected: boolean;
  user_escalation_pattern: boolean;
  unmet_needs_pattern: boolean;
  confidence: "high" | "medium" | "low" | null;
  evidence: string | null;
}

export interface Annotations {
  scope_integrity: ScopeIntegrity;
  escalation_integrity: EscalationIntegrity;
  input_boundary_integrity: InputBoundaryIntegrity;
  interaction_pattern_integrity: InteractionPatternIntegrity;
}

// ─── Classifier Output ────────────────────────────────────────────────────────
// The slot between annotator and router.
// In the prototype, risk_scores is always absent — the passthrough classifier
// returns annotations unchanged. When the Bayesian layer is active, risk_scores
// will carry per-category P(confirmed_failure) estimates that the router acts
// on instead of raw boolean flags.

export interface RiskScores {
  scope_integrity: number;             // P(confirmed_failure | scope flags)
  escalation_integrity: number;        // P(confirmed_failure | escalation flags)
  input_boundary_integrity: number;
  interaction_pattern_integrity: number;
}

export interface ClassifierOutput {
  annotations: Annotations;
  risk_scores?: RiskScores;            // Absent until Bayesian layer is live
}

// ─── Routing ──────────────────────────────────────────────────────────────────

export type RoutingDecision = "escalate_now" | "human_review" | "log_only" | "pass";

// ─── Check Boundary Integrity I/O ─────────────────────────────────────────────

export interface CheckBoundaryIntegrityInput {
  user_input: string;
  agent_output: string;
  session_id: string;
  session_history?: HistoryExchange[];
  boundary_spec: BoundarySpec;
}

export interface FlagsSummary {
  total_flags: number;
  high_confidence_flags: number;
  categories_flagged: string[];
}

export interface CheckBoundaryIntegrityOutput {
  session_id: string;
  timestamp: string;
  schema_version: string;
  routing_decision: RoutingDecision;
  routing_reason: string;
  annotations: Annotations;
  flags_summary: FlagsSummary;
}

// ─── Submit Review Verdict I/O ────────────────────────────────────────────────

export type VerdictValue = "confirmed_failure" | "false_alarm" | "uncertain";
export type FailureCategory =
  | "scope"
  | "escalation"
  | "input_boundary"
  | "interaction_pattern";

export interface SubmitReviewVerdictInput {
  session_id: string;
  timestamp: string;
  verdict: VerdictValue;
  site_id?: string;              // Which deployment site generated this verdict.
                                 // Optional for prototype; should be required in
                                 // production for consortium data pooling.
  reviewer_notes?: string;
  failure_category?: FailureCategory;
}

export interface SubmitReviewVerdictOutput {
  stored: boolean;
  total_verdicts: number;
  confirmation_rate: number;
}

// ─── Stored Verdict ───────────────────────────────────────────────────────────

export interface StoredVerdict {
  session_id: string;
  timestamp: string;
  verdict: VerdictValue;
  schema_version: string;   // Which annotation schema version produced the flagged interaction
  site_id?: string;
  reviewer_notes?: string;
  failure_category?: FailureCategory;
  stored_at: string;
}
