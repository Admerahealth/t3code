// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HermesSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeHermesTextGeneration } from "./HermesTextGeneration.ts";

const decodeSettings = Schema.decodeEffect(HermesSettings);
const decodeArgs = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

it.effect(
  "uses clean one-shot output and forwards qualified models while preserving the configured default",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-text-test-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const binaryPath = NodePath.join(directory, "hermes");
      const argsPath = NodePath.join(directory, "args.json");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          binaryPath,
          `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.HERMES_TEST_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({title: "Hermes test title"}));
`,
          { mode: 0o755 },
        ),
      );
      const settings = yield* decodeSettings({ binaryPath });
      const generation = yield* makeHermesTextGeneration(settings, {
        ...process.env,
        HERMES_TEST_ARGS_PATH: argsPath,
      });
      const input = {
        cwd: directory,
        message: "Create a title",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "default" },
      };
      const generated = yield* generation.generateThreadTitle(input);
      assert.equal(generated.title, "Hermes test title");
      const defaultArgs = yield* decodeArgs(
        yield* Effect.promise(() => NodeFSP.readFile(argsPath, "utf8")),
      );
      assert.equal(defaultArgs[0], "-z");
      assert.notInclude(defaultArgs, "--model");
      yield* generation.generateThreadTitle({
        ...input,
        modelSelection: { ...input.modelSelection, model: "custom:local:model-name" },
      });
      const explicitArgs = yield* decodeArgs(
        yield* Effect.promise(() => NodeFSP.readFile(argsPath, "utf8")),
      );
      assert.deepEqual(explicitArgs.slice(-2), ["--model", "custom:local:model-name"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
