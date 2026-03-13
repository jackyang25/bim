/**
 * Append-only audit log — records every interaction checked, whether flagged or not.
 *
 * Format: NDJSON (one JSON object per line). Queryable with jq, importable
 * into any analytics pipeline.
 *
 * This is the immutable record of what the monitor saw. The verdict store
 * records what human reviewers decided. Together they form the full picture.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { FlagsSummary, RoutingDecision } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = path.join(__dirname, "..", "audit.ndjson");

export interface AuditEntry {
  ts: string;
  schema_version: string;
  session_id: string;
  routing_decision: RoutingDecision;
  total_flags: number;
  high_confidence_flags: number;
  categories_flagged: string[];
  annotation_latency_ms: number;
}

export class AuditLog {
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? DEFAULT_PATH;
  }

  append(entry: AuditEntry): void {
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      // Audit log write failure must never crash the server
      process.stderr.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          msg: "audit_log_write_failed",
          error: String(err),
        }) + "\n"
      );
    }
  }
}
