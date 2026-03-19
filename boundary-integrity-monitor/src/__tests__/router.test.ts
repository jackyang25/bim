import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { route } from "../router.js";
import type {
  Annotations,
  ClassifierOutput,
  RiskScores,
} from "../types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cleanAnnotations(): Annotations {
  return {
    scope_integrity: {
      diagnostic_language_detected: false,
      treatment_recommendation_detected: false,
      scope_exceeded: false,
      confidence: "high",
      evidence: null,
    },
    escalation_integrity: {
      red_flag_detected: false,
      escalation_present: null,
      urgency_appropriate: null,
      red_flags_found: [],
      confidence: "high",
      evidence: null,
    },
    input_boundary_integrity: {
      input_in_scope: true,
      redirect_performed: null,
      out_of_scope_answer_attempted: false,
      confidence: "high",
      evidence: null,
    },
    interaction_pattern_integrity: {
      repeat_query_detected: false,
      user_escalation_pattern: false,
      unmet_needs_pattern: false,
      confidence: null,
      evidence: null,
    },
  };
}

const zeroScores: RiskScores = {
  scope_integrity: 0,
  escalation_integrity: 0,
  input_boundary_integrity: 0,
  interaction_pattern_integrity: 0,
};

function output(overrides?: Partial<RiskScores>): ClassifierOutput {
  return {
    annotations: cleanAnnotations(),
    risk_scores: { ...zeroScores, ...overrides },
  };
}

// ─── Probability threshold routing ──────────────────────────────────────────

describe("route() — probability thresholds", () => {
  it("throws when risk_scores is missing", () => {
    assert.throws(
      () => route({ annotations: cleanAnnotations() }),
      /risk_scores is required/
    );
  });

  it("pass when all scores are zero", () => {
    const result = route(output());
    assert.equal(result.routing_decision, "pass");
    assert.equal(result.flags_summary.total_flags, 0);
  });

  it("escalate_now when escalation_integrity exceeds T_ESCALATE_SAFETY (0.70)", () => {
    const result = route(output({ escalation_integrity: 0.75 }));
    assert.equal(result.routing_decision, "escalate_now");
    assert.match(result.routing_reason, /safety threshold/);
  });

  it("escalate_now when any category exceeds T_ESCALATE (0.85)", () => {
    const result = route(output({ scope_integrity: 0.90 }));
    assert.equal(result.routing_decision, "escalate_now");
    assert.match(result.routing_reason, /escalation threshold/);
  });

  it("human_review when max score is between T_REVIEW (0.40) and T_ESCALATE (0.85)", () => {
    const result = route(output({ scope_integrity: 0.55 }));
    assert.equal(result.routing_decision, "human_review");
    assert.match(result.routing_reason, /review threshold/);
  });

  it("human_review when escalation_integrity is between T_REVIEW and T_ESCALATE_SAFETY", () => {
    const result = route(output({ escalation_integrity: 0.50 }));
    assert.equal(result.routing_decision, "human_review");
  });

  it("log_only when max score is between T_NOISE (0.10) and T_REVIEW (0.40)", () => {
    const result = route(output({ scope_integrity: 0.25 }));
    assert.equal(result.routing_decision, "log_only");
    assert.match(result.routing_reason, /noise floor/);
  });

  it("log_only when escalation_integrity is between T_NOISE and T_REVIEW", () => {
    const result = route(output({ escalation_integrity: 0.15 }));
    assert.equal(result.routing_decision, "log_only");
  });

  it("pass when all scores below T_NOISE (0.10)", () => {
    const result = route(output({ scope_integrity: 0.05 }));
    assert.equal(result.routing_decision, "pass");
    assert.match(result.routing_reason, /noise floor/);
  });

  it("escalation_integrity at exactly T_ESCALATE_SAFETY triggers escalate_now", () => {
    const result = route(output({ escalation_integrity: 0.70 }));
    assert.equal(result.routing_decision, "escalate_now");
  });

  it("routing reason includes the dominant category", () => {
    const result = route(output({ input_boundary_integrity: 0.55 }));
    assert.equal(result.routing_decision, "human_review");
    assert.match(result.routing_reason, /input_boundary_integrity/);
  });
});

// ─── flags_summary accuracy ─────────────────────────────────────────────────

describe("flags_summary", () => {
  it("counts high_confidence_flags correctly", () => {
    const annotations = cleanAnnotations();
    annotations.scope_integrity.diagnostic_language_detected = true;
    annotations.scope_integrity.treatment_recommendation_detected = true;
    annotations.scope_integrity.confidence = "high";

    const result = route({
      annotations,
      risk_scores: { ...zeroScores, scope_integrity: 0.75 },
    });
    assert.equal(result.flags_summary.total_flags, 2);
    assert.equal(result.flags_summary.high_confidence_flags, 2);
    assert.ok(result.flags_summary.categories_flagged.includes("scope_integrity"));
  });

  it("does not count high_confidence when confidence is low", () => {
    const annotations = cleanAnnotations();
    annotations.scope_integrity.diagnostic_language_detected = true;
    annotations.scope_integrity.confidence = "low";

    const result = route({
      annotations,
      risk_scores: { ...zeroScores, scope_integrity: 0.55 },
    });
    assert.equal(result.flags_summary.total_flags, 1);
    assert.equal(result.flags_summary.high_confidence_flags, 0);
  });

  it("counts flags across multiple categories", () => {
    const annotations = cleanAnnotations();
    annotations.scope_integrity.scope_exceeded = true;
    annotations.escalation_integrity.red_flag_detected = true;
    annotations.escalation_integrity.escalation_present = false;

    const result = route({
      annotations,
      risk_scores: { ...zeroScores, scope_integrity: 0.5, escalation_integrity: 0.5 },
    });
    assert.equal(result.flags_summary.categories_flagged.length, 2);
    assert.ok(result.flags_summary.categories_flagged.includes("scope_integrity"));
    assert.ok(result.flags_summary.categories_flagged.includes("escalation_integrity"));
  });
});
