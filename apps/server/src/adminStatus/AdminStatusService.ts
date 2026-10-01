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
import { resolveCommandPath } from "@t3tools/shared/shell";
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

/**
 * Poll cadence is 60s (see the `adminStatus` atom in client-runtime); the
 * cache TTL is set a little above that so a poll landing just after a probe
 * still hits cache instead of missing every single time.
 */
const KB_STATUS_CACHE_TTL_NANOS = 90_000_000_000n;

const BEDROCK_CACHE_RELATIVE_SEGMENTS = ["admera-claude-tools", "bedrock-daily-cost.json"];
/** Keep aligned with bedrock-daily-cost-refresh.sh's default TTL. */
const BEDROCK_CACHE_TTL_MS = 600_000;
const BEDROCK_CACHE_TTL_NANOS = 600_000_000_000n;

/** Bedrock's cost cache is refreshed relative to Eastern time, not UTC. */
const formatEasternDay = makeDayFormatter("America/New_York");

/**
 * On-disk shape written by `admera-claude-tools` (snake_case). The unpriced
 * list was added after the original cache format, so it stays optional here.
 */
const BedrockDailyCostFile = Schema.Struct({
  date: Schema.String,
  user: Schema.String,
  cost: Schema.Number,
  refreshed_at: Schema.String,
  unpriced_models: Schema.optional(
    Schema.Array(
      Schema.Struct({
        model: Schema.String,
        calls: Schema.Number,
      }),
    ),
  ),
});
const decodeBedrockDailyCostFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(BedrockDailyCostFile),
);

/**
 * Rejects another ET date and marks an old same-day value stale. Keeping the
 * old amount visible while a detached refresh runs avoids a blank badge while
 * making its age explicit. Pure so the guard is testable without the filesystem.
 */
