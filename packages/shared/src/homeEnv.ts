/**
 * homeEnv — Code Plus home directory identity.
 *
 * `CODEPLUS_HOME` is the primary environment override; the legacy
 * `T3CODE_HOME` is still honored as a fallback so existing installs keep
 * working without edits. The default home is `~/.code-plus`, separate from
 * upstream T3 Code's `~/.t3` so the two installs never share state.
 *
 * @module homeEnv
 */

/** Primary environment variable for the Code Plus home directory. */
export const HOME_ENV_NAME = "CODEPLUS_HOME" as const;
/** Legacy upstream variable, honored as a fallback. */
export const LEGACY_HOME_ENV_NAME = "T3CODE_HOME" as const;
/** Default home directory name under the user's home. */
export const DEFAULT_HOME_DIR_NAME = ".code-plus" as const;

/**
 * Read the home override from the environment: `CODEPLUS_HOME` wins,
 * `T3CODE_HOME` is the legacy fallback. Blank values count as unset.
 */
export const readHomeEnv = (
  env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
): string | undefined => {
  const primary = env[HOME_ENV_NAME]?.trim();
  if (primary) return primary;
  const legacy = env[LEGACY_HOME_ENV_NAME]?.trim();
  return legacy || undefined;
};
