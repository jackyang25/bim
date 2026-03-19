import { config } from "./config.js";
import type {
  Annotations,
  ClassifierOutput,
  FlagsSummary,
  RoutingDecision,
} from "./types.js";

export interface RoutingResult {
  routing_decision: RoutingDecision;
  routing_reason: string;
  flags_summary: FlagsSummary;
}

// ─── Router ───────────────────────────────────────────────────────────────────
// Routes by comparing per-category Bayesian risk scores against calibrated
// thresholds:
//   τ_escalate_safety — escalation_integrity above this → escalate_now
//   τ_escalate        — any other category above this → escalate_now
//   τ_review          — above this → human_review
//   τ_noise           — above this → log_only
//   below all         → pass
//
// Escalation integrity uses a lower threshold (0.70 vs 0.85) because the
// clinical consequence of a missed escalation is higher than a scope violation.
//
// Thresholds are configurable via environment variables and should be
// calibrated empirically from verdict data per deployment.

export function route(classifierOutput: ClassifierOutput): RoutingResult {
  const { risk_scores } = classifierOutput;
  const flags_summary = computeFlagsSummary(classifierOutput.annotations);

  if (!risk_scores) {
    throw new Error("risk_scores is required — BayesianClassifier should always produce them");
  }

  return routeByProbability(risk_scores, flags_summary);
}

// ─── Probability threshold routing ──────────────────────────────────────────

function routeByProbability(
  risk_scores: NonNullable<ClassifierOutput["risk_scores"]>,
  flags_summary: FlagsSummary
): RoutingResult {
  const T_ESCALATE_SAFETY = config.routing.tEscalateSafety;
  const T_ESCALATE = config.routing.tEscalate;
  const T_REVIEW = config.routing.tReview;
  const T_NOISE = config.routing.tNoise;

  if (risk_scores.escalation_integrity >= T_ESCALATE_SAFETY) {
    return {
      routing_decision: "escalate_now",
      routing_reason: `Escalation integrity risk score ${risk_scores.escalation_integrity.toFixed(2)} exceeds safety threshold (τ=${T_ESCALATE_SAFETY}).`,
      flags_summary,
    };
  }

  const maxScore = Math.max(
    risk_scores.scope_integrity,
    risk_scores.input_boundary_integrity,
    risk_scores.interaction_pattern_integrity
  );

  if (maxScore >= T_ESCALATE) {
    return {
      routing_decision: "escalate_now",
      routing_reason: `Risk score ${maxScore.toFixed(2)} exceeds escalation threshold (τ=${T_ESCALATE}).`,
      flags_summary,
    };
  }

  if (maxScore >= T_REVIEW || risk_scores.escalation_integrity >= T_REVIEW) {
    const dominant = Object.entries(risk_scores).sort((a, b) => b[1] - a[1])[0];
    return {
      routing_decision: "human_review",
      routing_reason: `Risk score for ${dominant[0]} is ${dominant[1].toFixed(2)}, above review threshold (τ=${T_REVIEW}).`,
      flags_summary,
    };
  }

  if (maxScore >= T_NOISE || risk_scores.escalation_integrity >= T_NOISE) {
    return {
      routing_decision: "log_only",
      routing_reason: `Risk scores above noise floor but below review threshold. Logged for analysis.`,
      flags_summary,
    };
  }

  return {
    routing_decision: "pass",
    routing_reason: "All risk scores below noise floor. Interaction appears clean.",
    flags_summary,
  };
}

// ─── Flag summary ─────────────────────────────────────────────────────────────

function computeFlagsSummary(annotations: Annotations): FlagsSummary {
  const categoriesWithFlags: string[] = [];
  let total_flags = 0;
  let high_confidence_flags = 0;

  const scopeFlags =
    (annotations.scope_integrity.diagnostic_language_detected ? 1 : 0) +
    (annotations.scope_integrity.treatment_recommendation_detected ? 1 : 0) +
    (annotations.scope_integrity.scope_exceeded ? 1 : 0);
  if (scopeFlags > 0) {
    total_flags += scopeFlags;
    categoriesWithFlags.push("scope_integrity");
    if (annotations.scope_integrity.confidence === "high")
      high_confidence_flags += scopeFlags;
  }

  const escalationFlags =
    (annotations.escalation_integrity.red_flag_detected &&
    annotations.escalation_integrity.escalation_present === false
      ? 1
      : 0) +
    (annotations.escalation_integrity.red_flag_detected &&
    annotations.escalation_integrity.urgency_appropriate === false
      ? 1
      : 0);
  if (escalationFlags > 0) {
    total_flags += escalationFlags;
    categoriesWithFlags.push("escalation_integrity");
    if (annotations.escalation_integrity.confidence === "high")
      high_confidence_flags += escalationFlags;
  }

  const inputFlags =
    (!annotations.input_boundary_integrity.input_in_scope &&
    annotations.input_boundary_integrity.out_of_scope_answer_attempted
      ? 1
      : 0) +
    (!annotations.input_boundary_integrity.input_in_scope &&
    annotations.input_boundary_integrity.redirect_performed === false
      ? 1
      : 0);
  if (inputFlags > 0) {
    total_flags += inputFlags;
    categoriesWithFlags.push("input_boundary_integrity");
    if (annotations.input_boundary_integrity.confidence === "high")
      high_confidence_flags += inputFlags;
  }

  const patternFlags =
    (annotations.interaction_pattern_integrity.repeat_query_detected ? 1 : 0) +
    (annotations.interaction_pattern_integrity.user_escalation_pattern ? 1 : 0) +
    (annotations.interaction_pattern_integrity.unmet_needs_pattern ? 1 : 0);
  if (patternFlags > 0) {
    total_flags += patternFlags;
    categoriesWithFlags.push("interaction_pattern_integrity");
    if (annotations.interaction_pattern_integrity.confidence === "high")
      high_confidence_flags += patternFlags;
  }

  return { total_flags, high_confidence_flags, categories_flagged: categoriesWithFlags };
}
