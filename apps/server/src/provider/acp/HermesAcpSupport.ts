import { type HermesSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/** Skips Hermes' own global MCP startup so `initialize` isn't delayed — the host (T3 Code) owns MCP via `session/new` instead. */
const HERMES_SKIP_CONFIGURED_MCP_ENV = "HERMES_ACP_SKIP_CONFIGURED_MCP";
const HERMES_DRIVER_KIND = ProviderDriverKind.make("hermes");

export const selectHermesAuthMethod = (
  response: EffectAcpSchema.InitializeResponse,
): Effect.Effect<string, EffectAcpErrors.AcpError> => {
  const method = response.authMethods?.find(
    (entry) => entry.id !== "hermes-setup" && (!("type" in entry) || entry.type !== "terminal"),
  );
  return method
    ? Effect.succeed(method.id)
    : Effect.fail(
        EffectAcpErrors.AcpRequestError.invalidParams(
          "Hermes has no configured runtime credentials. Run `hermes model` on this environment.",
        ),
      );
};

type HermesAcpRuntimeHermesSettings = Pick<HermesSettings, "binaryPath">;

export interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildHermesAcpSpawnInput(
  hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: hermesSettings?.binaryPath || "hermes",
    args: ["acp"],
    cwd,
    env: {
      ...environment,
      [HERMES_SKIP_CONFIGURED_MCP_ENV]: "1",
    },
  };
}

export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
        authMethodId: selectHermesAuthMethod,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/** Model entries look like `provider:model` (e.g. `openrouter:z-ai/glm-5.1`) — passed through verbatim. */
export function resolveHermesAcpBaseModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === "default") {
    return undefined;
  }
  return normalizeModelSlug(trimmed, HERMES_DRIVER_KIND) ?? trimmed;
}

export function currentHermesModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

/**
 * Switches the active model through `session/set_model` when the requested
 * id differs from the current one. Hermes has no documented per-model
 * reasoning-effort metadata (unlike Grok), so this only ever sends a model id.
 */
export function applyHermesAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  if (input.requestedModelId === undefined || input.requestedModelId === input.currentModelId) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}
