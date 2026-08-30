import type { Client } from "@libsql/client";
import type {
  QuotaRepository,
  QuotaSubject,
  QuotaWindowKind,
  ReservationResult,
  UsageSettlement,
} from "../../domain/ports";

interface BucketRow {
  request_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  estimated_cost_microusd: number;
}

/**
 * Per-subject usage buckets with atomic conditional reservation. The
 * reservation is a single conditional upsert: concurrent reservers can never
 * push `request_count` past the limit.
 */
export class LibsqlQuotaRepository implements QuotaRepository {
  readonly #client: Client;

  constructor(client: Client) {
    this.#client = client;
  }

  async reserve(
    subject: QuotaSubject,
    windowKind: QuotaWindowKind,
    periodStartMs: number,
    limit: number,
    amount: number,
  ): Promise<ReservationResult> {
    const result = await this.#client.execute({
      sql: `INSERT INTO ai_usage_buckets
              (subject_type, subject_id, window_kind, period_start, request_count, prompt_tokens, completion_tokens, estimated_cost_microusd)
            VALUES (?, ?, ?, ?, ?, 0, 0, 0)
            ON CONFLICT (subject_type, subject_id, window_kind, period_start) DO UPDATE SET
              request_count = request_count + excluded.request_count
            WHERE request_count + excluded.request_count <= ?
            RETURNING request_count`,
      args: [subject.subjectType, subject.subjectId, windowKind, periodStartMs, amount, limit],
    });

    const row = result.rows[0] as unknown as { request_count: number } | undefined;
    if (row) {
      return {
        granted: true,
        usedAfter: Number(row.request_count),
        limit,
        resetsAtMs: periodEndMs(windowKind, periodStartMs),
      };
    }

    const current = await this.read(subject, windowKind, periodStartMs);
    return {
      granted: false,
      usedAfter: current.used,
      limit,
      resetsAtMs: periodEndMs(windowKind, periodStartMs),
    };
  }

  async settle(
    subject: QuotaSubject,
    windowKind: QuotaWindowKind,
    periodStartMs: number,
    usage: UsageSettlement,
  ): Promise<void> {
    await this.#client.execute({
      sql: `UPDATE ai_usage_buckets SET
              request_count = request_count + ?,
              prompt_tokens = prompt_tokens + ?,
              completion_tokens = completion_tokens + ?,
              estimated_cost_microusd = estimated_cost_microusd + ?
            WHERE subject_type = ? AND subject_id = ? AND window_kind = ? AND period_start = ?`,
      args: [
        usage.requests ?? 0,
        usage.promptTokens ?? 0,
        usage.completionTokens ?? 0,
        usage.estimatedCostMicroUSD ?? 0,
        subject.subjectType,
        subject.subjectId,
        windowKind,
        periodStartMs,
      ],
    });
  }

  async refund(
    subject: QuotaSubject,
    windowKind: QuotaWindowKind,
    periodStartMs: number,
    amount: number,
  ): Promise<void> {
    await this.#client.execute({
      sql: `UPDATE ai_usage_buckets SET
              request_count = MAX(0, request_count - ?)
            WHERE subject_type = ? AND subject_id = ? AND window_kind = ? AND period_start = ?`,
      args: [amount, subject.subjectType, subject.subjectId, windowKind, periodStartMs],
    });
  }

  async read(
    subject: QuotaSubject,
    windowKind: QuotaWindowKind,
    periodStartMs: number,
  ): Promise<{ used: number; limit: number | null }> {
    const result = await this.#client.execute({
      sql: `SELECT request_count FROM ai_usage_buckets
            WHERE subject_type = ? AND subject_id = ? AND window_kind = ? AND period_start = ?`,
      args: [subject.subjectType, subject.subjectId, windowKind, periodStartMs],
    });
    const row = result.rows[0] as unknown as BucketRow | undefined;
    return { used: row ? Number(row.request_count) : 0, limit: null };
  }
}

/** UTC end of the window containing periodStart. */
export function periodEndMs(windowKind: QuotaWindowKind, periodStartMs: number): number {
  const MINUTE = 60_000;
  const DAY = 86_400_000;
  return windowKind === "burst-minute" ? periodStartMs + MINUTE : periodStartMs + DAY;
}

/** Floor a timestamp to the start of its UTC window. */
export function periodStartFor(nowMs: number, windowKind: QuotaWindowKind): number {
  const MINUTE = 60_000;
  const DAY = 86_400_000;
  const window = windowKind === "burst-minute" ? MINUTE : DAY;
  return Math.floor(nowMs / window) * window;
}
