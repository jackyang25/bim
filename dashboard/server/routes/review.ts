import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { callMcpTool } from "../mcp-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The review queue reads the audit log for interactions routed to human_review,
// and stores full interaction data separately so reviewers can see the complete
// context. In production this would be a database; for the prototype it's a
// JSON file that the dashboard maintains alongside the MCP server's audit log.

const REVIEW_STORE_PATH = path.resolve(
  process.env.REVIEW_STORE_PATH ?? path.join(__dirname, "..", "..", "review-queue.json"),
);

export interface ReviewItem {
  id: string;
  timestamp: string;
  session_id: string;
  user_input: string;
  agent_output: string;
  routing_decision: string;
  routing_reason: string;
  annotations: Record<string, unknown>;
  flags_summary: {
    total_flags: number;
    high_confidence_flags: number;
    categories_flagged: string[];
  };
  risk_scores: Record<string, number> | null;
  boundary_spec: {
    permitted_scope: string;
    escalation_rules: string[];
    prohibited_actions: string[];
    permitted_language_level: string;
  };
  reviewed: boolean;
}

function readStore(): ReviewItem[] {
  if (!fs.existsSync(REVIEW_STORE_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(REVIEW_STORE_PATH, "utf-8")) as ReviewItem[];
  } catch {
    return [];
  }
}

function writeStore(items: ReviewItem[]): void {
  fs.writeFileSync(REVIEW_STORE_PATH, JSON.stringify(items, null, 2), "utf-8");
}

export const reviewRouter = Router();

// GET /api/review-queue — pending interactions awaiting review
reviewRouter.get("/review-queue", (_req, res) => {
  const items = readStore().filter((i) => !i.reviewed);
  items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  res.json({ items, total: items.length });
});

// POST /api/review-queue — add an interaction to the review queue
// Called by integrations that want to store the full check output for review.
reviewRouter.post("/review-queue", (req, res) => {
  const body = req.body;
  if (!body.session_id || !body.user_input || !body.agent_output) {
    res.status(400).json({ error: "missing required fields" });
    return;
  }

  const items = readStore();
  const item: ReviewItem = {
    id: `review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: body.timestamp ?? new Date().toISOString(),
    session_id: body.session_id,
    user_input: body.user_input,
    agent_output: body.agent_output,
    routing_decision: body.routing_decision ?? "human_review",
    routing_reason: body.routing_reason ?? "",
    annotations: body.annotations ?? {},
    flags_summary: body.flags_summary ?? { total_flags: 0, high_confidence_flags: 0, categories_flagged: [] },
    risk_scores: body.risk_scores ?? null,
    boundary_spec: body.boundary_spec ?? {
      permitted_scope: "",
      escalation_rules: [],
      prohibited_actions: [],
      permitted_language_level: "",
    },
    reviewed: false,
  };

  items.push(item);
  writeStore(items);
  res.json({ id: item.id, stored: true });
});

// POST /api/review-queue/:id/verdict — submit a verdict for a flagged interaction
reviewRouter.post("/review-queue/:id/verdict", async (req, res) => {
  const { id } = req.params;
  const { verdict, failure_category, reviewer_notes } = req.body;

  if (!["confirmed_failure", "false_alarm", "uncertain"].includes(verdict)) {
    res.status(400).json({ error: "invalid verdict" });
    return;
  }

  const items = readStore();
  const item = items.find((i) => i.id === id);
  if (!item) {
    res.status(404).json({ error: "review item not found" });
    return;
  }

  try {
    // Submit verdict to the MCP server's Bayesian classifier
    await callMcpTool("submit_review_verdict", {
      session_id: item.session_id,
      timestamp: item.timestamp,
      verdict,
      failure_category,
      reviewer_notes,
    });

    // Mark as reviewed
    item.reviewed = true;
    writeStore(items);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: `Failed to submit verdict: ${err}` });
  }
});
