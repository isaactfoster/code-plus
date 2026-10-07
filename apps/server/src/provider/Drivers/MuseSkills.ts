/**
 * MuseSkills — map Muse MSP `skill/list` catalog entries onto T3 provider
 * skills + slash commands.
 *
 * Muse entries look approximately like:
 *   { selector, displayName, description, argumentHint?, source, pluginId? }
 * Selectors may be plugin-qualified (`acme:deploy`); keep them verbatim so
 * native `skill` turn input parts retain Muse semantics.
 *
 * T3 requires a `path` on ServerProviderSkill; Muse skills are not files, so
 * use the synthetic `muse://skill/<selector>` convention (documented here).
 *
 * @module provider/Drivers/MuseSkills
 */
import type {
  MuseSettings,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { makeMuseHost, parseMuseLaunchArgs } from "../../orchestration-v2/Adapters/MuseHost.ts";

export interface MuseSkillCatalogEntry {
  readonly selector: string;
  readonly displayName: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly source: string;
  readonly pluginId?: string;
}

export function museSkillPath(selector: string): string {
  return `muse://skill/${selector}`;
}

export function mapMuseSkillEntry(entry: MuseSkillCatalogEntry): {
  readonly skill: ServerProviderSkill;
  readonly slashCommand: ServerProviderSlashCommand;
} {
  const selector = entry.selector.trim();
  return {
    skill: {
      name: selector,
      displayName: entry.displayName || selector,
      description: entry.description,
      shortDescription: entry.description,
      path: museSkillPath(selector),
      scope: entry.source,
      enabled: true,
      userInvocable: true,
    },
    slashCommand: {
      name: selector,
      description: entry.description,
      ...(entry.argumentHint ? { input: { hint: entry.argumentHint } } : {}),
    },
  };
}

export function mapMuseSkillCatalog(
  entries: ReadonlyArray<MuseSkillCatalogEntry>,
): {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
} {
  const seen = new Map<string, { skill: ServerProviderSkill; slashCommand: ServerProviderSlashCommand }>();
  for (const entry of entries) {
    if (!entry || typeof entry.selector !== "string" || !entry.selector.trim()) continue;
    const selector = entry.selector.trim();
    if (seen.has(selector)) continue;
    seen.set(selector, mapMuseSkillEntry({ ...entry, selector }));
  }
  const sorted = [...seen.values()].sort((a, b) => a.skill.name.localeCompare(b.skill.name));
  return {
    skills: sorted.map((entry) => entry.skill),
    slashCommands: sorted.map((entry) => entry.slashCommand),
  };
}

export function isMuseSkillCatalogEntry(value: unknown): value is MuseSkillCatalogEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.selector === "string" &&
    typeof record.displayName === "string" &&
    typeof record.description === "string" &&
    typeof record.source === "string"
  );
}

export class MuseSkillsProbeError extends Schema.TaggedError<MuseSkillsProbeError>()(
  "MuseSkillsProbeError",
  {
    stage: Schema.Literals(["session", "timeout", "decode"]),
    cwd: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    return `Muse skill discovery failed during ${this.stage}${location}.`;
  }
}

const MUSE_SKILLS_PROBE_TIMEOUT_MS = 15_000;

/**
 * Discover Muse skills for a workspace by opening an ephemeral MSP session
 * rooted at `cwd`, calling `skill/list { sessionId }`, and deleting the
 * session. Skill discovery is session-specific because workspace/plugin
 * state affects available skills. Workspace callers leave failures typed so
 * they are not cached; machine-level discovery recovers them to an empty
 * list.
 */
export const discoverMuseSkills = Effect.fn("discoverMuseSkills")(function* (
  museSettings: Pick<MuseSettings, "binaryPath" | "launchArgs">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string,
): Effect.fn.Return<
  {
    readonly skills: ReadonlyArray<ServerProviderSkill>;
    readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  },
  MuseSkillsProbeError
> {
  // Scoped internally (host lifetime, ephemeral session) so callers such as
  // `snapshotForCwd` get a Scope-free effect like other skill probes.
  const discovered = yield* Effect.scoped(
    Effect.gen(function* () {
      const host = yield* Effect.mapError(
        makeMuseHost({
          binaryPath: museSettings.binaryPath || "muse",
          launchArgs: parseMuseLaunchArgs(museSettings.launchArgs),
          cwd,
          env: environment,
          clientVersion: "0.0.0",
        }),
        (cause) => new MuseSkillsProbeError({ stage: "session", cwd, cause }),
      );
      yield* Effect.acquireRelease(Effect.succeed(host), (handle) => handle.close());
      const started = yield* Effect.mapError(
        host.command("session/start", { workspaceRoot: cwd }),
        (cause) => new MuseSkillsProbeError({ stage: "session", cwd, cause }),
      );
      const sessionId = String(started.sessionId as unknown as string);
      const listed = yield* Effect.mapError(
        Effect.ensuring(
          host.request("skill/list", { sessionId }),
          Effect.ignore(host.command("session/delete", { sessionId })),
        ),
        (cause) => new MuseSkillsProbeError({ stage: "session", cwd, cause }),
      );
      const raw = listed.skills ?? listed.entries;
      if (!Array.isArray(raw)) {
        return yield* new MuseSkillsProbeError({ stage: "decode", cwd });
      }
      const entries = raw.filter(isMuseSkillCatalogEntry);
      const catalog = mapMuseSkillCatalog(entries);
      return { skills: catalog.skills, slashCommands: catalog.slashCommands };
    }),
  ).pipe(Effect.timeoutOption(MUSE_SKILLS_PROBE_TIMEOUT_MS));
  if (Option.isNone(discovered)) {
    return yield* new MuseSkillsProbeError({ stage: "timeout", cwd });
  }
  return discovered.value;
});
