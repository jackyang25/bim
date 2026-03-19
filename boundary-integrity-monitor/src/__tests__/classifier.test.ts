import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { BayesianClassifier } from "../classifier.js";
import { UniformPrior, ConfigPrior, PooledPrior } from "../prior.js";
import type { PriorSource, CategoryPriors } from "../prior.js";
import type { VerdictStore } from "../verdict-store.js";
import type {
  Annotations,
  StoredVerdict,
  SubmitReviewVerdictInput,
  SubmitReviewVerdictOutput,
  FailureCategory,
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

function flaggedScopeAnnotations(): Annotations {
  const a = cleanAnnotations();
  a.scope_integrity.diagnostic_language_detected = true;
  a.scope_integrity.evidence = "you have diabetes";
  return a;
}

function flaggedEscalationAnnotations(): Annotations {
  const a = cleanAnnotations();
  a.escalation_integrity.red_flag_detected = true;
  a.escalation_integrity.escalation_present = false;
  a.escalation_integrity.red_flags_found = ["chest pain"];
  return a;
}

function makeVerdict(
  verdict: "confirmed_failure" | "false_alarm",
  category?: FailureCategory
): StoredVerdict {
  return {
    session_id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    verdict,
    schema_version: "1.0",
    stored_at: new Date().toISOString(),
    ...(category !== undefined && { failure_category: category }),
  };
}

/** In-memory verdict store for testing */
class InMemoryVerdictStore implements VerdictStore {
  verdicts: StoredVerdict[] = [];

  getAll(): StoredVerdict[] {
    return this.verdicts;
  }

  async store(input: SubmitReviewVerdictInput): Promise<SubmitReviewVerdictOutput> {
    const entry: StoredVerdict = {
      session_id: input.session_id,
      timestamp: input.timestamp,
      verdict: input.verdict,
      schema_version: "1.0",
      stored_at: new Date().toISOString(),
    };
    this.verdicts.push(entry);
    return { stored: true, total_verdicts: this.verdicts.length, confirmation_rate: 0 };
  }
}

/** Custom prior for testing specific alpha/beta values */
class TestPrior implements PriorSource {
  readonly name = "TestPrior";
  private priors: CategoryPriors;

  constructor(priors: CategoryPriors) {
    this.priors = priors;
  }

  getPriors(): CategoryPriors {
    return this.priors;
  }
}

// ─── PriorSource implementations ────────────────────────────────────────────

describe("UniformPrior", () => {
  it("returns Beta(1,1) for all categories", () => {
    const prior = new UniformPrior();
    const priors = prior.getPriors();
    for (const cat of ["scope", "escalation", "input_boundary", "interaction_pattern"] as const) {
      assert.equal(priors[cat].alpha, 1);
      assert.equal(priors[cat].beta, 1);
    }
  });
});

describe("PooledPrior", () => {
  it("computes priors from pooled verdicts", () => {
    const pool = new InMemoryVerdictStore();
    // 6 confirmed, 4 false alarm for scope
    for (let i = 0; i < 6; i++) pool.verdicts.push(makeVerdict("confirmed_failure", "scope"));
    for (let i = 0; i < 4; i++) pool.verdicts.push(makeVerdict("false_alarm", "scope"));
    // 2 confirmed, 8 false alarm for escalation
    for (let i = 0; i < 2; i++) pool.verdicts.push(makeVerdict("confirmed_failure", "escalation"));
    for (let i = 0; i < 8; i++) pool.verdicts.push(makeVerdict("false_alarm", "escalation"));

    const prior = new PooledPrior(pool);
    const priors = prior.getPriors();

    // scope: 6+1=7 alpha, 4+1=5 beta
    assert.equal(priors.scope.alpha, 7);
    assert.equal(priors.scope.beta, 5);
    // escalation: 2+1=3 alpha, 8+1=9 beta
    assert.equal(priors.escalation.alpha, 3);
    assert.equal(priors.escalation.beta, 9);
    // categories with no data: 0+1=1 alpha, 0+1=1 beta (uniform)
    assert.equal(priors.input_boundary.alpha, 1);
    assert.equal(priors.input_boundary.beta, 1);
  });

  it("skips uncertain verdicts", () => {
    const pool = new InMemoryVerdictStore();
    pool.verdicts.push(makeVerdict("confirmed_failure", "scope"));
    pool.verdicts.push({ ...makeVerdict("confirmed_failure", "scope"), verdict: "uncertain" });

    const prior = new PooledPrior(pool);
    const priors = prior.getPriors();
    // Only 1 actionable verdict: 1+1=2 alpha, 0+1=1 beta
    assert.equal(priors.scope.alpha, 2);
    assert.equal(priors.scope.beta, 1);
  });
});

// ─── BayesianClassifier ──────────────────────────────────────────────────────

describe("BayesianClassifier — always active", () => {
  let store: InMemoryVerdictStore;

  beforeEach(() => {
    store = new InMemoryVerdictStore();
  });

  it("always produces risk_scores, even with zero verdicts", async () => {
    const classifier = new BayesianClassifier(store, new UniformPrior());
    const result = await classifier.classify(cleanAnnotations());
    assert.ok(result.risk_scores, "risk_scores should always be present");
  });

  it("scores unflagged categories at 0 regardless of prior", async () => {
    const prior = new TestPrior({
      scope: { alpha: 10, beta: 2 },
      escalation: { alpha: 10, beta: 2 },
      input_boundary: { alpha: 10, beta: 2 },
      interaction_pattern: { alpha: 10, beta: 2 },
    });
    const classifier = new BayesianClassifier(store, prior);

    const result = await classifier.classify(cleanAnnotations());
    assert.ok(result.risk_scores);
    assert.equal(result.risk_scores.scope_integrity, 0);
    assert.equal(result.risk_scores.escalation_integrity, 0);
    assert.equal(result.risk_scores.input_boundary_integrity, 0);
    assert.equal(result.risk_scores.interaction_pattern_integrity, 0);
  });

  it("with uniform prior and no verdicts, flagged category scores 0.5", async () => {
    const classifier = new BayesianClassifier(store, new UniformPrior());
    const result = await classifier.classify(flaggedScopeAnnotations());
    assert.ok(result.risk_scores);
    // Beta(1,1) + 0 data → 1/(1+1) = 0.5
    assert.equal(result.risk_scores.scope_integrity, 0.5);
  });

  it("with informative prior and no verdicts, reflects prior belief", async () => {
    // Domain expert says: "scope flags are confirmed ~80% of the time"
    const prior = new TestPrior({
      scope: { alpha: 8, beta: 2 },
      escalation: { alpha: 1, beta: 1 },
      input_boundary: { alpha: 1, beta: 1 },
      interaction_pattern: { alpha: 1, beta: 1 },
    });
    const classifier = new BayesianClassifier(store, prior);
    const result = await classifier.classify(flaggedScopeAnnotations());
    assert.ok(result.risk_scores);
    // Beta(8,2) → 8/10 = 0.8
    assert.equal(result.risk_scores.scope_integrity, 0.8);
  });

  it("local verdicts update the posterior from the prior", async () => {
    // Prior: Beta(8,2) → 0.8
    const prior = new TestPrior({
      scope: { alpha: 8, beta: 2 },
      escalation: { alpha: 1, beta: 1 },
      input_boundary: { alpha: 1, beta: 1 },
      interaction_pattern: { alpha: 1, beta: 1 },
    });
    const classifier = new BayesianClassifier(store, prior);

    // Add 10 local false alarms → prior gets pulled down
    for (let i = 0; i < 10; i++) {
      store.verdicts.push(makeVerdict("false_alarm", "scope"));
    }

    const result = await classifier.classify(flaggedScopeAnnotations());
    assert.ok(result.risk_scores);
    // Beta(8+0, 2+10) = Beta(8,12) → 8/20 = 0.4
    assert.equal(result.risk_scores.scope_integrity, 0.4);
  });

  it("prior washes out with enough local data", async () => {
    // Strong prior: Beta(100,100) → 0.5 (very confident at 50%)
    const prior = new TestPrior({
      scope: { alpha: 100, beta: 100 },
      escalation: { alpha: 1, beta: 1 },
      input_boundary: { alpha: 1, beta: 1 },
      interaction_pattern: { alpha: 1, beta: 1 },
    });
    const classifier = new BayesianClassifier(store, prior);

    // 1000 local confirmed failures → should overwhelm the prior
    for (let i = 0; i < 1000; i++) {
      store.verdicts.push(makeVerdict("confirmed_failure", "scope"));
    }

    const result = await classifier.classify(flaggedScopeAnnotations());
    assert.ok(result.risk_scores);
    // Beta(100+1000, 100+0) = Beta(1100, 100) → 1100/1200 ≈ 0.917
    const expected = 1100 / 1200;
    assert.ok(
      Math.abs(result.risk_scores.scope_integrity - expected) < 0.01,
      `should be ~${expected.toFixed(3)}, got ${result.risk_scores.scope_integrity}`
    );
  });
});

describe("BayesianClassifier — posterior math", () => {
  let store: InMemoryVerdictStore;

  beforeEach(() => {
    store = new InMemoryVerdictStore();
  });

  it("8 confirmed + 2 false alarm with uniform prior → 0.75", async () => {
    const classifier = new BayesianClassifier(store, new UniformPrior());
    for (let i = 0; i < 8; i++) store.verdicts.push(makeVerdict("confirmed_failure", "scope"));
    for (let i = 0; i < 2; i++) store.verdicts.push(makeVerdict("false_alarm", "scope"));

    const result = await classifier.classify(flaggedScopeAnnotations());
    assert.ok(result.risk_scores);
    // Beta(1+8, 1+2) = Beta(9,3) → 9/12 = 0.75
    assert.equal(Math.round(result.risk_scores.scope_integrity * 100) / 100, 0.75);
  });

  it("1 confirmed + 9 false alarm with uniform prior → low score", async () => {
    const classifier = new BayesianClassifier(store, new UniformPrior());
    store.verdicts.push(makeVerdict("confirmed_failure", "scope"));
    for (let i = 0; i < 9; i++) store.verdicts.push(makeVerdict("false_alarm", "scope"));

    const result = await classifier.classify(flaggedScopeAnnotations());
    assert.ok(result.risk_scores);
    // Beta(1+1, 1+9) = Beta(2,10) → 2/12 ≈ 0.167
    assert.ok(result.risk_scores.scope_integrity < 0.20);
  });

  it("skips uncertain verdicts in posterior calculation", async () => {
    const classifier = new BayesianClassifier(store, new UniformPrior());
    for (let i = 0; i < 8; i++) store.verdicts.push(makeVerdict("confirmed_failure", "scope"));
    for (let i = 0; i < 2; i++) store.verdicts.push(makeVerdict("false_alarm", "scope"));
    // These should be ignored
    for (let i = 0; i < 5; i++) {
      store.verdicts.push({ ...makeVerdict("confirmed_failure", "scope"), verdict: "uncertain" });
    }

    const result = await classifier.classify(flaggedScopeAnnotations());
    assert.ok(result.risk_scores);
    assert.equal(Math.round(result.risk_scores.scope_integrity * 100) / 100, 0.75);
  });

  it("multiple categories have independent posteriors", async () => {
    const classifier = new BayesianClassifier(store, new UniformPrior());
    // scope: 8 confirmed, 2 false alarm
    for (let i = 0; i < 8; i++) store.verdicts.push(makeVerdict("confirmed_failure", "scope"));
    for (let i = 0; i < 2; i++) store.verdicts.push(makeVerdict("false_alarm", "scope"));
    // escalation: 2 confirmed, 3 false alarm
    for (let i = 0; i < 2; i++) store.verdicts.push(makeVerdict("confirmed_failure", "escalation"));
    for (let i = 0; i < 3; i++) store.verdicts.push(makeVerdict("false_alarm", "escalation"));

    const annotations = cleanAnnotations();
    annotations.scope_integrity.diagnostic_language_detected = true;
    annotations.escalation_integrity.red_flag_detected = true;
    annotations.escalation_integrity.escalation_present = false;

    const result = await classifier.classify(annotations);
    assert.ok(result.risk_scores);

    // scope: Beta(1+8, 1+2) = 9/12 = 0.75
    assert.equal(Math.round(result.risk_scores.scope_integrity * 100) / 100, 0.75);
    // escalation: Beta(1+2, 1+3) = 3/7 ≈ 0.429
    const expectedEsc = 3 / 7;
    assert.ok(
      Math.abs(result.risk_scores.escalation_integrity - expectedEsc) < 0.01,
      `escalation should be ~${expectedEsc.toFixed(3)}`
    );
  });
});

describe("BayesianClassifier — pooled prior integration", () => {
  it("new site inherits pooled knowledge immediately", async () => {
    // Pooled data: scope has 60% confirmation rate across the consortium
    const pool = new InMemoryVerdictStore();
    for (let i = 0; i < 60; i++) pool.verdicts.push(makeVerdict("confirmed_failure", "scope"));
    for (let i = 0; i < 40; i++) pool.verdicts.push(makeVerdict("false_alarm", "scope"));

    const pooledPrior = new PooledPrior(pool);
    const localStore = new InMemoryVerdictStore(); // empty — brand new site
    const classifier = new BayesianClassifier(localStore, pooledPrior);

    const result = await classifier.classify(flaggedScopeAnnotations());
    assert.ok(result.risk_scores);

    // PooledPrior: alpha=60+1=61, beta=40+1=41 → 61/102 ≈ 0.598
    // No local data → posterior = prior
    const expected = 61 / 102;
    assert.ok(
      Math.abs(result.risk_scores.scope_integrity - expected) < 0.01,
      `should be ~${expected.toFixed(3)}, got ${result.risk_scores.scope_integrity}`
    );
  });

  it("local data shifts posterior away from pooled prior", async () => {
    const pool = new InMemoryVerdictStore();
    for (let i = 0; i < 60; i++) pool.verdicts.push(makeVerdict("confirmed_failure", "scope"));
    for (let i = 0; i < 40; i++) pool.verdicts.push(makeVerdict("false_alarm", "scope"));

    const pooledPrior = new PooledPrior(pool);
    const localStore = new InMemoryVerdictStore();
    const classifier = new BayesianClassifier(localStore, pooledPrior);

    // Local site sees 20 false alarms in a row — their annotator is noisy
    for (let i = 0; i < 20; i++) {
      localStore.verdicts.push(makeVerdict("false_alarm", "scope"));
    }

    const result = await classifier.classify(flaggedScopeAnnotations());
    assert.ok(result.risk_scores);

    // Prior: alpha=61, beta=41. Local: +0 confirmed, +20 false alarm
    // Posterior: Beta(61, 61) → 61/122 = 0.5 (pulled down from 0.598)
    const expected = 61 / 122;
    assert.ok(
      Math.abs(result.risk_scores.scope_integrity - expected) < 0.01,
      `should be ~${expected.toFixed(3)}, got ${result.risk_scores.scope_integrity}`
    );
  });
});
