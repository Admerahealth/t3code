import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import {
  applyHermesAcpModelSelection,
  buildHermesAcpSpawnInput,
  resolveHermesAcpBaseModelId,
  selectHermesAuthMethod,
} from "./HermesAcpSupport.ts";

describe("buildHermesAcpSpawnInput", () => {
  it("builds the default Hermes ACP command with the MCP-skip env var set", () => {
    expect(buildHermesAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "hermes",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { HERMES_ACP_SKIP_CONFIGURED_MCP: "1" },
    });
  });

  it("uses the configured binary path when present", () => {
    expect(
      buildHermesAcpSpawnInput({ binaryPath: "/usr/local/bin/hermes" }, "/tmp/project"),
    ).toEqual({
      command: "/usr/local/bin/hermes",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { HERMES_ACP_SKIP_CONFIGURED_MCP: "1" },
    });
  });

  it("preserves the inherited environment alongside the MCP-skip flag", () => {
    expect(buildHermesAcpSpawnInput(undefined, "/tmp/project", { PATH: "/usr/bin" })).toEqual({
      command: "hermes",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { PATH: "/usr/bin", HERMES_ACP_SKIP_CONFIGURED_MCP: "1" },
    });
  });

  it("does not vary spawn args by runtime mode — approvals flow through ACP permission requests, not CLI flags", () => {
    const withoutMode = buildHermesAcpSpawnInput(undefined, "/tmp/project");
    expect(withoutMode.args).toEqual(["acp"]);
  });
});

describe("resolveHermesAcpBaseModelId", () => {
  it("uses Hermes' configured model for the default selection", () => {
    expect(resolveHermesAcpBaseModelId("default")).toBeUndefined();
  });
  it("passes provider:model identifiers through verbatim", () => {
    expect(resolveHermesAcpBaseModelId("openrouter:z-ai/glm-5.1")).toBe("openrouter:z-ai/glm-5.1");
  });

  it("trims whitespace", () => {
    expect(resolveHermesAcpBaseModelId("  openrouter:z-ai/glm-5.1  ")).toBe(
      "openrouter:z-ai/glm-5.1",
    );
  });

  it("returns undefined for empty or missing input", () => {
    expect(resolveHermesAcpBaseModelId(undefined)).toBeUndefined();
    expect(resolveHermesAcpBaseModelId(null)).toBeUndefined();
    expect(resolveHermesAcpBaseModelId("   ")).toBeUndefined();
  });
});

describe("selectHermesAuthMethod", () => {
  it.effect("selects the advertised runtime credentials instead of interactive setup", () =>
    Effect.gen(function* () {
      const method = yield* selectHermesAuthMethod({
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [
          { id: "hermes-setup", name: "Setup" },
          { id: "bedrock", name: "Bedrock runtime" },
        ],
      });
      expect(method).toBe("bedrock");
    }),
  );

  it.effect("reports how to configure Hermes when only setup is available", () =>
    Effect.gen(function* () {
      const error = yield* selectHermesAuthMethod({
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [{ id: "hermes-setup", name: "Setup" }],
      }).pipe(Effect.flip);
      expect(error.message).toContain("hermes model");
    }),
  );
});

describe("applyHermesAcpModelSelection", () => {
  it.effect("switches the session model when the requested id differs from the current one", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const runtime = {
        setSessionModel: (modelId: string) =>
          Effect.sync(() => {
            calls.push(modelId);
            return {};
          }),
      };

      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openrouter:z-ai/glm-5.1",
        requestedModelId: "openrouter:anthropic/claude-sonnet-5",
        mapError: (cause) => cause,
      });

      expect(calls).toEqual(["openrouter:anthropic/claude-sonnet-5"]);
      expect(result).toBe("openrouter:anthropic/claude-sonnet-5");
    }),
  );

  it.effect("is a no-op when the requested model matches the current one", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const runtime = {
        setSessionModel: (modelId: string) =>
          Effect.sync(() => {
            calls.push(modelId);
            return {};
          }),
      };

      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openrouter:z-ai/glm-5.1",
        requestedModelId: "openrouter:z-ai/glm-5.1",
        mapError: (cause) => cause,
      });

      expect(calls).toEqual([]);
      expect(result).toBe("openrouter:z-ai/glm-5.1");
    }),
  );

  it.effect("is a no-op when no model was requested", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const runtime = {
        setSessionModel: (modelId: string) =>
          Effect.sync(() => {
            calls.push(modelId);
            return {};
          }),
      };

      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "openrouter:z-ai/glm-5.1",
        requestedModelId: undefined,
        mapError: (cause) => cause,
      });

      expect(calls).toEqual([]);
      expect(result).toBe("openrouter:z-ai/glm-5.1");
    }),
  );
});
