/**
 * MuseHost — managed `muse serve` lifecycle over the low-level MSP connection.
 *
 * One T3 Muse provider instance owns one host process. T3 provider threads
 * map to Muse MSP sessions (`session/start` / `session/resume`); we never
 * spawn one process per prompt.
 *
 * We deliberately use `spawnMspConnection` (not `MuseClient.spawn`) so T3
 * owns the single raw notification dispatcher. That dispatcher fans events
 * out to session subscribers, usage updates, skill invalidation, approvals,
 * user-input requests, model updates, and status updates.
 *
 * @module orchestration-v2/Adapters/MuseHost
 */
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

export const MUSE_MSP_CLIENT_NAME = "t3code";

export interface MuseHostOptions {
  readonly binaryPath: string;
  readonly launchArgs: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly clientVersion: string;
}

export interface MuseNotification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export type MuseNotificationListener = (notification: MuseNotification) => void;

export class MuseHostError extends Schema.TaggedError<MuseHostError>()("MuseHostError", {
  stage: Schema.Literals([
    "spawn",
    "handshake",
    "command",
    "request",
    "session",
    "turn",
    "usage",
    "models",
    "skills",
    "shutdown",
  ]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Muse host ${this.stage} failed: ${this.detail}`;
  }
}

interface MuseHostState {
  readonly listeners: Set<MuseNotificationListener>;
  readonly sessions: Set<string>;
  readonly degraded: boolean;
  readonly degradeReason: string | undefined;
  readonly initializeResult: Record<string, unknown> | undefined;
}

/** Parse `launchArgs` free text into argv (space-split, no shell). */
export function parseMuseLaunchArgs(launchArgs: string): ReadonlyArray<string> {
  const trimmed = launchArgs.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/).filter((part) => part.length > 0);
}

export function notificationSessionId(params: Record<string, unknown>): string | undefined {
  const sessionId = params.sessionId;
  return typeof sessionId === "string" ? sessionId : undefined;
}

export interface MuseTransportHandle {
  readonly connectionDescription: string;
  readonly initializeResult?: Record<string, unknown> | undefined;
  readonly command: (
    method: string,
    params: Record<string, unknown>,
  ) => Effect.Effect<Record<string, unknown>, MuseHostError>;
  readonly request: (
    method: string,
    params?: Record<string, unknown>,
  ) => Effect.Effect<Record<string, unknown>, MuseHostError>;
  readonly close: Effect.Effect<void, MuseHostError>;
}

export interface MuseHost {
  /** Register a listener on the single dispatcher. Returns an unsubscribe fn. */
  readonly onNotification: (listener: MuseNotificationListener) => () => void;
  /** Send an MSP command (e.g. `session/start`, `turn/start`). */
  readonly command: (
    method: string,
    params: Record<string, unknown>,
  ) => Effect.Effect<Record<string, unknown>, MuseHostError>;
  /** Send an MSP log-fold read (e.g. `usage/read`, `model/list`, `skill/list`). */
  readonly request: (
    method: string,
    params?: Record<string, unknown>,
  ) => Effect.Effect<Record<string, unknown>, MuseHostError>;
  readonly trackSession: (sessionId: string) => Effect.Effect<void>;
  readonly untrackSession: (sessionId: string) => Effect.Effect<void>;
  readonly trackedSessions: () => Effect.Effect<ReadonlyArray<string>>;
  readonly markDegraded: (reason: string) => Effect.Effect<void>;
  readonly isDegraded: () => Effect.Effect<{ readonly degraded: boolean; readonly reason: string | undefined }>;
  readonly initializeResult: () => Effect.Effect<Record<string, unknown> | undefined>;
  readonly close: () => Effect.Effect<void>;
}

/**
 * Create a Muse host. The `serve` process is spawned lazily on first command
 * so provider probing without a binary stays fast and typed.
 *
 * The transport layer is injected so tests can run without a real binary.
 */
export const makeMuseHost = Effect.fn("makeMuseHost")(function* (
  options: MuseHostOptions,
  transport?: {
    readonly spawn: (
      options: MuseHostOptions,
      dispatch: (notification: MuseNotification) => void,
    ) => Effect.Effect<MuseTransportHandle, MuseHostError>;
  },
) {
  const state = yield* Ref.make<MuseHostState>({
    listeners: new Set(),
    sessions: new Set(),
    degraded: false,
    degradeReason: undefined,
    initializeResult: undefined,
  });
  const handleRef = yield* Ref.make<MuseTransportHandle | undefined>(undefined);

  const dispatch = (notification: MuseNotification) => {
    const snapshot = Effect.runSync(Ref.get(state));
    for (const listener of snapshot.listeners) {
      try {
        listener(notification);
      } catch {
        // Listener errors must not break the single dispatcher.
      }
    }
  };

  const ensureHandle: Effect.Effect<MuseTransportHandle, MuseHostError> = Effect.gen(function* () {
    const existing = yield* Ref.get(handleRef);
    if (existing) return existing;
    const spawner = transport?.spawn ?? spawnMuseServeProcess;
    const handle = yield* spawner(options, dispatch);
    yield* Ref.update(state, (current) => ({ ...current, initializeResult: handle.initializeResult }));
    yield* Ref.set(handleRef, handle);
    return handle;
  });

  const onNotification = (listener: MuseNotificationListener): (() => void) => {
    const current = Effect.runSync(Ref.get(state));
    current.listeners.add(listener);
    return () => {
      const snapshot = Effect.runSync(Ref.get(state));
      snapshot.listeners.delete(listener);
    };
  };

  return {
    onNotification,
    command: (method, params) =>
      Effect.gen(function* () {
        const handle = yield* ensureHandle;
        return yield* handle.command(method, params);
      }),
    request: (method, params) =>
      Effect.gen(function* () {
        const handle = yield* ensureHandle;
        return yield* handle.request(method, params);
      }),
    trackSession: (sessionId) =>
      Ref.update(state, (current) => ({
        ...current,
        sessions: new Set(current.sessions).add(sessionId),
      })),
    untrackSession: (sessionId) =>
      Ref.update(state, (current) => {
        const sessions = new Set(current.sessions);
        sessions.delete(sessionId);
        return { ...current, sessions };
      }),
    trackedSessions: () => Ref.get(state).pipe(Effect.map((current) => [...current.sessions])),
    markDegraded: (reason) =>
      Ref.update(state, (current) => ({ ...current, degraded: true, degradeReason: reason })),
    isDegraded: () =>
      Ref.get(state).pipe(
        Effect.map((current) => ({ degraded: current.degraded, reason: current.degradeReason })),
      ),
    initializeResult: () => Ref.get(state).pipe(Effect.map((current) => current.initializeResult)),
    close: () =>
      Effect.gen(function* () {
        const handle = yield* Ref.getAndSet(handleRef, undefined);
        if (handle) yield* handle.close.pipe(Effect.ignore);
      }),
  } satisfies MuseHost;
});

/**
 * Production transport: spawn `muse serve` and run the MSP initialize
 * handshake via the official `@muse-code/sdk` low-level API. Dynamically
 * imported so unit tests and installs without the SDK still run until a host
 * is actually needed.
 */
const spawnMuseServeProcess = (
  options: MuseHostOptions,
  dispatch: (notification: MuseNotification) => void,
): Effect.Effect<MuseTransportHandle, MuseHostError> =>
  Effect.gen(function* () {
    let sdk: typeof import("@muse-code/sdk");
    try {
      sdk = yield* Effect.promise(() => import("@muse-code/sdk"));
    } catch (cause) {
      return yield* new MuseHostError({
        stage: "spawn",
        detail: "The @muse-code/sdk package is not installed.",
        cause,
      });
    }
    const handshake = sdk.spawnMspConnection({
      command: options.binaryPath,
      args: ["serve", ...options.launchArgs],
      cwd: options.cwd,
      env: options.env,
    });
    handshake.onNotification((notification) => {
      dispatch({
        method: notification.method,
        params: (notification.params ?? {}) as Record<string, unknown>,
      });
    });
    handshake.onServerRequest((_request) => Promise.resolve({}));
    let spawned: import("@muse-code/sdk").SpawnedMspConnection;
    try {
      spawned = yield* Effect.promise(() =>
        handshake.initialize({
          clientInfo: { name: MUSE_MSP_CLIENT_NAME, version: options.clientVersion },
          capabilities: { userInputDialogs: true },
        }),
      );
    } catch (cause) {
      yield* Effect.promise(() => handshake.close()).pipe(Effect.ignore);
      return yield* new MuseHostError({
        stage: "handshake",
        detail: `\`muse serve\` handshake failed. Is the Muse CLI installed and authenticated? (${describeSpawnCause(cause)})`,
        cause,
      });
    }
    const connection = spawned.connection;
    const initializeResult = { ...(spawned.initializeResult as unknown as Record<string, unknown>) };
    return {
      connectionDescription: `${options.binaryPath} serve`,
      initializeResult,
      command: (method, params) =>
        Effect.promise(() => connection.command(method, params)).pipe(
          Effect.map((result) => ({ ...((result ?? {}) as Record<string, unknown>) })),
          Effect.mapError(
            (cause) =>
              new MuseHostError({ stage: "command", detail: `Muse command ${method} failed.`, cause }),
          ),
        ),
      request: (method, params) =>
        Effect.promise(() => connection.request(method, params)).pipe(
          Effect.map((result) => ({ ...((result ?? {}) as Record<string, unknown>) })),
          Effect.mapError(
            (cause) =>
              new MuseHostError({ stage: "request", detail: `Muse request ${method} failed.`, cause }),
          ),
        ),
      close: Effect.promise(() => spawned.close()).pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) => new MuseHostError({ stage: "shutdown", detail: "Failed to stop muse serve.", cause }),
        ),
      ),
    } satisfies MuseTransportHandle;
  });

function describeSpawnCause(cause: unknown): string {
  if (cause instanceof Error) {
    const message = cause.message.trim();
    if (/ENOENT/i.test(message)) return "muse binary not found";
    return message.slice(0, 200);
  }
  return String(cause).slice(0, 200);
}
