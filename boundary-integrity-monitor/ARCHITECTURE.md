# Architecture Notes — Boundary Integrity Monitor

## Current State (Prototype)

The annotation layer calls a Claude model at temperature 0. The model is configurable via `ANNOTATION_MODEL` environment variable (default: `claude-haiku-4-5`). All tunable values — model, timeout, retries, input limits, routing thresholds — are externalised to environment variables via `config.ts`. No values are hardcoded.

The annotation backend is abstracted behind a TypeScript interface (`AnnotatorBackend` in `annotator.ts`). The default implementation is `AnthropicAnnotator`. The wiring point is the top of `index.ts` — swapping backends is a one-line change.

---

## Pipeline

```
check_boundary_integrity (MCP tool)
        │
        ▼
  annotator.ts                 ← AnnotatorBackend interface
  AnthropicAnnotator           ← default implementation
        │
        ▼
  classifier.ts                ← ClassifierBackend interface
  PassthroughClassifier        ← Bayesian slot (currently inactive)
        │
        ▼
  router.ts                    ← deterministic boolean rules (prototype)
                               ← probability threshold routing (Bayesian layer)
        │
        ▼
  routing decision + annotations + flags_summary
```

The three swappable interfaces are:
- `AnnotatorBackend` — what produces the structured annotation
- `ClassifierBackend` — the slot between annotation and routing (inactive)
- `VerdictStore` — where human review verdicts are persisted

Everything downstream of the interfaces (routing rules, MCP schema, audit log, verdict feedback loop) is stable and does not change when backends change.

---

## Known Architectural Constraint: Annotation Backend Dependency

The monitor is designed for open-source distribution to clinical AI teams across diverse deployment contexts, including LMIC settings where connectivity, infrastructure, and operational budgets vary significantly.

The default dependency on Anthropic's commercial API is a barrier to this distribution model in two ways:

**Cost.** Every interaction check is a paid API call. At any meaningful monitoring volume — across a ward, a clinic, a health system — this accumulates. For teams in resource-constrained settings, this is not a rounding error. It may be a deployment blocker.

**Connectivity.** The annotation call requires a live HTTPS connection to Anthropic's API. Air-gapped environments, low-bandwidth settings, or deployments with strict data residency requirements cannot use this as built.

The `AnnotatorBackend` interface exists specifically to make this swappable. The target:

```
check_boundary_integrity
        │
        ▼
[ AnnotatorBackend interface ]
        │
        ├──> AnthropicAnnotator (claude-haiku-4-5, default)
        ├──> OllamaAnnotator (local open model, no API cost)
        ├──> Any OpenAI-compatible endpoint
        └──> Future: fine-tuned boundary classifier
```

Each backend implements the same contract. The routing layer never changes. The annotation schema never changes. The MCP interface never changes.

---

## Bayesian Classification Slot

The `ClassifierBackend` interface and `PassthroughClassifier` implementation sit between `annotator.ts` and `router.ts`. Currently the passthrough returns annotations unchanged, and the router uses deterministic boolean rules.

When sufficient verdict data accumulates, a real Bayesian classifier slots in here. It takes annotations as input and produces per-category `risk_scores` — P(confirmed_failure) estimates for each of the four annotation categories. The router already has the probability threshold routing branch implemented and tested; it activates automatically when `risk_scores` is present in the classifier output.

Routing thresholds (`T_ESCALATE_SAFETY`, `T_ESCALATE`, `T_REVIEW`, `T_NOISE`) are already externalised to environment variables and will be calibrated empirically from verdict data. `escalation_integrity` uses a lower `T_ESCALATE_SAFETY` threshold (0.70 vs 0.85) because the clinical consequence of a missed escalation is higher than a scope violation.

The `submit_review_verdict` tool creates the feedback loop. Every human verdict (`confirmed_failure` / `false_alarm` / `uncertain`) stored in `verdicts.json` is future training signal. The Bayesian layer doesn't need large amounts of data to outperform the deterministic rules — it just needs some.

---

## Annotation Comparability Problem

The long-term value of the monitor depends on pooled labeled data across sites. Human reviewers submit verdicts on flagged interactions, and those labeled pairs become the training signal for the Bayesian classifier.

That pooling argument has a hidden assumption: **annotations must be comparable across sites.**

If Site A annotates with Claude Sonnet and Site B annotates with a locally hosted Llama variant, the flag distributions may differ in ways that aren't about the underlying interactions — they're about model calibration differences. A `diagnostic_language_detected: true` from one backend may not be the same signal as the same flag from another.

Two implications:

1. **The annotation schema is not enough.** A reference annotation model — or at minimum a reference prompt and evaluation set — needs to be distributed alongside the schema, so sites can assess how their local backend compares.

2. **Backend diversity is a data quality problem, not just a deployment problem.** The consortium structure needs a position on this before the Bayesian layer goes live. Options range from requiring a canonical backend (limits accessibility) to learning per-site calibration offsets (technically complex) to treating site as a covariate in the model (principled but requires sufficient data per site).

Neither implication blocks the prototype. Both need to be resolved before pooled data is used for inference.

---

## Reference Evaluation Set

`evaluations/reference-set.json` contains 8 canonical interactions with ground-truth routing decisions:

- **ref-001, ref-002** — `escalate_now`: chest pain not escalated, suicidal ideation not escalated
- **ref-003, ref-004** — `human_review`: diagnostic language, medication recommendation
- **ref-005, ref-006** — `human_review`: out-of-scope answered, repeat query pattern
- **ref-007, ref-008** — `pass`: clean wellness interaction, appropriate redirect

Any annotation backend — commercial or local — must pass this set before its output is admitted to the shared data library. This is the quality gate that keeps verdict data comparable across deployment sites.

Run with: `npm run eval`

---

## Fail-Safe Design

Any annotation failure (timeout, API error, malformed response) defaults to `routing_decision: "human_review"` with `routing_reason: "annotation_service_unavailable"`. This is intentional.

A silent `pass` on annotation failure would be clinically dangerous — it would let boundary violations through without review. It would also corrupt the verdict store: false-alarm verdicts would accumulate on interactions that were never actually reviewed, poisoning the training signal for the Bayesian layer.

Fail safe. Never fail silent.

---

## Audit Trail

Every `check_boundary_integrity` call appends one JSON object to `audit.ndjson` (configurable via `AUDIT_LOG_PATH`):

```json
{"ts":"...","schema_version":"1.0","session_id":"...","routing_decision":"human_review","total_flags":2,"high_confidence_flags":2,"categories_flagged":["escalation_integrity"],"annotation_latency_ms":1842}
```

This log is append-only and separate from the verdict store. It records every check, not just flagged ones. It's the authoritative record of what the monitor saw, regardless of whether a human ever reviews it.

---

## What Is Not Changing

The abstraction question affects only `annotator.ts`. Everything downstream is stable:

- The annotation schema (`Annotations` type) — stable
- The routing rules (`router.ts`) — stable
- The verdict store (`verdict-store.ts`) — stable
- The MCP interface (`index.ts`) — stable
- The Bayesian classification slot (`classifier.ts`) — stable
- The audit log (`audit-log.ts`) — stable
- The `schema_version` on all outputs — stable

The monitor's value is in the schema, the routing logic, and the feedback loop. The annotation backend is infrastructure. It should be treated as such.
