# Architecture Notes — Boundary Integrity Monitor

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
  BayesianClassifier           ← always active, pluggable PriorSource
        │
        ▼
  router.ts                    ← probability threshold routing
                               ← routes by per-category risk scores vs τ thresholds
        │
        ▼
  routing decision + annotations + flags_summary + audit log
```

The three swappable interfaces are:
- `AnnotatorBackend` — what produces the structured annotation
- `ClassifierBackend` — Bayesian layer between annotation and routing
- `VerdictStore` — where human review verdicts are persisted

The pluggable `PriorSource` controls what the classifier believes before any local data exists:
- `UniformPrior` — Beta(1,1), zero knowledge (default)
- `ConfigPrior` — loaded from a JSON file (domain expert knowledge)
- `PooledPrior` — computed from a shared verdict pool (consortium deployments)

Everything downstream of the interfaces (routing thresholds, MCP schema, audit log, verdict feedback loop) is stable and does not change when backends change.

---

## Bayesian Classification

The `BayesianClassifier` is always active. It computes per-category P(confirmed_failure | flags active) using a Beta-Binomial conjugate model:

1. **Prior** — supplied by the configured `PriorSource` (per-category α₀, β₀)
2. **Update** — for each local verdict with a matching `failure_category`:
   - `confirmed_failure` → α += 1
   - `false_alarm` → β += 1
   - `uncertain` → skipped
3. **Posterior mean** — α / (α + β) = risk score for that category
4. **Unflagged categories** — risk score is 0 (annotator didn't flag it)

The prior gets washed out naturally as local verdicts accumulate. With a uniform prior Beta(1,1), ~50 verdicts are enough for local data to dominate. With an informative prior (e.g., from a consortium pool), new deployments get meaningful scores from the first request.

The `submit_review_verdict` tool creates the feedback loop. Every human verdict stored in `verdicts.json` updates the posterior on the next classification call.

---

## Prior Sources

### UniformPrior (default)
Beta(1,1) per category. No opinion on whether flags are real failures or false alarms. Posterior mean starts at 0.5 for any flagged category. Conservative: everything flagged goes to `human_review` initially. Self-calibrates as verdicts accumulate.

### ConfigPrior
Loads per-category Beta parameters from a JSON file. Domain experts set these based on knowledge of their deployment context. Example: "scope violations are confirmed ~70% of the time" → `{"scope": {"alpha": 7, "beta": 3}}`. The prior's effective sample size is α + β, so {7, 3} means "this is worth about 10 observations of confidence." It takes ~10 real verdicts to have equal weight to this prior.

### PooledPrior
Computes priors from a shared `VerdictStore` containing verdicts aggregated across deployment sites. New sites in a consortium immediately inherit collective experience. As a site accumulates local verdicts, its posterior naturally diverges from the pool if its population differs.

---

## Routing

The router compares per-category risk scores against calibrated thresholds:

| Threshold | Default | Triggers |
|---|---|---|
| `T_ESCALATE_SAFETY` | 0.70 | `escalate_now` (escalation_integrity only — lower because missed escalations are clinically dangerous) |
| `T_ESCALATE` | 0.85 | `escalate_now` (any other category) |
| `T_REVIEW` | 0.40 | `human_review` |
| `T_NOISE` | 0.10 | `log_only` |
| below all | — | `pass` |

Thresholds are configurable via environment variables and should be calibrated per deployment based on tolerance for false alarms vs. misses.

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
        ├──> AnthropicAnnotator (claude-sonnet-4-20250514, default)
        ├──> OllamaAnnotator (local open model, no API cost)
        ├──> Any OpenAI-compatible endpoint
        └──> Future: fine-tuned boundary classifier
```

Each backend implements the same contract. The routing layer never changes. The annotation schema never changes. The MCP interface never changes.

---

## Annotation Comparability Problem

The long-term value of the monitor depends on pooled labeled data across sites. Human reviewers submit verdicts on flagged interactions, and those labeled pairs become the training signal for the Bayesian classifier.

That pooling argument has a hidden assumption: **annotations must be comparable across sites.**

If Site A annotates with Claude Sonnet and Site B annotates with a locally hosted Llama variant, the flag distributions may differ in ways that aren't about the underlying interactions — they're about model calibration differences. A `diagnostic_language_detected: true` from one backend may not be the same signal as the same flag from another.

Two implications:

1. **The annotation schema is not enough.** A reference annotation model — or at minimum a reference prompt and evaluation set — needs to be distributed alongside the schema, so sites can assess how their local backend compares.

2. **Backend diversity is a data quality problem, not just a deployment problem.** The consortium structure needs a position on this before pooled data is used for inference. Options range from requiring a canonical backend (limits accessibility) to learning per-site calibration offsets (technically complex) to treating site as a covariate in the model (principled but requires sufficient data per site).

Neither implication blocks the current implementation. Both need to be resolved before pooled data is used for cross-site inference.

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
- The routing thresholds (`router.ts`) — stable
- The verdict store (`verdict-store.ts`) — stable
- The MCP interface (`index.ts`) — stable
- The Bayesian classification layer (`classifier.ts`) — stable
- The prior source interface (`prior.ts`) — stable
- The audit log (`audit-log.ts`) — stable
- The `schema_version` on all outputs — stable

The monitor's value is in the schema, the Bayesian feedback loop, and the routing logic. The annotation backend is infrastructure. It should be treated as such.
