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

function museCapabilitiesFromCatalogEntry(entry: Record<string, unknown>): ModelCapabilities {
  const variants = entry.reasoningEffortVariants;
  const ids: string[] = Array.isArray(variants)
    ? variants
        .map((variant) =>
          typeof variant === "string"
            ? variant
            : typeof variant === "object" && variant !== null
              ? String(
                  (variant as Record<string, unknown>).id ??
                    (variant as Record<string, unknown>).value ??
                    "",
                )
              : "",
        )
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    : [];
  if (ids.length === 0) return EMPTY_CAPABILITIES;
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
          label: id,
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
  | { readonly ok: true; readonly tier: string | undefined; readonly usage: Record<string, unknown> | undefined }
  | { readonly ok: false; readonly message: string };

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
    yield* Effect.ignore(handle.close());
    if (Option.isNone(usage) || !isMuseSubscriptionUsage(usage.value)) {
      return { ok: true as const, tier: undefined, usage: undefined };
    }
    const subscription = usage.value;
    return {
      ok: true as const,
      tier: typeof subscription.tier === "string" && subscription.tier.trim() ? subscription.tier.trim() : undefined,
      usage: subscription as unknown as Record<string, unknown>,
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
  return buildServerProvider({
    presentation: MUSE_PRESENTATION,
    enabled: true,
    checkedAt,
    models: fallbackModels,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "authenticated" },
      ...(usageRecord ? { usageLimits: museUsageToLimits(usageRecord) } : {}),
      ...(probed.tier ? { message: `Muse subscription (${probed.tier}).` } : {}),
    },
  });
});
