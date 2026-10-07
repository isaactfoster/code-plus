/**
 * MuseAdapterV2 — orchestration-v2 adapter for Meta Muse Code over MSP.
 *
 * Mapping:
 *   T3 provider instance → one Muse host (`muse serve` process)
 *   T3 provider thread   → one Muse MSP session (`session/start`/`resume`)
 *
 * Uses the low-level `spawnMspConnection` transport via MuseHost so T3 owns
 * the single raw notification dispatcher (usage, skills, approvals,
 * user-input, model, status). Streaming MSP item/turn events are mapped into
 * ProviderAdapterV2 events using native Muse IDs; reconnects resume pinned
 * session IDs rather than forking new sessions.
 *
 * @module orchestration-v2/Adapters/MuseAdapterV2
 */
import {
  defaultInstanceIdForDriver,
  MuseSettings,
  ProviderDriverKind,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderAdapter from "../ProviderAdapter.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import { turnScopedSelectionTransition } from "../ProviderSelectionTransition.ts";
import { makeMuseHost, parseMuseLaunchArgs, type MuseHost } from "./MuseHost.ts";
import { AcpProviderCapabilitiesV2 } from "./AcpAdapterV2.ts";

export const MUSE_PROVIDER = ProviderDriverKind.make("muse");
const MUSE_DRIVER_KIND = MUSE_PROVIDER;
export const MUSE_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(MUSE_DRIVER_KIND);
const DEFAULT_MUSE_SETTINGS = Schema.decodeSync(MuseSettings)({});

export const MuseProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: true,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: true,
    canForkFromTurn: false,
    exposesNativeThreadId: true,
  },
  turns: {
    ...AcpProviderCapabilitiesV2.turns,
    exposesNativeTurnId: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    ...AcpProviderCapabilitiesV2.streaming,
    streamsToolOutput: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  approvals: {
    ...AcpProviderCapabilitiesV2.approvals,
    supportsCommandApproval: true,
    approvalsHaveNativeRequestIds: true,
    approvalsCanOriginateFromSubagents: true,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  checkpointing: {
    ...AcpProviderCapabilitiesV2.checkpointing,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export type MuseAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | IdAllocator.IdAllocatorV2
  | ServerConfig.ServerConfig;

interface MuseThreadRecord {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly museSessionId: string;
  readonly activeTurnId: string | null;
}

function toTurnInputParts(
  message: ProviderAdapter.ProviderAdapterV2TurnMessage,
): ReadonlyArray<Record<string, unknown>> {
  const parts: Record<string, unknown>[] = [];
  if (message.text.trim()) {
    parts.push({ type: "text", text: message.text });
  }
  for (const attachment of message.attachments ?? []) {
    const image = attachment as unknown as Record<string, unknown>;
    if (typeof image.base64Data === "string" && typeof image.mediaType === "string") {
      parts.push({ type: "image", base64Data: image.base64Data, mediaType: image.mediaType });
    }
  }
  if (parts.length === 0) parts.push({ type: "text", text: "" });
  return parts;
}

export function makeMuseAdapterV2(options: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: MuseSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly host?: MuseHost;
}) {
  const { instanceId, environment, cwd, idAllocator } = options;
  return Effect.gen(function* () {
    const host =
      options.host ??
      (yield* makeMuseHost({
        binaryPath: options.settings.binaryPath || "muse",
        launchArgs: parseMuseLaunchArgs(options.settings.launchArgs),
        cwd,
        env: environment,
        clientVersion: "0.0.0",
      }));
    yield* Effect.acquireRelease(Effect.succeed(host), (handle) => handle.close());

    const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const threadsRef = yield* Ref.make(new Map<string, MuseThreadRecord>());

    const publish = (event: ProviderAdapter.ProviderAdapterV2Event) =>
      PubSub.publish(events, event).pipe(Effect.asVoid);

    // Single dispatcher fan-out: route host notifications to T3 events.
    // Skill/model/usage refreshes happen on snapshot/probe reads; approvals
    // and user-input fan out here so they surface without another prompt.
    host.onNotification((notification) => {
      const params = notification.params;
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
      if (notification.method !== "approval/requested" && notification.method !== "userInput/requested") {
        return;
      }
      if (!sessionId) return;
      void Effect.runFork(
        Effect.gen(function* () {
          const record = yield* Ref.get(threadsRef);
          const match = [...record.values()].find((entry) => entry.museSessionId === sessionId);
          if (!match) return;
          const createdAt = yield* DateTime.now;
          if (notification.method === "approval/requested") {
            yield* publish({
              type: "runtime_request.updated",
              driver: MUSE_DRIVER_KIND,
              threadId: match.providerThread.appThreadId ?? undefined,
              runtimeRequest: {
                id: `muse-approval-${String(params.approvalId ?? Date.now())}` as never,
                driver: MUSE_DRIVER_KIND,
                providerThreadId: match.providerThread.id,
                kind: "approval_request",
                status: "pending",
                nativeRequestId: String(params.approvalId ?? ""),
                title: `Approve ${String(params.toolName ?? "tool")}`,
                detail: String(params.rawArgs ?? ""),
                createdAt,
                updatedAt: createdAt,
              } as never,
            });
          } else {
            yield* publish({
              type: "runtime_request.updated",
              driver: MUSE_DRIVER_KIND,
              threadId: match.providerThread.appThreadId ?? undefined,
              runtimeRequest: {
                id: `muse-input-${String(params.requestId ?? params.promptId ?? Date.now())}` as never,
                driver: MUSE_DRIVER_KIND,
                providerThreadId: match.providerThread.id,
                kind: "user_input_request",
                status: "pending",
                nativeRequestId: String(params.requestId ?? params.promptId ?? ""),
                title: "Muse needs input",
                detail: String(params.prompt ?? params.question ?? ""),
                createdAt,
                updatedAt: createdAt,
              } as never,
            });
          }
        }).pipe(Effect.ignore),
      );
    });

    const rememberThread = (record: MuseThreadRecord) =>
      Ref.update(threadsRef, (current) => new Map(current).set(record.providerThread.id, record));

    const getThreadRecord = (providerThreadId: string) =>
      Ref.get(threadsRef).pipe(
        Effect.flatMap((current) => {
          const record = current.get(providerThreadId);
          return record
            ? Effect.succeed(record)
            : Effect.fail(
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver: MUSE_DRIVER_KIND,
                  providerSessionId: "" as never,
                  providerThreadId: providerThreadId as never,
                }),
              );
        }),
      );

    const applyModelSelection = (museSessionId: string, modelSelection: ModelSelection) =>
      Effect.gen(function* () {
        const requested = modelSelection.model?.trim();
        if (!requested || requested === "default") return;
        yield* host.command("session/setModel", { sessionId: museSessionId, modelId: requested }).pipe(
          Effect.ignore,
        );
        const effort = getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
        if (effort) {
          yield* host
            .command("session/setReasoningEffort", { sessionId: museSessionId, effort })
            .pipe(Effect.ignore);
        }
      });

    const ensureMuseSession = (
      input: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
    ): Effect.Effect<MuseThreadRecord, ProviderAdapter.ProviderAdapterV2Error> =>
      Effect.gen(function* () {
        const existing = input.existingProviderThread;
        const resumeNativeId = existing?.nativeThreadRef?.nativeId;
        const now = yield* DateTime.now;
        if (resumeNativeId) {
          const resumed = yield* host
            .command("session/resume", { sessionId: resumeNativeId })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterEnsureThreadError({
                    driver: MUSE_DRIVER_KIND,
                    threadId: input.threadId,
                    cause,
                  }),
              ),
            );
          const museSessionId = String((resumed.sessionId ?? resumeNativeId) as unknown as string);
          yield* host.trackSession(museSessionId).pipe(Effect.ignore);
          const providerThread: OrchestrationV2ProviderThread = existing
            ? { ...existing, status: "idle", updatedAt: now }
            : {
                id: idAllocator.derive.providerThread({
                  driver: MUSE_PROVIDER,
                  nativeThreadId: museSessionId,
                }),
                driver: MUSE_DRIVER_KIND,
                providerInstanceId: instanceId,
                providerSessionId: input.providerSessionId ?? null,
                appThreadId: input.threadId,
                ownerNodeId: null,
                nativeThreadRef: { kind: "muse-session", nativeId: museSessionId } as never,
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              };
          const record: MuseThreadRecord = { providerThread, museSessionId, activeTurnId: null };
          yield* rememberThread(record);
          yield* publish({ type: "provider_thread.updated", driver: MUSE_DRIVER_KIND, providerThread });
          yield* applyModelSelection(museSessionId, input.modelSelection).pipe(Effect.ignore);
          return record;
        }
        const started = yield* host
          .command("session/start", { workspaceRoot: input.runtimePolicy.cwd ?? cwd })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: MUSE_DRIVER_KIND,
                  threadId: input.threadId,
                  cause,
                }),
            ),
          );
        const museSessionId = String(started.sessionId as unknown as string);
        yield* host.trackSession(museSessionId).pipe(Effect.ignore);
        const providerThread: OrchestrationV2ProviderThread = {
          id: idAllocator.derive.providerThread({ driver: MUSE_PROVIDER, nativeThreadId: museSessionId }),
          driver: MUSE_DRIVER_KIND,
          providerInstanceId: instanceId,
          providerSessionId: input.providerSessionId ?? null,
          appThreadId: input.threadId,
          ownerNodeId: null,
          nativeThreadRef: { kind: "muse-session", nativeId: museSessionId } as never,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        };
        const record: MuseThreadRecord = { providerThread, museSessionId, activeTurnId: null };
        yield* rememberThread(record);
        yield* publish({ type: "provider_thread.updated", driver: MUSE_DRIVER_KIND, providerThread });
        yield* applyModelSelection(museSessionId, input.modelSelection).pipe(Effect.ignore);
        return record;
      });

    const shape: ProviderAdapter.ProviderAdapterV2Shape = {
      instanceId,
      driver: MUSE_DRIVER_KIND,
      getCapabilities: () => Effect.succeed(MuseProviderCapabilitiesV2),
      planSelectionTransition: (_input) => Effect.succeed(turnScopedSelectionTransition()),
      openSession: (input) =>
        Effect.gen(function* () {
          const sessionEvents = Stream.fromPubSub(events);
          const now = yield* DateTime.now;
          const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
            instanceId,
            driver: MUSE_DRIVER_KIND,
            providerSessionId: input.providerSessionId,
            providerSession: {
              id: input.providerSessionId,
              driver: MUSE_DRIVER_KIND,
              providerInstanceId: instanceId,
              status: "ready",
              createdAt: now,
              updatedAt: now,
            } as never,
            events: sessionEvents,
            ensureThread: (threadInput) =>
              ensureMuseSession(threadInput).pipe(Effect.map((record) => record.providerThread)),
            resumeThread: (resumeInput) =>
              Effect.gen(function* () {
                const record = yield* getThreadRecord(resumeInput.providerThread.id);
                yield* host.command("session/resume", { sessionId: record.museSessionId }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapter.ProviderAdapterResumeThreadError({
                        driver: MUSE_DRIVER_KIND,
                        providerSessionId: input.providerSessionId,
                        providerThreadId: resumeInput.providerThread.id,
                        cause,
                      }),
                  ),
                );
                if (resumeInput.modelSelection) {
                  yield* applyModelSelection(record.museSessionId, resumeInput.modelSelection).pipe(
                    Effect.ignore,
                  );
                }
                const resumedAt = yield* DateTime.now;
                const providerThread: OrchestrationV2ProviderThread = {
                  ...resumeInput.providerThread,
                  status: "idle",
                  updatedAt: resumedAt,
                };
                yield* rememberThread({ ...record, providerThread });
                return providerThread;
              }),
            startTurn: (turnInput) =>
              Effect.gen(function* () {
                const record = yield* getThreadRecord(turnInput.providerThread.id);
                yield* applyModelSelection(record.museSessionId, turnInput.modelSelection).pipe(
                  Effect.ignore,
                );
                yield* host
                  .command("turn/start", {
                    sessionId: record.museSessionId,
                    input: toTurnInputParts(turnInput.message),
                  })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new ProviderAdapter.ProviderAdapterTurnStartError({
                          driver: MUSE_DRIVER_KIND,
                          threadId: turnInput.threadId,
                          providerThreadId: turnInput.providerThread.id,
                          runId: turnInput.runId,
                          cause,
                        }),
                    ),
                  );
                yield* rememberThread({ ...record, activeTurnId: `muse-turn-${String(turnInput.runId)}` });
              }),
            steerTurn: (steerInput) =>
              Effect.gen(function* () {
                const record = yield* getThreadRecord(steerInput.providerThread.id);
                yield* host
                  .command("turn/steer", {
                    sessionId: record.museSessionId,
                    input: toTurnInputParts(steerInput.message),
                  })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new ProviderAdapter.ProviderAdapterSteerRunError({
                          driver: MUSE_DRIVER_KIND,
                          providerThreadId: steerInput.providerThread.id,
                          providerTurnId: steerInput.providerTurnId,
                          cause,
                        }),
                    ),
                  );
              }),
            interruptTurn: (interruptInput) =>
              Effect.gen(function* () {
                const record = yield* getThreadRecord(interruptInput.providerThread.id);
                yield* host
                  .command("turn/interrupt", { sessionId: record.museSessionId })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new ProviderAdapter.ProviderAdapterInterruptError({
                          driver: MUSE_DRIVER_KIND,
                          providerThreadId: interruptInput.providerThread.id,
                          providerTurnId: interruptInput.providerTurnId,
                          cause,
                        }),
                    ),
                  );
                yield* rememberThread({ ...record, activeTurnId: null });
              }),
            respondToRuntimeRequest: (response) =>
              Effect.gen(function* () {
                const decision = response.decision as unknown as Record<string, unknown> | undefined;
                const answers = response.answers as unknown as Record<string, unknown> | undefined;
                if (decision !== undefined) {
                  const approvalId = String(
                    (decision.approvalId ?? decision.requestId ?? "") as unknown as string,
                  );
                  const choiceId = String(
                    (decision.choiceId ?? decision.decision ?? "denied") as unknown as string,
                  );
                  yield* host
                    .command("approval/decide", {
                      approvalId,
                      choiceId,
                      commandId: hostCommandId(),
                      requirementId: (decision.requirementId ?? {
                        approvalId,
                        sourceIndex: 0,
                      }) as Record<string, unknown>,
                      sessionId: String((decision.sessionId ?? "") as unknown as string),
                    })
                    .pipe(Effect.ignore);
                  return;
                }
                if (answers !== undefined) {
                  const requestId = String(
                    (answers.requestId ?? answers.promptId ?? "") as unknown as string,
                  );
                  yield* host
                    .command("userInput/answer", {
                      requestId,
                      commandId: hostCommandId(),
                      sessionId: String((answers.sessionId ?? "") as unknown as string),
                      answer: answers,
                    })
                    .pipe(Effect.ignore);
                }
              }),
            readThreadSnapshot: (snapshotInput) =>
              Effect.gen(function* () {
                const record = yield* getThreadRecord(snapshotInput.providerThread.id);
                yield* host.request("session/read", { sessionId: record.museSessionId }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                        driver: MUSE_DRIVER_KIND,
                        providerThreadId: snapshotInput.providerThread.id,
                        cause,
                      }),
                  ),
                );
                return {
                  providerThread: record.providerThread,
                  providerTurns: [],
                  messages: [],
                  runtimeRequests: [],
                  providerPayload: { museSessionId: record.museSessionId },
                };
              }),
            rollbackThread: (rollbackInput) =>
              Effect.fail(
                new ProviderAdapter.ProviderAdapterRollbackThreadError({
                  driver: MUSE_DRIVER_KIND,
                  providerThreadId: rollbackInput.providerThread.id,
                  cause: makeProviderFailure({
                    cause: "Muse MSP has no rollback/rewind primitive.",
                    class: "provider_error",
                  }),
                }),
              ),
            forkThread: (forkInput) =>
              Effect.gen(function* () {
                const record = yield* getThreadRecord(forkInput.sourceProviderThread.id);
                const forked = yield* host
                  .command("session/fork", { sessionId: record.museSessionId })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new ProviderAdapter.ProviderAdapterForkThreadError({
                          driver: MUSE_DRIVER_KIND,
                          providerThreadId: forkInput.sourceProviderThread.id,
                          cause,
                        }),
                    ),
                  );
                const museSessionId = String(forked.sessionId as unknown as string);
                yield* host.trackSession(museSessionId).pipe(Effect.ignore);
                const forkedAt = yield* DateTime.now;
                const providerThread: OrchestrationV2ProviderThread = {
                  ...forkInput.sourceProviderThread,
                  id: idAllocator.derive.providerThread({
                    driver: MUSE_PROVIDER,
                    nativeThreadId: museSessionId,
                  }),
                  appThreadId: forkInput.targetThreadId,
                  nativeThreadRef: { kind: "muse-session", nativeId: museSessionId } as never,
                  forkedFrom: { providerThreadId: forkInput.sourceProviderThread.id },
                  status: "idle",
                  updatedAt: forkedAt,
                };
                yield* rememberThread({ providerThread, museSessionId, activeTurnId: null });
                return providerThread;
              }),
            compactThread: (compactInput) =>
              Effect.gen(function* () {
                const record = yield* getThreadRecord(compactInput.providerThread.id);
                yield* host.command("session/compact", { sessionId: record.museSessionId }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapter.ProviderAdapterTurnStartError({
                        driver: MUSE_DRIVER_KIND,
                        threadId: compactInput.threadId,
                        providerThreadId: compactInput.providerThread.id,
                        runId: compactInput.runId,
                        cause,
                      }),
                  ),
                );
              }),
            unloadThread: (unloadInput) =>
              Ref.update(threadsRef, (current) => {
                const next = new Map(current);
                next.delete(unloadInput.providerThread.id);
                return next;
              }),
          };
          void input;
          return runtime;
        }),
    };
    return shape;
  });
}

function hostCommandId(): string {
  return `t3-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

export const MuseAdapterV2Driver: ProviderAdapterDriver<MuseSettings, MuseAdapterV2DriverEnv> = {
  driverKind: MUSE_DRIVER_KIND,
  configSchema: MuseSettings,
  defaultConfig: (): MuseSettings => DEFAULT_MUSE_SETTINGS,
  create: (input: ProviderAdapterDriverCreateInput<MuseSettings>) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      return yield* makeMuseAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment),
        cwd: serverConfig.cwd,
        idAllocator,
      });
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterDriverCreateError({
            driver: MUSE_DRIVER_KIND,
            instanceId: input.instanceId,
            detail: "Failed to create Muse adapter.",
            cause,
          }),
      ),
    ),
};
