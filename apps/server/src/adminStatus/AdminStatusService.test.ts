// @effect-diagnostics nodeBuiltinImport:off - test-only temp-path construction;
// see the same exemption in ../pathExpansion.ts.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunner from "../processRunner.ts";
import * as AdminStatusService from "./AdminStatusService.ts";

const TIMED_OUT_RESULT: ProcessRunner.ProcessRunOutput = {
  stdout: "",
  stderr: "",
  code: null,
  timedOut: true,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
};

const ONLINE_RESULT: ProcessRunner.ProcessRunOutput = {
  ...TIMED_OUT_RESULT,
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
};

const MISSING_TOOLS_DIR = NodePath.join(NodeOS.tmpdir(), "t3-admin-status-test-missing-cache");

// Guaranteed not to exist: neither the Bedrock cache file nor any
// admera-claude-tools install lives here, so the fire-and-forget
// refresh-script existence check in AdminStatusService also reliably
// misses (this must never spawn a real script during a test run).
const missingBedrockCacheEnv = Layer.succeed(HostProcessEnvironment, {
  XDG_CACHE_HOME: MISSING_TOOLS_DIR,
  ADMERA_CLAUDE_TOOLS: MISSING_TOOLS_DIR,
  ADMERA_KB_CLI: "nonexistent-kb",
});

const withMockedProcessRunner = (result: ProcessRunner.ProcessRunOutput) =>
  Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({ run: () => Effect.succeed(result) }),
  );

// Exercises the real `AdminStatusService.layer` (not just `make`), so the
// production wiring path is under test.
const testLayer = (result: ProcessRunner.ProcessRunOutput) =>
  AdminStatusService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, missingBedrockCacheEnv, withMockedProcessRunner(result)),
    ),
  );

describe("resolveBedrockDailyCost", () => {
  const parsed = {
    date: "2026-09-01",
    user: "justin",
    cost: 10.5,
    refreshed_at: "2026-09-01T12:00:00.000Z",
  };

  it("keeps the cost when the cached date matches today", () => {
    expect(AdminStatusService.resolveBedrockDailyCost(parsed, "2026-09-01")).toEqual({
      date: "2026-09-01",
      user: "justin",
      cost: 10.5,
      refreshedAt: "2026-09-01T12:00:00.000Z",
    });
  });

  it("returns null when the cached date is stale", () => {
    expect(AdminStatusService.resolveBedrockDailyCost(parsed, "2026-09-02")).toBeNull();
  });

  it("returns null when nothing was parsed", () => {
    expect(AdminStatusService.resolveBedrockDailyCost(null, "2026-09-01")).toBeNull();
  });
});

describe("AdminStatusService", () => {
  it.live("reports kb offline when the probe times out", () =>
    Effect.gen(function* () {
      const service = yield* AdminStatusService.AdminStatusService;
      const status = yield* service.readStatus;
      expect(status.kb.online).toBe(false);
    }).pipe(Effect.provide(testLayer(TIMED_OUT_RESULT))),
  );

  it.live("reports bedrockDaily as null when the cache file is missing", () =>
    Effect.gen(function* () {
      const service = yield* AdminStatusService.AdminStatusService;
      const status = yield* service.readStatus;
      expect(status.bedrockDaily).toBeNull();
    }).pipe(Effect.provide(testLayer(ONLINE_RESULT))),
  );
});