export function resolveBedrockDailyCost(
  parsed: typeof BedrockDailyCostFile.Type | null,
  todayEasternDay: string,
  nowMs: number,
): BedrockDailyCost | null {
  if (parsed === null || parsed.date !== todayEasternDay) {
    return null;
  }
  const refreshedAtMs = Date.parse(parsed.refreshed_at);
  return {
    date: parsed.date,
    user: parsed.user,
    cost: parsed.cost,
    refreshedAt: parsed.refreshed_at,
    stale:
      !Number.isFinite(refreshedAtMs) ||
      nowMs < refreshedAtMs ||
      nowMs - refreshedAtMs >= BEDROCK_CACHE_TTL_MS,
    unpricedModels: parsed.unpriced_models ?? [],
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

  /**
   * Base install directory for `admera-claude-tools`. Shared by the `kb`
   * PATH-lookup fallback and the Bedrock cache refresher: both are
   * artifacts of the same external tool install.
   */
  const resolveAdmeraClaudeToolsHome = Effect.sync(() => {
    const toolsHomeEnv = hostEnvironment["ADMERA_CLAUDE_TOOLS"]?.trim() ?? "";
    return toolsHomeEnv.length > 0
      ? path.resolve(expandHomePath(toolsHomeEnv))
      : path.join(NodeOS.homedir(), "admera-claude-tools");
  });

  const resolveBedrockCachePath = Effect.sync(() => {
    const xdgCacheHome = hostEnvironment["XDG_CACHE_HOME"]?.trim() ?? "";
    const cacheBase =
      xdgCacheHome.length > 0
        ? path.resolve(expandHomePath(xdgCacheHome))
        : path.join(NodeOS.homedir(), ".cache");
    return path.join(cacheBase, ...BEDROCK_CACHE_RELATIVE_SEGMENTS);
  });

  /**
   * Resolves the `kb` binary: an explicit override wins outright; otherwise
   * a normal PATH lookup; otherwise the fixed install location, since a
   * GUI-launched server (no shell profile, no augmented PATH) still needs to
   * reach it.
   */
  const resolveKbCommand = Effect.gen(function* () {
    const kbCliEnv = hostEnvironment["ADMERA_KB_CLI"]?.trim() ?? "";
    if (kbCliEnv.length > 0) {
      return kbCliEnv;
    }
    // resolveCommandPath does its own internal FileSystem/Path service
    // lookup, independent of the values already resolved above; re-provide
    // them from here so that lookup is satisfied locally instead of leaking
    // into readStatus's own requirements (mirrors resolveTranscriptDirs's
    // Effect.provideService(Path.Path, path) in UsageService.ts).
    const onPath = yield* resolveCommandPath(DEFAULT_KB_COMMAND).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.orElseSucceed(() => null),
    );
    if (onPath !== null) {
      return onPath;
    }
    const toolsHome = yield* resolveAdmeraClaudeToolsHome;
    return path.join(toolsHome, "bin", DEFAULT_KB_COMMAND);
  });

  const probeKb = Effect.fn("AdminStatusService.probeKb")(function* () {
    const command = yield* resolveKbCommand;
    const result = yield* processRunner
      .run({
        command,
        args: KB_PROBE_ARGS,
        timeout: KB_PROBE_TIMEOUT,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.tapError((error) =>
          Effect.logDebug("AdminStatusService: kb probe failed", { command, error }),
        ),
        Effect.orElseSucceed(() => null),
      );
    const checkedAt = yield* DateTime.now;
    return {
      online: result !== null && !result.timedOut && result.code === 0,
      checkedAt: DateTime.formatIso(checkedAt),
    } satisfies KbStatus;
  });

  const kbStatusCache = yield* Ref.make<Option.Option<KbStatusCacheEntry>>(Option.none());
  const lastBedrockRefreshNudgeNanos = yield* Ref.make<Option.Option<bigint>>(Option.none());

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

  /**
   * Fire-and-forget: the refresh script owns its own locking and silently
   * no-ops on failure or if it's already running. This service rate-limits
   * nudges to the same ten-minute cache TTL. Detached so a hung script can
   * never delay this (or any other) RPC.
   */
  const triggerBedrockRefresh = Effect.gen(function* () {
    const nowNanos = yield* Clock.currentTimeNanos;
    const lastNudge = yield* Ref.get(lastBedrockRefreshNudgeNanos);
    if (Option.isSome(lastNudge) && nowNanos - lastNudge.value < BEDROCK_CACHE_TTL_NANOS) {
      return;
    }
    yield* Ref.set(lastBedrockRefreshNudgeNanos, Option.some(nowNanos));
    const toolsHome = yield* resolveAdmeraClaudeToolsHome;
    const scriptPath = path.join(toolsHome, "scripts", "bedrock-daily-cost-refresh.sh");
    const exists = yield* fileSystem.exists(scriptPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return;
    yield* processRunner.run({
      command: scriptPath,
      args: ["--background"],
      timeout: "5 seconds",
      timeoutBehavior: "timedOutResult",
    });
  }).pipe(Effect.ignore, Effect.forkDetach);

  // Path resolution lives inside the same guarded block as the read and
  // decode: a failure at any of the three stages must degrade to `null`,
  // never fail the RPC.
  const readBedrockDaily = Effect.gen(function* () {
    const parsed = yield* Effect.gen(function* () {
      const cachePath = yield* resolveBedrockCachePath;
      const raw = yield* fileSystem.readFileString(cachePath);
      return yield* decodeBedrockDailyCostFile(raw);
    }).pipe(Effect.catchCause(() => Effect.succeed(null)));
    const nowMs = yield* Clock.currentTimeMillis;
    const resolved = resolveBedrockDailyCost(parsed, formatEasternDay(nowMs), nowMs);
    if (resolved === null || resolved.stale) {
      yield* triggerBedrockRefresh;
    }
    return resolved;
  });

  const readStatus = Effect.gen(function* () {
    const [kb, bedrockDaily] = yield* Effect.all([readKbStatus, readBedrockDaily], {
      concurrency: 2,
    });
    return { kb, bedrockDaily } satisfies AdminStatusResult;
  });

  return AdminStatusService.of({ readStatus });
});

export const layer = Layer.effect(AdminStatusService, make);

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
