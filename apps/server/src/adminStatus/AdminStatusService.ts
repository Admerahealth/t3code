/**
 * AdminStatusService - Admera KB reachability + today's Bedrock spend.
 *
 * Both reads are best-effort: a probe failure or a missing/stale cache file
 * degrades to an offline/`null` result rather than failing the RPC, since
 * this is diagnostic chrome (the statusline), not something a caller should
 * ever need to retry or handle an error for.
 *
 * @module AdminStatusService
 */
import * as NodeOS from "node:os";

import type { AdminStatusResult, BedrockDailyCost, KbStatus } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../pathExpansion.ts";
import * as ProcessRunner from "../processRunner.ts";
import { makeDayFormatter } from "../usage/usageAggregation.ts";

/** kb CLI probe: exit 0 within this budget counts as online. */
const KB_PROBE_TIMEOUT = "5 seconds";
const KB_PROBE_ARGS = ["--quiet", "list-recent", "--limit", "1"];
const DEFAULT_KB_COMMAND = "kb";

/** Never probe more often than this, regardless of how often clients poll. */
const KB_STATUS_CACHE_TTL_NANOS = 60_000_000_000n;

const BEDROCK_CACHE_RELATIVE_SEGMENTS = ["admera-claude-tools", "bedrock-daily-cost.json"];

/** Bedrock's cost cache is refreshed relative to Eastern time, not UTC. */
const formatEasternDay = makeDayFormatter("America/New_York");

/**
 * On-disk shape written by `admera-claude-tools` (snake_case). `models` is
 * intentionally not declared: the wire contract never re-exposes it, and
 * unknown extra keys are ignored by decoding rather than rejected.
 */
const BedrockDailyCostFile = Schema.Struct({
  date: Schema.String,
  user: Schema.String,
  cost: Schema.Number,
  refreshed_at: Schema.String,
});
const decodeBedrockDailyCostFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    BedrockDailyCostFile as unknown as Schema.Codec<typeof BedrockDailyCostFile.Type>,
  ),
);

/**
 * Applies the freshness guard: a cache file whose `date` is not today in
 * America/New_York is stale (the refresher runs out-of-band, so a sleep
 * through midnight must not keep showing yesterday's total). Pure so the
 * guard is testable without touching the filesystem.
 */
export function resolveBedrockDailyCost(
  parsed: typeof BedrockDailyCostFile.Type | null,
  todayEasternDay: string,
): BedrockDailyCost | null {
  if (parsed === null || parsed.date !== todayEasternDay) {
    return null;
  }
  return {
    date: parsed.date,
    user: parsed.user,
    cost: parsed.cost,
    refreshedAt: parsed.refreshed_at,
  };
}

interface KbStatusCacheEntry {
  readonly status: KbStatus;
  readonly expiresAtNanos: bigint;
}

export class AdminStatusService extends Context.Service<
  AdminStatusService,
  {
    readonly readStatus: Effect.Effect<AdminStatusResult>;
  }
>()("t3/adminStatus/AdminStatusService") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const hostEnvironment = yield* HostProcessEnvironment;

  const resolveBedrockCachePath = Effect.sync(() => {
    const xdgCacheHome = hostEnvironment["XDG_CACHE_HOME"]?.trim() ?? "";
    const cacheBase =
      xdgCacheHome.length > 0
        ? path.resolve(expandHomePath(xdgCacheHome))
        : path.join(NodeOS.homedir(), ".cache");
    return path.join(cacheBase, ...BEDROCK_CACHE_RELATIVE_SEGMENTS);
  });

  const probeKb = Effect.fn("AdminStatusService.probeKb")(function* () {
    const kbCliEnv = hostEnvironment["ADMERA_KB_CLI"]?.trim() ?? "";
    const command = kbCliEnv.length > 0 ? kbCliEnv : DEFAULT_KB_COMMAND;
    const result = yield* processRunner
      .run({
        command,
        args: KB_PROBE_ARGS,
        timeout: KB_PROBE_TIMEOUT,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.orElseSucceed(() => null));
    const checkedAt = yield* DateTime.now;
    return {
      online: result !== null && !result.timedOut && result.code === 0,
      checkedAt: DateTime.formatIso(checkedAt),
    } satisfies KbStatus;
  });

  const kbStatusCache = yield* Ref.make<Option.Option<KbStatusCacheEntry>>(Option.none());

  // Never caches a failed/interrupted probe: only a completed `probeKb`
  // result reaches the `Ref.set`, so a client disconnecting mid-probe leaves
  // the cache untouched instead of poisoning every caller for the rest of
  // the TTL (mirrors the editor-discovery cache in `externalLauncher.ts`).
  const readKbStatus = Effect.gen(function* () {
    const nowNanos = yield* Clock.currentTimeNanos;
    const cached = yield* Ref.get(kbStatusCache);
    if (Option.isSome(cached) && cached.value.expiresAtNanos > nowNanos) {
      return cached.value.status;
    }
    const status = yield* probeKb();
    yield* Ref.set(
      kbStatusCache,
      Option.some({ status, expiresAtNanos: nowNanos + KB_STATUS_CACHE_TTL_NANOS }),
    );
    return status;
  });

  const readBedrockDaily = Effect.gen(function* () {
    const cachePath = yield* resolveBedrockCachePath;
    const parsed = yield* fileSystem.readFileString(cachePath).pipe(
      Effect.flatMap((raw) => decodeBedrockDailyCostFile(raw)),
      Effect.catchCause(() => Effect.succeed(null)),
    );
    const nowMs = yield* Clock.currentTimeMillis;
    return resolveBedrockDailyCost(parsed, formatEasternDay(nowMs));
  });

  const readStatus = Effect.gen(function* () {
    const [kb, bedrockDaily] = yield* Effect.all([readKbStatus, readBedrockDaily], {
      concurrency: 2,
    });
    return { kb, bedrockDaily } satisfies AdminStatusResult;
  });

  return AdminStatusService.of({ readStatus });
});

export const layer = Layer.effect(AdminStatusService, make).pipe(
  Layer.provide(ProcessRunner.layer),
);

/** Test stub: returns offline KB and null Bedrock daily cost. */
export const layerTest = Layer.succeed(
  AdminStatusService,
  AdminStatusService.of({
    readStatus: Effect.succeed({
      kb: {
        online: false,
        checkedAt: "1970-01-01T00:00:00.000Z",
      },
      bedrockDaily: null,
    }),
  }),
);
