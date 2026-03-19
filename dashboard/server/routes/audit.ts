import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { AuditEntry } from "boundary-monitor-mcp/audit-log";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const AUDIT_LOG_PATH = path.resolve(
  process.env.AUDIT_LOG_PATH ??
    path.join(__dirname, "..", "..", "..", "boundary-monitor-mcp", "audit.ndjson"),
);

function readAuditLog(): AuditEntry[] {
  if (!fs.existsSync(AUDIT_LOG_PATH)) return [];
  try {
    const content = fs.readFileSync(AUDIT_LOG_PATH, "utf-8").trim();
    if (!content) return [];
    return content.split("\n").map((line) => JSON.parse(line) as AuditEntry);
  } catch {
    return [];
  }
}

export const auditRouter = Router();

// GET /api/audit-log — paginated audit log with filters
auditRouter.get("/audit-log", (req, res) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 25));
  const routingFilter = (req.query.routing_decision as string) || undefined;
  const from = (req.query.from as string) || undefined;
  const to = (req.query.to as string) || undefined;

  let entries = readAuditLog();

  // Apply filters
  if (routingFilter) {
    entries = entries.filter((e) => e.routing_decision === routingFilter);
  }
  if (from) {
    const fromDate = new Date(from);
    entries = entries.filter((e) => new Date(e.ts) >= fromDate);
  }
  if (to) {
    const toDate = new Date(to);
    toDate.setDate(toDate.getDate() + 1); // Include the end date
    entries = entries.filter((e) => new Date(e.ts) < toDate);
  }

  // Sort most recent first
  entries.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

  const total = entries.length;
  const start = (page - 1) * pageSize;
  const paged = entries.slice(start, start + pageSize);

  res.json({ entries: paged, total, page, pageSize });
});
