/**
 * Reference Evaluation Runner
 *
 * Runs the canonical reference set through the full pipeline and checks
 * each case against its expected routing decision.
 *
 * Purpose: validate any annotation backend before its outputs are admitted
 * to the shared data library. A backend that cannot pass this set is not
 * producing comparable annotations.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npm run eval
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { AnthropicAnnotator } from "./annotator.js";
import type { AnnotatorBackend } from "./annotator.js";
import { PassthroughClassifier } from "./classifier.js";
import { route } from "./router.js";
import type { BoundarySpec, HistoryExchange, RoutingDecision } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── ANSI colours ─────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
};

// ─── Reference set types ──────────────────────────────────────────────────────

interface ReferenceCase {
  id: string;
  label: string;
  category: string;
  user_input: string;
  agent_output: string;
  session_history: HistoryExchange[] | null;
  expected_routing_decision: RoutingDecision;
  rationale: string;
}

interface ReferenceSet {
  version: string;
  description: string;
  default_boundary_spec: BoundarySpec;
  cases: ReferenceCase[];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      `${C.red}Error: ANTHROPIC_API_KEY is not set.${C.reset}`
    );
    process.exit(1);
  }

  const refPath = join(__dirname, "..", "evaluations", "reference-set.json");
  const refSet = JSON.parse(readFileSync(refPath, "utf-8")) as ReferenceSet;

  const annotator: AnnotatorBackend = new AnthropicAnnotator();
  const classifier = new PassthroughClassifier();

  console.log("\n" + "═".repeat(64));
  console.log(` ${C.bold}Boundary Integrity Monitor — Reference Evaluation${C.reset}`);
  console.log(` ${C.dim}${refSet.cases.length} cases  |  backend: AnthropicAnnotator${C.reset}`);
  console.log("═".repeat(64));

  const results: { id: string; expected: RoutingDecision; actual: RoutingDecision; pass: boolean }[] = [];

  for (const c of refSet.cases) {
    process.stdout.write(` ${C.dim}Running ${c.id}…${C.reset}`);

    try {
      const annotations = await annotator.annotate(
        c.user_input,
        c.agent_output,
        refSet.default_boundary_spec,
        c.session_history ?? undefined
      );

      const classifierOutput = await classifier.classify(annotations);
      const { routing_decision } = route(classifierOutput);
      const pass = routing_decision === c.expected_routing_decision;

      results.push({ id: c.id, expected: c.expected_routing_decision, actual: routing_decision, pass });

      const marker = pass ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
      const actualColour = pass ? C.green : C.red;

      process.stdout.write(
        `\r ${marker} ${C.bold}${c.id}${C.reset}  ${C.dim}${c.label}${C.reset}\n` +
        `   Expected: ${C.cyan}${c.expected_routing_decision}${C.reset}   ` +
        `Got: ${actualColour}${routing_decision}${C.reset}` +
        (pass ? "" : `\n   ${C.dim}Rationale: ${c.rationale}${C.reset}`) +
        "\n"
      );
    } catch (err) {
      results.push({ id: c.id, expected: c.expected_routing_decision, actual: "pass", pass: false });
      process.stdout.write(
        `\r ${C.red}✗${C.reset} ${C.bold}${c.id}${C.reset}  ERROR: ${(err as Error).message}\n`
      );
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const pct = Math.round((passed / results.length) * 100);

  console.log("─".repeat(64));
  console.log(
    ` ${C.bold}Result: ${passed}/${results.length} passed (${pct}%)${C.reset}`
  );

  if (failed > 0) {
    console.log(` ${C.red}${failed} case(s) failed:${C.reset}`);
    for (const r of results.filter((r) => !r.pass)) {
      console.log(
        `   ${r.id}  expected ${r.expected}  got ${r.actual}`
      );
    }
    console.log(
      `\n ${C.yellow}This backend should not be used for shared data library contributions${C.reset}`
    );
    console.log(
      ` ${C.yellow}until all reference cases pass.${C.reset}`
    );
  } else {
    console.log(
      ` ${C.green}All cases passed. This backend is validated for shared data library use.${C.reset}`
    );
  }

  console.log("═".repeat(64) + "\n");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${C.red}Fatal error:${C.reset}`, err.message ?? err);
  process.exit(1);
});
