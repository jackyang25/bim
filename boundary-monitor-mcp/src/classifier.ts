import { logger } from "./logger.js";
import type { PriorSource, CategoryPriors } from "./prior.js";
import type { VerdictStore } from "./verdict-store.js";
import type {
  Annotations,
  ClassifierOutput,
  FailureCategory,
  RiskScores,
  StoredVerdict,
} from "./types.js";

// ─── Interface ────────────────────────────────────────────────────────────────

export interface CategoryState {
  prior: { alpha: number; beta: number };
  local_verdicts: { confirmed: number; false_alarm: number };
  posterior: { alpha: number; beta: number; mean: number };
  effective_sample_size: number;
}

export interface ClassifierState {
  prior_source: string;
  categories: Record<FailureCategory, CategoryState>;
  total_actionable_verdicts: number;
  uncategorised_verdicts: number;
}

export interface ClassifierBackend {
  classify(annotations: Annotations): Promise<ClassifierOutput>;
  getState?(): ClassifierState;
}

// ─── Bayesian Classifier ──────────────────────────────────────────────────────
// Always active. Computes per-category P(confirmed_failure | flags active)
// using a Beta-Binomial conjugate model.
//
// Prior: supplied by a pluggable PriorSource
//   - UniformPrior  → Beta(1,1) per category (zero knowledge)
//   - ConfigPrior   → loaded from JSON (domain expert knowledge)
//   - PooledPrior   → computed from cross-site verdict pool
//
// Update: for each local verdict with failure_category == C:
//   confirmed_failure → α += 1
//   false_alarm       → β += 1
//   uncertain         → skipped
//
// Posterior mean: α / (α + β)
//
// Risk scores are always produced. For categories without active flags in the
// current annotations, the score is 0 (the annotator didn't flag it, so there's
// nothing to assess). For flagged categories, the posterior mean reflects how
// often flags in that category have historically been real failures.

export class BayesianClassifier implements ClassifierBackend {
  private store: VerdictStore;
  private priorSource: PriorSource;

  constructor(store: VerdictStore, priorSource: PriorSource) {
    this.store = store;
    this.priorSource = priorSource;
  }

  get backendName(): string {
    return `BayesianClassifier(${this.priorSource.name})`;
  }

  getState(): ClassifierState {
    const priors = this.priorSource.getPriors();
    const verdicts = this.store.getAll();
    const actionable = verdicts.filter((v) => v.verdict !== "uncertain");
    const buckets = this.bucketVerdicts(actionable);

    const allCategories: FailureCategory[] = ["scope", "escalation", "input_boundary", "interaction_pattern"];
    const categories = {} as Record<FailureCategory, CategoryState>;

    for (const cat of allCategories) {
      const prior = priors[cat];
      const bucket = buckets[cat];
      const alpha = prior.alpha + bucket.confirmed;
      const beta = prior.beta + bucket.falseAlarm;
      categories[cat] = {
        prior: { alpha: prior.alpha, beta: prior.beta },
        local_verdicts: { confirmed: bucket.confirmed, false_alarm: bucket.falseAlarm },
        posterior: {
          alpha,
          beta,
          mean: alpha / (alpha + beta),
        },
        effective_sample_size: alpha + beta,
      };
    }

    const categorised = allCategories.reduce((sum, cat) => sum + buckets[cat].confirmed + buckets[cat].falseAlarm, 0);

    return {
      prior_source: this.priorSource.name,
      categories,
      total_actionable_verdicts: actionable.length,
      uncategorised_verdicts: actionable.length - categorised,
    };
  }

  async classify(annotations: Annotations): Promise<ClassifierOutput> {
    const priors = this.priorSource.getPriors();
    const verdicts = this.store.getAll();
    const actionable = verdicts.filter((v) => v.verdict !== "uncertain");
    const risk_scores = this.computeRiskScores(annotations, actionable, priors);

    logger.info("classifier_bayesian", {
      prior_source: this.priorSource.name,
      local_verdicts: actionable.length,
      risk_scores,
    });

    return { annotations, risk_scores };
  }

  private computeRiskScores(
    annotations: Annotations,
    actionable: StoredVerdict[],
    priors: CategoryPriors
  ): RiskScores {
    // Bucket local verdicts by failure_category
    const buckets = this.bucketVerdicts(actionable);

    // Check which categories have active flags in current annotations
    const flagged = detectFlaggedCategories(annotations);

    const categories: Array<{ flag: keyof typeof flagged; cat: FailureCategory; score: keyof RiskScores }> = [
      { flag: "scope", cat: "scope", score: "scope_integrity" },
      { flag: "escalation", cat: "escalation", score: "escalation_integrity" },
      { flag: "input_boundary", cat: "input_boundary", score: "input_boundary_integrity" },
      { flag: "interaction_pattern", cat: "interaction_pattern", score: "interaction_pattern_integrity" },
    ];

    const scores: RiskScores = {
      scope_integrity: 0,
      escalation_integrity: 0,
      input_boundary_integrity: 0,
      interaction_pattern_integrity: 0,
    };

    for (const { flag, cat, score } of categories) {
      if (flagged[flag]) {
        const prior = priors[cat];
        const bucket = buckets[cat];
        const alpha = prior.alpha + bucket.confirmed;
        const beta = prior.beta + bucket.falseAlarm;
        scores[score] = alpha / (alpha + beta);
      }
    }

    return scores;
  }

  private bucketVerdicts(actionable: StoredVerdict[]): Record<FailureCategory, { confirmed: number; falseAlarm: number }> {
    const buckets: Record<FailureCategory, { confirmed: number; falseAlarm: number }> = {
      scope: { confirmed: 0, falseAlarm: 0 },
      escalation: { confirmed: 0, falseAlarm: 0 },
      input_boundary: { confirmed: 0, falseAlarm: 0 },
      interaction_pattern: { confirmed: 0, falseAlarm: 0 },
    };

    for (const v of actionable) {
      if (v.failure_category && buckets[v.failure_category]) {
        if (v.verdict === "confirmed_failure") {
          buckets[v.failure_category].confirmed++;
        } else {
          buckets[v.failure_category].falseAlarm++;
        }
      }
    }

    return buckets;
  }
}

// ─── Flag detection helpers ──────────────────────────────────────────────────

interface FlaggedCategories {
  scope: boolean;
  escalation: boolean;
  input_boundary: boolean;
  interaction_pattern: boolean;
}

function detectFlaggedCategories(annotations: Annotations): FlaggedCategories {
  const s = annotations.scope_integrity;
  const e = annotations.escalation_integrity;
  const i = annotations.input_boundary_integrity;
  const p = annotations.interaction_pattern_integrity;

  return {
    scope:
      s.diagnostic_language_detected ||
      s.treatment_recommendation_detected ||
      s.scope_exceeded,
    escalation:
      e.red_flag_detected && (e.escalation_present === false || e.urgency_appropriate === false),
    input_boundary:
      !i.input_in_scope && (i.out_of_scope_answer_attempted || i.redirect_performed === false),
    interaction_pattern:
      p.repeat_query_detected || p.user_escalation_pattern || p.unmet_needs_pattern,
  };
}
