import { describe, expect, it } from "@effect/vitest";
import { HermesSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { buildInitialHermesProviderSnapshot } from "./HermesProvider.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

describe("Hermes custom model settings", () => {
  it.effect("keeps named presets selectable alongside existing bare model IDs", () =>
    Effect.gen(function* () {
      const settings = decodeHermesSettings({
        enabled: true,
        customModels: [
          "openrouter:example/model",
          { slug: "moa:review", name: "Acting model with review adviser" },
        ],
      });
      const snapshot = yield* buildInitialHermesProviderSnapshot(settings);
      const preset = snapshot.models.find((model) => model.slug === "moa:review");

      expect(preset?.name).toBe("Acting model with review adviser");
      expect(snapshot.models.some((model) => model.slug === "openrouter:example/model")).toBe(true);
      expect(snapshot.models.some((model) => model.slug === "default" && model.isDefault)).toBe(
        true,
      );
    }),
  );
});
