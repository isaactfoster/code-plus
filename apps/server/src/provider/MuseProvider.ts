/**
 * MuseProvider — snapshot + probing for the Muse (`muse serve`/MSP) driver.
 *
 * Probing determines: binary present, version, MSP initialize success, and
 * whether `usage/read` answers (auth/config). `muse` uses its own installed
 * CLI/account state; T3 invents no Meta API env vars.
 *
 * @module provider/MuseProvider
 */
import type {
  CustomModelSetting,
  ModelCapabilities,
  MuseSettings,
  ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { makeMuseHost, parseMuseLaunchArgs, type MuseHost } from "../orchestration-v2/Adapters/MuseHost.ts";
import { isMuseSubscriptionUsage, museUsageToLimits } from "./museUsageLimits.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "./providerSnapshot.ts";

const MUSE_PRESENTATION = {
  displayName: "Muse",
  supportsConversationRollback: false,
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["full-access", "approval-required"] as const,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const HANDSHAKE_PROBE_TIMEOUT_MS = 12_000;

export const MUSE_DEFAULT_MODEL_SLUG = "default";

const MUSE_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  { slug: MUSE_DEFAULT_MODEL_SLUG, name: "Muse (auto)", isCustom: false, capabilities: EMPTY_CAPABILITIES },
];

export function museModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(MUSE_BUILT_IN_MODELS, customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildInitialMuseProviderSnapshot(
  museSettings: MuseSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = museModelsFromSettings(museSettings.customModels);
    if (!museSettings.enabled) {
      return buildServerProvider({
        presentation: MUSE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Muse is disabled in T3 Code settings.",
        },
      });
    }
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Muse CLI availability...",
      },
    });
  });
}

export function buildMuseModelsFromCatalog(entries: ReadonlyArray<Record<string, unknown>>): {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly defaultSlug: string | undefined;
} {
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  let defaultSlug: string | undefined;
  for (const entry of entries) {
    const modelId = typeof entry.modelId === "string" ? entry.modelId.trim() : "";
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    const label =
      typeof entry.displayLabel === "string" && entry.displayLabel.trim()
        ? entry.displayLabel.trim()
        : modelId;
    const isDefault = entry.isDefault === true;
    if (isDefault && defaultSlug === undefined) defaultSlug = modelId;
    models.push({
      slug: modelId,
      name: label,
      isCustom: false,
      ...(isDefault ? { isDefault: true } : {}),
      capabilities: museCapabilitiesFromCatalogEntry(entry),
    });
  }
  return { models, defaultSlug };
}

function museDescribedEffortLabels(entry: Record<string, unknown>): Map<string, string> {
  const labels = new Map<string, string>();
  const described = entry.reasoningEffortVariants;
  if (!Array.isArray(described)) return labels;
  for (const variant of described) {
    if (typeof variant === "string") {
      const tier = variant.trim();
      if (tier && !labels.has(tier)) labels.set(tier, tier);
      continue;
    }
    if (typeof variant === "object" && variant !== null) {
      const record = variant as Record<string, unknown>;
      const tierRaw = record.tier ?? record.id ?? record.value;
      const tier = typeof tierRaw === "string" ? tierRaw.trim() : "";
      if (!tier) continue;
      const labelRaw = record.description ?? record.label;
      const label = typeof labelRaw === "string" && labelRaw.trim() ? labelRaw.trim() : tier;
      if (!labels.has(tier)) labels.set(tier, label);
    }
  }
  return labels;
}

function museEffortIdsFromCatalogEntry(entry: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed && !ids.includes(trimmed)) ids.push(trimmed);
  };
  // `variants` is the complete ordered selectable effort set on current
  // hosts; it carries the explicit "unknown" scalar when the host cannot
  // say. Older hosts only sent string rows under `reasoningEffortVariants`.
  const variants = entry.variants;
  if (Array.isArray(variants)) {
    for (const variant of variants) push(variant);
    if (ids.length > 0) return ids;
  } else if (variants === "unknown") {
    return [];
  }
  const legacy = entry.reasoningEffortVariants;
  if (Array.isArray(legacy)) {
    for (const variant of legacy) {
      if (typeof variant === "string") push(variant);
    }
  }
  return ids;
}

function museCapabilitiesFromCatalogEntry(entry: Record<string, unknown>): ModelCapabilities {
  const ids = museEffortIdsFromCatalogEntry(entry);
  if (ids.length === 0) return EMPTY_CAPABILITIES;
  const labels = museDescribedEffortLabels(entry);
  const defaultEffort =
    typeof entry.defaultReasoningEffort === "string" && ids.includes(entry.defaultReasoningEffort)
      ? entry.defaultReasoningEffort
      : undefined;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: ids.map((id) => ({
          id,
          label: labels.get(id) ?? id,
          ...(id === defaultEffort ? { isDefault: true } : {}),
        })),
        ...(defaultEffort ? { currentValue: defaultEffort } : {}),
      },
    ],
  });
}

