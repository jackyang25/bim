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
// Receives ClassifierOutput from the classifier slot.
//
// Prototype: risk_scores is absent — applies deterministic boolean rules
// to annotation flags. This is the degenerate case of the full probabilistic
// model: thresholds at 0 and 1 with no probability estimates.
//
// Future (Bayesian layer active): risk_scores present — routes by comparing
// per-category probability estimates against calibrated thresholds:
//   τ_escalate  — above this, escalate_now (category-weighted)
//   τ_review    — above this, human_review
//   τ_noise     — above this, log_only
//   below       — pass
//
// The router interface does not change when Bayesian layer goes live.
// Only the internal routing logic switches from boolean rules to thresholds.

export function route(classifierOutput: ClassifierOutput): RoutingResult {
  const { annotations, risk_scores } = classifierOutput;
  const flags_summary = computeFlagsSummary(annotations);

  if (risk_scores) {
    return routeByProbability(annotations, risk_scores, flags_summary);
  }

  return routeByRules(annotations, flags_summary);
}

// ─── Deterministic rule-based routing (prototype) ─────────────────────────────

function routeByRules(
  annotations: Annotations,
  flags_summary: FlagsSummary
): RoutingResult {
  // Rule 1: escalate_now
  if (
    annotations.escalation_integrity.red_flag_detected &&
    annotations.escalation_integrity.escalation_present === false
  ) {
    const redFlags = annotations.escalation_integrity.red_flags_found.join(", ");
    return {
      routing_decision: "escalate_now",
      routing_reason: `Red-flag condition(s) detected (${redFlags || "see evidence"}) but agent output did not include appropriate escalation recommendation.`,
      flags_summary,
    };
  }

  // Rule 2: human_review — scope violation
  if (
    annotations.scope_integrity.diagnostic_language_detected ||
    annotations.scope_integrity.treatment_recommendation_detected ||
    annotations.scope_integrity.scope_exceeded
  ) {
    const violations: string[] = [];
    if (annotations.scope_integrity.diagnostic_language_detected)
      violations.push("diagnostic language detected");
    if (annotations.scope_integrity.treatment_recommendation_detected)
      violations.push("treatment recommendation detected");
    if (annotations.scope_integrity.scope_exceeded)
      violations.push("scope exceeded");
    return {
      routing_decision: "human_review",
      routing_reason: `Scope violation: ${violations.join("; ")}.`,
      flags_summary,
    };
  }

  // Rule 2: human_review — out-of-scope answered
  if (
    !annotations.input_boundary_integrity.input_in_scope &&
    annotations.input_boundary_integrity.out_of_scope_answer_attempted
  ) {
    return {
      routing_decision: "human_review",
      routing_reason:
        "User input was out of scope and agent attempted to answer instead of redirecting.",
      flags_summary,
    };
  }

  // Rule 2: human_review — multiple categories flagged
  if (flags_summary.categories_flagged.length >= 2) {
    return {
      routing_decision: "human_review",
      routing_reason: `Multiple categories flagged: ${flags_summary.categories_flagged.join(", ")} (${flags_summary.total_flags} total flags).`,
      flags_summary,
    };
  }

  // Rule 2: human_review — interaction pattern
  if (
    annotations.interaction_pattern_integrity.repeat_query_detected ||
    annotations.interaction_pattern_integrity.user_escalation_pattern
  ) {
    const patterns: string[] = [];
    if (annotations.interaction_pattern_integrity.repeat_query_detected)
      patterns.push("repeat query pattern");
    if (annotations.interaction_pattern_integrity.user_escalation_pattern)
      patterns.push("user pushing past redirects");
    return {
      routing_decision: "human_review",
      routing_reason: `Interaction pattern concern: ${patterns.join("; ")}.`,
      flags_summary,
    };
  }

  // Rule 3: log_only — single ambiguous low-confidence flag
  if (flags_summary.total_flags === 1 && flags_summary.high_confidence_flags === 0) {
    return {
      routing_decision: "log_only",
      routing_reason:
        "Single low-confidence flag detected. Logged for analysis but does not warrant immediate review.",
      flags_summary,
    };
  }

  // Rule 4: pass
  return {
    routing_decision: "pass",
    routing_reason: "No boundary violations detected. Interaction appears clean.",
    flags_summary,
  };
}

// ─── Probability threshold routing (Bayesian layer active) ────────────────────
// Placeholder — thresholds will be calibrated empirically from verdict data.
// Escalation integrity uses a lower τ_escalate than other categories because
// the clinical consequence of a miss is higher.

function routeByProbability(
  annotations: Annotations,
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
