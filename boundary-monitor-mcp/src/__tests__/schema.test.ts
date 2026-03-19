import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AnnotationsSchema } from "../annotator.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validAnnotations() {
  return {
    scope_integrity: {
      diagnostic_language_detected: false,
      treatment_recommendation_detected: false,
      scope_exceeded: false,
      confidence: "high",
      evidence: null as string | null,
    },
    escalation_integrity: {
      red_flag_detected: false,
      escalation_present: null as boolean | null,
      urgency_appropriate: null as boolean | null,
      red_flags_found: [] as string[],
      confidence: "low",
      evidence: null as string | null,
    },
    input_boundary_integrity: {
      input_in_scope: true,
      redirect_performed: null as boolean | null,
      out_of_scope_answer_attempted: false,
      confidence: "medium",
      evidence: null as string | null,
    },
    interaction_pattern_integrity: {
      repeat_query_detected: false,
      user_escalation_pattern: false,
      unmet_needs_pattern: false,
      confidence: null as "high" | "medium" | "low" | null,
      evidence: null as string | null,
    },
  };
}

// ─── Valid inputs ─────────────────────────────────────────────────────────────

describe("AnnotationsSchema — valid inputs", () => {
  it("accepts a fully valid annotation object", () => {
    assert.doesNotThrow(() => AnnotationsSchema.parse(validAnnotations()));
  });

  it("accepts string evidence values", () => {
    const a = validAnnotations();
    a.scope_integrity.evidence = "the agent said 'you have diabetes'";
    assert.doesNotThrow(() => AnnotationsSchema.parse(a));
  });

  it("accepts all three confidence levels: high/medium/low", () => {
    for (const conf of ["high", "medium", "low"] as const) {
      const a = validAnnotations();
      a.scope_integrity.confidence = conf;
      assert.doesNotThrow(() => AnnotationsSchema.parse(a));
    }
  });

  it("accepts boolean values for escalation_present and urgency_appropriate", () => {
    const a = validAnnotations();
    a.escalation_integrity.red_flag_detected = true;
    a.escalation_integrity.escalation_present = true;
    a.escalation_integrity.urgency_appropriate = false;
    a.escalation_integrity.red_flags_found = ["chest pain"];
    assert.doesNotThrow(() => AnnotationsSchema.parse(a));
  });

  it("accepts red_flags_found as a non-empty array", () => {
    const a = validAnnotations();
    a.escalation_integrity.red_flag_detected = true;
    a.escalation_integrity.red_flags_found = ["suicidal ideation", "self-harm"];
    assert.doesNotThrow(() => AnnotationsSchema.parse(a));
  });

  it("accepts interaction_pattern_integrity with confidence null when no history", () => {
    const a = validAnnotations();
    a.interaction_pattern_integrity.confidence = null;
    assert.doesNotThrow(() => AnnotationsSchema.parse(a));
  });

  it("accepts all three confidence levels for interaction_pattern_integrity", () => {
    for (const conf of ["high", "medium", "low"] as const) {
      const a = validAnnotations();
      a.interaction_pattern_integrity.confidence = conf;
      assert.doesNotThrow(() => AnnotationsSchema.parse(a));
    }
  });

  it("accepts extra fields via strip behaviour (Zod default)", () => {
    const a = { ...validAnnotations(), unknown_future_field: "ignored" };
    assert.doesNotThrow(() => AnnotationsSchema.parse(a));
  });
});

// ─── Invalid inputs ───────────────────────────────────────────────────────────

describe("AnnotationsSchema — invalid inputs", () => {
  it("rejects missing top-level category", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { scope_integrity, ...rest } = validAnnotations();
    assert.throws(() => AnnotationsSchema.parse(rest));
  });

  it("rejects invalid confidence value", () => {
    const a = validAnnotations() as Record<string, unknown>;
    (a["scope_integrity"] as Record<string, unknown>)["confidence"] = "very_high";
    assert.throws(() => AnnotationsSchema.parse(a));
  });

  it("rejects non-boolean for diagnostic_language_detected", () => {
    const a = validAnnotations() as Record<string, unknown>;
    (a["scope_integrity"] as Record<string, unknown>)["diagnostic_language_detected"] = "yes";
    assert.throws(() => AnnotationsSchema.parse(a));
  });

  it("rejects non-array for red_flags_found", () => {
    const a = validAnnotations() as Record<string, unknown>;
    (a["escalation_integrity"] as Record<string, unknown>)["red_flags_found"] = "chest pain";
    assert.throws(() => AnnotationsSchema.parse(a));
  });

  it("rejects a number where evidence should be string or null", () => {
    const a = validAnnotations() as Record<string, unknown>;
    (a["scope_integrity"] as Record<string, unknown>)["evidence"] = 42;
    assert.throws(() => AnnotationsSchema.parse(a));
  });

  it("rejects completely empty object", () => {
    assert.throws(() => AnnotationsSchema.parse({}));
  });

  it("rejects null for top-level categories", () => {
    const a = validAnnotations() as Record<string, unknown>;
    a["scope_integrity"] = null;
    assert.throws(() => AnnotationsSchema.parse(a));
  });
});

// ─── LLM output edge cases ────────────────────────────────────────────────────
// These guard against real-world LLM quirks we've observed.

describe("AnnotationsSchema — LLM output edge cases", () => {
  it("rejects an annotation that is a raw string (e.g., markdown fence not stripped)", () => {
    assert.throws(() => AnnotationsSchema.parse("```json\n{}\n```"));
  });

  it("rejects string booleans ('true' instead of true)", () => {
    const a = validAnnotations() as Record<string, unknown>;
    (a["scope_integrity"] as Record<string, unknown>)["diagnostic_language_detected"] = "true";
    assert.throws(() => AnnotationsSchema.parse(a));
  });

  it("accepts escalation_present: false explicitly (key flag for escalate_now routing)", () => {
    // This is the key boolean that triggers escalate_now routing.
    // Must parse as a valid boolean false, not get coerced to null.
    const a = validAnnotations();
    a.escalation_integrity.red_flag_detected = true;
    a.escalation_integrity.escalation_present = false;
    const parsed = AnnotationsSchema.parse(a);
    assert.equal(parsed.escalation_integrity.escalation_present, false);
    assert.notEqual(parsed.escalation_integrity.escalation_present, null);
  });

  it("accepts escalation_present: null when no red flag detected", () => {
    const a = validAnnotations();
    a.escalation_integrity.escalation_present = null;
    const parsed = AnnotationsSchema.parse(a);
    assert.equal(parsed.escalation_integrity.escalation_present, null);
  });
});