function looksLikeAuthError(message: string): boolean {
  return /auth|login|sign-?in|unauthori[sz]ed|forbidden|token|credential/i.test(message);
}

type MuseHandshakeProbeResult =
  | {
      readonly ok: true;
      readonly tier: string | undefined;
      readonly usage: Record<string, unknown> | undefined;
      readonly catalog: ReadonlyArray<Record<string, unknown>>;
    }
  | { readonly ok: false; readonly message: string };

function museCatalogEntriesFromModelList(value: Record<string, unknown> | undefined): ReadonlyArray<Record<string, unknown>> {
  const models = value?.models;
  if (!Array.isArray(models)) return [];
  return models.filter(
    (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
  );
}

function runMuseHandshakeProbe(
  binaryPath: string,
  launchArgs: string,
  environment: NodeJS.ProcessEnv,
  cwd: string | undefined,
): Effect.Effect<MuseHandshakeProbeResult, never, never> {
  return Effect.gen(function* () {
    const handle: MuseHost = yield* makeMuseHost({
      binaryPath,
      launchArgs: parseMuseLaunchArgs(launchArgs),
      cwd: cwd ?? process.cwd(),
      env: environment,
      clientVersion: "0.0.0",
    });
    const usage = yield* Effect.option(
      Effect.mapError(handle.request("usage/read", undefined), (cause) => cause.message),
    );
    const catalog = yield* Effect.option(
      Effect.mapError(handle.request("model/list", undefined), (cause) => cause.message),
    );
    yield* Effect.ignore(handle.close());
    const entries = Option.isNone(catalog) ? [] : museCatalogEntriesFromModelList(catalog.value);
    if (Option.isNone(usage) || !isMuseSubscriptionUsage(usage.value)) {
      return { ok: true as const, tier: undefined, usage: undefined, catalog: entries };
    }
    const subscription = usage.value;
    return {
      ok: true as const,
      tier: typeof subscription.tier === "string" && subscription.tier.trim() ? subscription.tier.trim() : undefined,
      usage: subscription as unknown as Record<string, unknown>,
      catalog: entries,
    };
  }).pipe(
    Effect.catch(() => Effect.succeed({ ok: false as const, message: "Muse serve probe failed." })),
  );
}

export const checkMuseProviderStatus = Effect.fn("checkMuseProviderStatus")(function* (
  museSettings: MuseSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = museModelsFromSettings(museSettings.customModels);
  const binaryPath = museSettings.binaryPath || "muse";

  if (!museSettings.enabled) {
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Muse is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(binaryPath, ["--version"], { env: environment });
    return yield* spawnAndCollect(
      binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(cwd ? { cwd } : {}),
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "`muse` was not found. Install the Muse CLI, then set the binary path in T3 settings."
          : "Failed to run `muse --version`.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "`muse --version` timed out. The first launch may be provisioning the CLI.",
      },
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Muse CLI is installed but `muse --version` failed.",
      },
    });
  }

  // MSP handshake probe: verifies `muse serve` starts and answers initialize.
  // The probe never fails: transport/handshake/usage errors become
  // `{ ok: false }` so `timeoutOption` only distinguishes timeout from answer.
  const handshake = yield* runMuseHandshakeProbe(binaryPath, museSettings.launchArgs, environment, cwd).pipe(
    Effect.timeoutOption(HANDSHAKE_PROBE_TIMEOUT_MS),
  );

  if (Option.isNone(handshake)) {
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: "`muse serve` did not answer in time. The first launch may be provisioning.",
      },
    });
  }
  const probed = handshake.value;
  if (!probed.ok) {
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: looksLikeAuthError(probed.message) ? "unauthenticated" : "unknown" },
        message: probed.message,
      },
    });
  }
  const usageRecord =
    probed.usage !== undefined && isMuseSubscriptionUsage(probed.usage) ? probed.usage : undefined;
  // `usage/read` omits `usage` when the host has observed nothing, so no
  // usage payload means auth is unconfirmed rather than authenticated.
  const { models: catalogModels } = buildMuseModelsFromCatalog(probed.catalog);
  const models =
    catalogModels.length > 0
      ? providerModelsFromSettings(catalogModels, museSettings.customModels ?? [], EMPTY_CAPABILITIES)
      : fallbackModels;
  return buildServerProvider({
    presentation: MUSE_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: usageRecord ? "authenticated" : "unknown" },
      ...(usageRecord ? { usageLimits: museUsageToLimits(usageRecord) } : {}),
      ...(probed.tier
        ? { message: `Muse subscription (${probed.tier}).` }
        : {
            message:
              "Muse serve answered but reported no subscription usage. Complete Muse's login if you are not signed in.",
          }),
    },
  });
});
