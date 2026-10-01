// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  HermesSettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { makeHermesAdapter } from "./HermesAdapter.ts";

const mockAgentPath = NodeURL.fileURLToPath(
  new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
);
const quoteShell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const decodeSettings = Schema.decodeEffect(HermesSettings);
const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-hermes-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = Effect.fn("makeTestHermesAdapter")(function* (
  environment: Record<string, string> = {},
) {
  const dir = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-acp-test-"))),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
  const binaryPath = NodePath.join(dir, "hermes");
  yield* Effect.promise(() =>
    NodeFSP.writeFile(
      binaryPath,
      `#!/bin/sh\nexec ${quoteShell(process.execPath)} ${quoteShell(mockAgentPath)} "$@"\n`,
      { mode: 0o755 },
    ),
  );
  const settings = yield* decodeSettings({ binaryPath });
  return yield* makeHermesAdapter(settings, {
    environment: {
      ...process.env,
      T3_ACP_REQUIRED_AUTH_METHOD: "bedrock",
      ...environment,
    },
  });
});

it.layer(testLayer)("HermesAdapter", (it) => {
  it.effect(
    "authenticates with the advertised method and drains streamed output before completion",
    () =>
      Effect.gen(function* () {
        const adapter = yield* makeTestAdapter();
        const threadId = ThreadId.make("hermes-stream");
        const events: ProviderRuntimeEvent[] = [];
        const completed = yield* Deferred.make<void>();
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => events.push(event)).pipe(
            Effect.andThen(
              event.type === "turn.completed"
                ? Deferred.succeed(completed, undefined)
                : Effect.void,
            ),
          ),
        ).pipe(Effect.forkChild);

        const startFiber = yield* adapter
          .startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
            modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "default" },
          })
          .pipe(Effect.forkChild);
        const session = yield* Fiber.join(startFiber);
        assert.equal(session.model, "grok-4.6");
        yield* adapter.sendTurn({ threadId, input: "hello", attachments: [] });
        yield* Deferred.await(completed);
        const deltaIndex = events.findIndex((event) => event.type === "content.delta");
        const completeIndex = events.findIndex((event) => event.type === "turn.completed");
        assert.isAtLeast(deltaIndex, 0);
        assert.isAbove(completeIndex, deltaIndex);

        yield* adapter.stopSession(threadId);
        const resumed = yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: session.resumeCursor,
        });
        assert.deepStrictEqual(resumed.resumeCursor, session.resumeCursor);
        yield* adapter.sendTurn({ threadId, input: "after restart", attachments: [] });
      }),
  );

  it.effect("surfaces missing credentials before opening a session", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter({ T3_ACP_REQUIRED_AUTH_METHOD: "hermes-setup" });
      const result = yield* adapter
        .startSession({
          threadId: ThreadId.make("hermes-unconfigured"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);
      assert.include(result.message, "hermes model");
      assert.isEmpty(yield* adapter.listSessions());
    }),
  );

  it.effect("handles approvals when the agent only offers allow once", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter({
        T3_ACP_EMIT_TOOL_CALLS: "1",
        T3_ACP_OMIT_ALLOW_ALWAYS: "1",
      });
      const threadId = ThreadId.make("hermes-approval");
      const opened = yield* Deferred.make<ApprovalRequestId>();
      const completed = yield* Deferred.make<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.type === "request.opened" && event.requestId) {
          return Deferred.succeed(opened, ApprovalRequestId.make(event.requestId));
        }
        if (event.type === "turn.completed") {
          return Deferred.succeed(completed, event);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turn = yield* adapter
        .sendTurn({
          threadId,
          input: "read metadata",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      yield* adapter.respondToRequest(threadId, yield* Deferred.await(opened), "acceptForSession");
      yield* Fiber.join(turn);
      const event = yield* Deferred.await(completed);
      assert.equal(event.type === "turn.completed" && event.payload.state, "completed");
    }),
  );

  it.effect("cancels a turn waiting for approval", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter({ T3_ACP_EMIT_TOOL_CALLS: "1" });
      const threadId = ThreadId.make("hermes-cancel");
      const opened = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Deferred.succeed(opened, undefined)
          : event.type === "turn.completed"
            ? Deferred.succeed(completed, event)
            : Effect.void,
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turn = yield* adapter
        .sendTurn({
          threadId,
          input: "wait for approval",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(opened);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(turn);
      const event = yield* Deferred.await(completed);
      assert.equal(event.type === "turn.completed" && event.payload.state, "cancelled");
    }),
  );

  it.effect("rejects rollback without trimming local history", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter();
      const threadId = ThreadId.make("hermes-rollback");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "remember this", attachments: [] });
      const failure = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
      assert.include(failure.message, "does not support provider-side rollback");
      assert.lengthOf((yield* adapter.readThread(threadId)).turns, 1);
    }),
  );
});
