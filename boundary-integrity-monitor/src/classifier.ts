import type { Annotations, ClassifierOutput } from "./types.js";

// ─── Interface ────────────────────────────────────────────────────────────────
// The Bayesian classification slot.
//
// Sits between annotator.ts and router.ts. In the prototype, the passthrough
// implementation returns annotations unchanged with no risk_scores.
//
// When labeled verdict data accumulates, a BayesianClassifier implements this
// interface and produces per-category P(confirmed_failure) estimates.
// The router receives ClassifierOutput and uses risk_scores when present,
// falling back to boolean flag rules when absent.
//
// Nothing outside this file needs to change when the Bayesian layer goes live.

export interface ClassifierBackend {
  classify(annotations: Annotations): Promise<ClassifierOutput>;
}

// ─── Passthrough Implementation ───────────────────────────────────────────────
// Active in the prototype. Forwards annotations unchanged.
// risk_scores is absent — the router applies deterministic boolean rules.

export class PassthroughClassifier implements ClassifierBackend {
  async classify(annotations: Annotations): Promise<ClassifierOutput> {
    return { annotations };
  }
}
