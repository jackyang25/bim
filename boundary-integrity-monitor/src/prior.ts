import fs from "fs";
import { logger } from "./logger.js";
import type { VerdictStore } from "./verdict-store.js";
import type { FailureCategory } from "./types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BetaParams {
  alpha: number;  // pseudo-counts for confirmed_failure
  beta: number;   // pseudo-counts for false_alarm
}

export interface CategoryPriors {
  scope: BetaParams;
  escalation: BetaParams;
  input_boundary: BetaParams;
  interaction_pattern: BetaParams;
}

// ─── Interface ───────────────────────────────────────────────────────────────

export interface PriorSource {
  readonly name: string;
  getPriors(): CategoryPriors;
}

// ─── Uniform Prior ───────────────────────────────────────────────────────────
// Beta(1,1) = uniform distribution over [0,1]. Zero knowledge — no opinion on
// whether flags are real failures or false alarms. Posterior mean starts at 0.5
// and moves quickly with data.
//
// Use when: brand new domain, no historical data, no expert knowledge.

export class UniformPrior implements PriorSource {
  readonly name = "UniformPrior";

  getPriors(): CategoryPriors {
    const uniform: BetaParams = { alpha: 1, beta: 1 };
    return {
      scope: { ...uniform },
      escalation: { ...uniform },
      input_boundary: { ...uniform },
      interaction_pattern: { ...uniform },
    };
  }
}

// ─── Config Prior ────────────────────────────────────────────────────────────
// Loads per-category Beta parameters from a JSON file. Domain experts or
// operators set these based on knowledge of the domain.
//
// File format:
// {
//   "scope":               { "alpha": 6, "beta": 4 },
//   "escalation":          { "alpha": 8, "beta": 2 },
//   "input_boundary":      { "alpha": 3, "beta": 7 },
//   "interaction_pattern":  { "alpha": 2, "beta": 8 }
// }
//
// Use when: deploying to a known domain where experts can estimate
// confirmation rates. E.g., "scope violations are confirmed ~60% of the time"
// → alpha=6, beta=4 (prior mean = 0.6, effective sample size = 10).

export class ConfigPrior implements PriorSource {
  readonly name: string;
  private priors: CategoryPriors;

  constructor(filePath: string) {
    this.name = `ConfigPrior(${filePath})`;
    this.priors = this.load(filePath);
  }

  getPriors(): CategoryPriors {
    return this.priors;
  }

  private load(filePath: string): CategoryPriors {
    const fallback = new UniformPrior().getPriors();

    if (!fs.existsSync(filePath)) {
      logger.warn("config_prior_file_not_found", { filePath, fallback: "UniformPrior" });
      return fallback;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const categories: FailureCategory[] = ["scope", "escalation", "input_boundary", "interaction_pattern"];
      const result: CategoryPriors = { ...fallback };

      for (const cat of categories) {
        if (raw[cat] && typeof raw[cat].alpha === "number" && typeof raw[cat].beta === "number") {
          if (raw[cat].alpha > 0 && raw[cat].beta > 0) {
            result[cat] = { alpha: raw[cat].alpha, beta: raw[cat].beta };
          } else {
            logger.warn("config_prior_invalid_params", { category: cat, alpha: raw[cat].alpha, beta: raw[cat].beta });
          }
        }
      }

      logger.info("config_prior_loaded", {
        filePath,
        priors: result,
      });

      return result;
    } catch (err) {
      logger.error("config_prior_load_failed", { filePath, error: String(err), fallback: "UniformPrior" });
      return fallback;
    }
  }
}

// ─── Pooled Prior ────────────────────────────────────────────────────────────
// Computes priors from a shared verdict pool across deployment sites.
// The pool is read from a VerdictStore — in production this could be a
// remote store aggregating verdicts from all sites.
//
// The computed priors are the empirical counts from the pool, shifted by +1
// (adding a uniform pseudo-count so the prior is never degenerate).
//
// Use when: multi-site consortium where new deployments should inherit
// collective experience. A new site immediately gets meaningful scores
// based on what other sites have learned.

export class PooledPrior implements PriorSource {
  readonly name = "PooledPrior";
  private pool: VerdictStore;

  constructor(pool: VerdictStore) {
    this.pool = pool;
  }

  getPriors(): CategoryPriors {
    const verdicts = this.pool.getAll();
    const actionable = verdicts.filter((v) => v.verdict !== "uncertain");

    const categories: FailureCategory[] = ["scope", "escalation", "input_boundary", "interaction_pattern"];
    const result: CategoryPriors = {
      scope: { alpha: 1, beta: 1 },
      escalation: { alpha: 1, beta: 1 },
      input_boundary: { alpha: 1, beta: 1 },
      interaction_pattern: { alpha: 1, beta: 1 },
    };

    for (const cat of categories) {
      const catVerdicts = actionable.filter((v) => v.failure_category === cat);
      const confirmed = catVerdicts.filter((v) => v.verdict === "confirmed_failure").length;
      const falseAlarm = catVerdicts.length - confirmed;
      // Add 1 to each so the prior is never degenerate (Beta(0,n) or Beta(n,0))
      result[cat] = { alpha: confirmed + 1, beta: falseAlarm + 1 };
    }

    logger.info("pooled_prior_computed", {
      total_verdicts: actionable.length,
      priors: result,
    });

    return result;
  }
}
