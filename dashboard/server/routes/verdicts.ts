import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { StoredVerdict } from "boundary-monitor-mcp/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VERDICTS_PATH = path.resolve(
  process.env.VERDICTS_PATH ??
    path.join(__dirname, "..", "..", "..", "boundary-monitor-mcp", "verdicts.json"),
);

function readVerdicts(): StoredVerdict[] {
  if (!fs.existsSync(VERDICTS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(VERDICTS_PATH, "utf-8")) as StoredVerdict[];
  } catch {
    return [];
  }
}

export const verdictSummaryRouter = Router();

// GET /api/verdicts/summary — aggregate verdict statistics
verdictSummaryRouter.get("/verdicts/summary", (_req, res) => {
  const verdicts = readVerdicts();

  const by_verdict: Record<string, number> = {};
  const by_category: Record<string, Record<string, number>> = {};

  for (const v of verdicts) {
    by_verdict[v.verdict] = (by_verdict[v.verdict] ?? 0) + 1;

    if (v.failure_category) {
      if (!by_category[v.failure_category]) {
        by_category[v.failure_category] = {};
      }
      by_category[v.failure_category][v.verdict] =
        (by_category[v.failure_category][v.verdict] ?? 0) + 1;
    }
  }

  res.json({ total: verdicts.length, by_verdict, by_category });
});
