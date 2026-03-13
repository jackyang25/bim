import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { route } from "../router.js";
import type {
  Annotations,
  ClassifierOutput,
  EscalationIntegrity,
  InputBoundaryIntegrity,
  InteractionPatternIntegrity,
  ScopeIntegrity,
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

function withScope(overrides: Partial<ScopeIntegrity>): ClassifierOutput {
  return {
    annotations: {
      ...cleanAnnotations(),
      scope_integrity: { ...cleanAnnotations().scope_integrity, ...overrides },
    },
  };
}

function withEscalation(overrides: Partial<EscalationIntegrity>): ClassifierOutput {
  return {
    annotations: {
      ...cleanAnnotations(),
      escalation_integrity: { ...cleanAnnotations().escalation_integrity, ...overrides },
    },
  };
}

function withInput(overrides: Partial<InputBoundaryIntegrity>): ClassifierOutput {
  return {
    annotations: {
      ...cleanAnnotations(),
      input_boundary_integrity: { ...cleanAnnotations().input_boundary_integrity, ...overrides },
    },
  };
}

function withPattern(overrides: Partial<InteractionPatternIntegrity>): ClassifierOutput {
  return {
    annotations: {
      ...cleanAnnotations(),
      interaction_pattern_integrity: {
        ...cleanAnnotations().interaction_pattern_integrity,
        ...overrides,
      },
    },
  };
}

// ─── Boolean rule-based routing ───────────────────────────────────────────────

describe("route() — boolean rules (no risk_scores)", () => {
  it("returns pass when all annotations are clean", () => {
    const result = route({ annotations: cleanAnnotations() });
    assert.equal(result.routing_decision, "pass");
    assert.equal(result.flags_summary.total_flags, 0);
  });

  it("escalate_now when red_flag_detected and escalation_present is false", () => {
    const result = route(withEscalation({
      red_flag_detected: true,
      escalation_present: false,
      red_flags_found: ["suicidal ideation"],
      evidence: "user said they want to end their life",
    }));
    assert.equal(result.routing_decision, "escalate_now");
    assert.match(result.routing_reason, /suicidal ideation/);
  });

  it("does NOT escalate_now when red_flag_detected but escalation_present is true", () => {
    const result = route(withEscalation({
      red_flag_detected: true,
      escalation_present: true,
      urgency_appropriate: true,
      red_flags_found: ["chest pain"],
      evidence: "chest pain",
    }));
    assert.notEqual(result.routing_decision, "escalate_now");
  });

  it("human_review when diagnostic language detected", () => {
    const result = route(withScope({
      diagnostic_language_detected: true,
      evidence: "you have diabetes",
    }));
    assert.equal(result.routing_decision, "human_review");
    assert.match(result.routing_reason, /diagnostic language/);
  });

  it("human_review when treatment recommendation detected", () => {
    const result = route(withScope({
      treatment_recommendation_detected: true,
      evidence: "take 500mg metformin",
    }));
    assert.equal(result.routing_decision, "human_review");
    assert.match(result.routing_reason, /treatment recommendation/);
  });

  it("human_review when out-of-scope input answered instead of redirected", () => {
    const result = route(withInput({
      input_in_scope: false,
      redirect_performed: false,
      out_of_scope_answer_attempted: true,
      evidence: "asked about medication dosage",
    }));
    assert.equal(result.routing_decision, "human_review");
    assert.match(result.routing_reason, /out of scope/i);
  });

  it("human_review when repeat query pattern detected", () => {
    const result = route(withPattern({
      repeat_query_detected: true,
      confidence: "medium",
      evidence: "same question rephrased 3 times",
    }));
    assert.equal(result.routing_decision, "human_review");
    assert.match(result.routing_reason, /repeat query/);
  });

  it("human_review when multiple categories flagged (no individual rule firing first)", () => {
    // Use escalation with urgency_appropriate===false (counts as a flag but does NOT trigger
    // escalate_now, which only fires on escalation_present===false) combined with
    // unmet_needs_pattern (counts as a flag but does NOT trigger the pattern rule, which only
    // fires on repeat_query or user_escalation_pattern). Together: 2 categories → multiple rule.
    const base = cleanAnnotations();
    const result = route({
      annotations: {
        ...base,
        escalation_integrity: {
          ...base.escalation_integrity,
          red_flag_detected: true,
          escalation_present: true,   // present — so escalate_now does NOT fire
          urgency_appropriate: false,  // wrong urgency — still a flag
          red_flags_found: ["chest pain"],
          evidence: "urgency under-estimated",
        },
        interaction_pattern_integrity: {
          ...base.interaction_pattern_integrity,
          unmet_needs_pattern: true,   // pattern flag that doesn't trigger pattern rule alone
          confidence: "medium",
          evidence: "user seems stuck",
        },
      },
    });
    assert.equal(result.routing_decision, "human_review");
    assert.match(result.routing_reason, /categories flagged/i);
    assert.equal(result.flags_summary.categories_flagged.length, 2);
  });

  it("log_only for single low-confidence flag (unmet_needs_pattern only)", () => {
    // unmet_needs_pattern creates 1 flag but doesn't trigger the interaction_pattern
    // human_review rule (only repeat_query / user_escalation_pattern do).
    const result = route(withPattern({
      unmet_needs_pattern: true,
      confidence: "low",
      evidence: "ambiguous trajectory",
    }));
    assert.equal(result.routing_decision, "log_only");
    assert.equal(result.flags_summary.total_flags, 1);
    assert.equal(result.flags_summary.high_confidence_flags, 0);
  });
});

// ─── Probability threshold routing (Bayesian layer) ───────────────────────────

describe("route() — probability thresholds (risk_scores present)", () => {
  const baseRiskScores = {
    scope_integrity: 0.0,
    escalation_integrity: 0.0,
    input_boundary_integrity: 0.0,
    interaction_pattern_integrity: 0.0,
  };

  it("escalate_now when escalation_integrity exceeds T_ESCALATE_SAFETY (0.70)", () => {
    const result = route({
      annotations: cleanAnnotations(),
      risk_scores: { ...baseRiskScores, escalation_integrity: 0.75 },
    });
    assert.equal(result.routing_decision, "escalate_now");
    assert.match(result.routing_reason, /safety threshold/);
  });

  it("escalate_now when any category exceeds T_ESCALATE (0.85)", () => {
    const result = route({
      annotations: cleanAnnotations(),
      risk_scores: { ...baseRiskScores, scope_integrity: 0.90 },
    });
    assert.equal(result.routing_decision, "escalate_now");
    assert.match(result.routing_reason, /escalation threshold/);
  });

  it("human_review when max score is between T_REVIEW (0.40) and T_ESCALATE (0.85)", () => {
    const result = route({
      annotations: cleanAnnotations(),
      risk_scores: { ...baseRiskScores, scope_integrity: 0.55 },
    });
    assert.equal(result.routing_decision, "human_review");
    assert.match(result.routing_reason, /review threshold/);
  });

  it("log_only when max score is between T_NOISE (0.10) and T_REVIEW (0.40)", () => {
    const result = route({
      annotations: cleanAnnotations(),
      risk_scores: { ...baseRiskScores, scope_integrity: 0.25 },
    });
    assert.equal(result.routing_decision, "log_only");
    assert.match(result.routing_reason, /noise floor/);
  });

  it("pass when all scores below T_NOISE (0.10)", () => {
    const result = route({
      annotations: cleanAnnotations(),
      risk_scores: { ...baseRiskScores, scope_integrity: 0.05 },
    });
    assert.equal(result.routing_decision, "pass");
    assert.match(result.routing_reason, /noise floor/);
  });
});

// ─── flags_summary accuracy ───────────────────────────────────────────────────

describe("flags_summary", () => {
  it("counts high_confidence_flags correctly", () => {
    const result = route(withScope({
      diagnostic_language_detected: true,
      treatment_recommendation_detected: true,
      confidence: "high",
      evidence: "two flags, high confidence",
    }));
    assert.equal(result.flags_summary.total_flags, 2);
    assert.equal(result.flags_summary.high_confidence_flags, 2);
    assert.ok(result.flags_summary.categories_flagged.includes("scope_integrity"));
  });

  it("does not count high_confidence when confidence is low", () => {
    const result = route(withScope({
      diagnostic_language_detected: true,
      confidence: "low",
      evidence: "ambiguous",
    }));
    assert.equal(result.flags_summary.total_flags, 1);
    assert.equal(result.flags_summary.high_confidence_flags, 0);
  });
});
