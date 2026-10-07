import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { MuseSettings } from "@t3tools/contracts";

import {
  buildInitialMuseProviderSnapshot,
  buildMuseModelsFromCatalog,
  museModelsFromSettings,
} from "./MuseProvider.ts";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import { parseMuseLaunchArgs } from "../orchestration-v2/Adapters/MuseHost.ts";

const decodeMuseSettings = Schema.decodeSync(MuseSettings);

describe("Muse provider", () => {
  it("is registered as a built-in driver", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => String(driver.driverKind))).toContain("muse");
  });

  it("decodes defaults (disabled, muse binary)", () => {
    expect(decodeMuseSettings({})).toMatchObject({ enabled: false, binaryPath: "muse" });
  });

  it.effect("builds a disabled initial snapshot", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialMuseProviderSnapshot(
        decodeMuseSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.models.length).toBeGreaterThan(0);
    }),
  );

  it("maps custom models over built-ins", () => {
    const models = museModelsFromSettings([{ slug: "my-model" }]);
    expect(models.map((model) => model.slug)).toContain("my-model");
  });

  it("maps model/list catalog entries with reasoning variants", () => {
    const { models, defaultSlug } = buildMuseModelsFromCatalog([
      {
        modelId: "muse-large",
        displayLabel: "Muse Large",
        isDefault: true,
        reasoningEffortVariants: ["low", "high"],
        defaultReasoningEffort: "low",
      },
    ]);
    expect(defaultSlug).toBe("muse-large");
    expect(models[0]?.capabilities?.optionDescriptors?.[0]?.id).toBe("reasoningEffort");
  });

  it("maps live variants plus described tiers with labels", () => {
    const { models } = buildMuseModelsFromCatalog([
      {
        modelId: "muse-spark-1.3",
        displayLabel: "muse-spark-1.3",
        isDefault: false,
        variants: ["minimal", "low", "medium", "high", "xhigh", "max"],
        reasoningEffortVariants: [
          { tier: "high", description: "Thinks longer" },
          { tier: "max", description: "Deepest reasoning" },
        ],
        defaultReasoningEffort: "high",
      },
    ]);
    const descriptor = models[0]?.capabilities?.optionDescriptors?.[0];
    expect(descriptor?.id).toBe("reasoningEffort");
    expect(descriptor?.type).toBe("select");
    const options = (descriptor as { options: ReadonlyArray<{ id: string; label: string }> }).options;
    expect(options.map((option) => option.id)).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(options.find((option) => option.id === "high")).toMatchObject({
      label: "Thinks longer",
      isDefault: true,
    });
    expect(options.find((option) => option.id === "low")).toMatchObject({ label: "low" });
    expect((descriptor as { currentValue?: string }).currentValue).toBe("high");
  });

  it("reports no reasoning options when variants are unknown", () => {
    const { models } = buildMuseModelsFromCatalog([
      {
        modelId: "muse-spark-1.3",
        displayLabel: "muse-spark-1.3",
        variants: "unknown",
        defaultReasoningEffort: "high",
      },
    ]);
    expect(models[0]?.capabilities?.optionDescriptors).toEqual([]);
  });

  it("parses launch args without a shell", () => {
    expect(parseMuseLaunchArgs("")).toEqual([]);
    expect(parseMuseLaunchArgs("--foo bar  --baz")).toEqual(["--foo", "bar", "--baz"]);
  });
});
