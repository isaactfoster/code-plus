import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { MuseSettings } from "@t3tools/contracts";

import {
  buildInitialMuseProviderSnapshot,
  buildMuseModelsFromCatalog,
  museModelsFromSettings,
} from "./MuseProvider.ts";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import { parseMuseLaunchArgs } from "../orchestration-v2/Adapters/MuseHost.ts";
import { Effect } from "effect";

const decodeMuseSettings = Schema.decodeSync(MuseSettings);

describe("Muse provider", () => {
  it("is registered as a built-in driver", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => String(driver.driverKind))).toContain("muse");
  });

  it("decodes defaults (disabled, muse binary)", () => {
    expect(decodeMuseSettings({})).toMatchObject({ enabled: false, binaryPath: "muse" });
  });

  it("builds a disabled initial snapshot", async () => {
    const snapshot = await Effect.runPromise(
      buildInitialMuseProviderSnapshot(decodeMuseSettings({ enabled: false })),
    );
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.models.length).toBeGreaterThan(0);
  });

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

  it("parses launch args without a shell", () => {
    expect(parseMuseLaunchArgs("")).toEqual([]);
    expect(parseMuseLaunchArgs("--foo bar  --baz")).toEqual(["--foo", "bar", "--baz"]);
  });
});
