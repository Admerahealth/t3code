/**
 * Admera-specific server status: knowledge-base reachability and the
 * current day's Bedrock spend.
 *
 * Both figures are read off the machine running the server — the `kb` CLI
 * for reachability, and an out-of-band-refreshed cache file for spend — so
 * this is scoped to one environment rather than merged across environments
 * the way usage summaries are.
 *
 * @module adminStatus
 */
import * as Schema from "effect/Schema";

export const KbStatus = Schema.Struct({
  online: Schema.Boolean,
  checkedAt: Schema.String,
});
export type KbStatus = typeof KbStatus.Type;

export const BedrockDailyCost = Schema.Struct({
  /** Calendar day the cost applies to, `YYYY-MM-DD` in America/New_York. */
  date: Schema.String,
  user: Schema.String,
  cost: Schema.Number,
  refreshedAt: Schema.String,
  /** True when the cache is older than the refresher's ten-minute TTL. */
  stale: Schema.Boolean,
  /** Bedrock calls excluded from the token-priced total. */
  unpricedModels: Schema.Array(
    Schema.Struct({
      model: Schema.String,
      calls: Schema.Number,
    }),
  ),
});
export type BedrockDailyCost = typeof BedrockDailyCost.Type;

export const AdminStatusResult = Schema.Struct({
  kb: KbStatus,
  /**
   * `null` when the cache file is missing, unparseable, or stale (its
   * `date` is not today in America/New_York — the file is refreshed
   * out-of-band and a sleep through midnight must not show yesterday's
   * total).
   */
  bedrockDaily: Schema.NullOr(BedrockDailyCost),
});
export type AdminStatusResult = typeof AdminStatusResult.Type;
