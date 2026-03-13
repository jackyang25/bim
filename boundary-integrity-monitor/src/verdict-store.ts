import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { logger } from "./logger.js";
import type {
  StoredVerdict,
  SubmitReviewVerdictInput,
  SubmitReviewVerdictOutput,
} from "./types.js";

// ─── Interface ────────────────────────────────────────────────────────────────

export interface VerdictStore {
  store(input: SubmitReviewVerdictInput): Promise<SubmitReviewVerdictOutput>;
  getAll(): StoredVerdict[];
}

// ─── Async mutex — prevents concurrent write corruption ───────────────────────
// Node.js is single-threaded but async operations interleave on the event loop.
// Without a mutex, two concurrent store() calls can both read 10 verdicts,
// both write 11, and one write silently overwrites the other.

class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();

  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const prev = this.queue;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

// ─── Local JSON Implementation ────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = path.join(__dirname, "..", "verdicts.json");

export class LocalJsonVerdictStore implements VerdictStore {
  private filePath: string;
  private mutex = new AsyncMutex();

  constructor(filePath?: string) {
    this.filePath = filePath ?? config.storage.verdictsPath ?? DEFAULT_PATH;
  }

  get storeName(): string {
    return `LocalJsonVerdictStore(${path.basename(this.filePath)})`;
  }

  getAll(): StoredVerdict[] {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as StoredVerdict[];
    } catch (err) {
      logger.error("verdict_store_read_failed", { error: String(err) });
      return [];
    }
  }

  async store(input: SubmitReviewVerdictInput): Promise<SubmitReviewVerdictOutput> {
    return this.mutex.acquire(async () => {
      const verdicts = this.getAll();

      const entry: StoredVerdict = {
        session_id: input.session_id,
        timestamp: input.timestamp,
        verdict: input.verdict,
        schema_version: config.server.schemaVersion,
        stored_at: new Date().toISOString(),
        ...(input.site_id !== undefined && { site_id: input.site_id }),
        ...(input.reviewer_notes !== undefined && { reviewer_notes: input.reviewer_notes }),
        ...(input.failure_category !== undefined && { failure_category: input.failure_category }),
      };

      verdicts.push(entry);
      fs.writeFileSync(this.filePath, JSON.stringify(verdicts, null, 2), "utf-8");

      const total_verdicts = verdicts.length;
      const confirmed = verdicts.filter((v) => v.verdict === "confirmed_failure").length;
      const confirmation_rate =
        total_verdicts > 0
          ? Math.round((confirmed / total_verdicts) * 100) / 100
          : 0;

      logger.info("verdict_stored", {
        session_id: input.session_id,
        verdict: input.verdict,
        site_id: input.site_id,
        total_verdicts,
        confirmation_rate,
      });

      return { stored: true, total_verdicts, confirmation_rate };
    });
  }
}
