/**
 * MuseTextGeneration — helper text generation (commit messages, PR content,
 * branch names, thread titles) via an isolated short-lived Muse MSP session.
 *
 * Uses the same `muse serve` host infrastructure as the orchestration
 * adapter, never `muse exec` per prompt. Helper sessions are created per
 * request and deleted afterwards so they stay isolated from user threads.
 *
 * @module textGeneration/MuseTextGeneration
 */
import type { MuseSettings } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { makeMuseHost, parseMuseLaunchArgs } from "../orchestration-v2/Adapters/MuseHost.ts";
import * as TextGenerationOperations from "./TextGenerationOperations.ts";
import type * as TextGeneration from "./TextGeneration.ts";

const MUSE_TEXT_TIMEOUT_MS = 120_000;
const isTextGenerationError = Schema.is(TextGenerationError);

export const makeMuseTextGeneration = (
  museSettings: MuseSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Effect.Effect<TextGeneration.TextGeneration["Service"]> =>
  Effect.succeed(
    TextGenerationOperations.fromRunner("MuseTextGeneration", (request) =>
      runMuseTextRequest(museSettings, environment, cwd, request),
    ),
  );

function runMuseTextRequest<S extends Schema.Top>(
  museSettings: MuseSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  request: TextGenerationOperations.Request<S>,
): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> {
  return Effect.gen(function* () {
    const host = yield* makeMuseHost({
      binaryPath: museSettings.binaryPath || "muse",
      launchArgs: parseMuseLaunchArgs(museSettings.launchArgs),
      cwd: request.cwd || cwd,
      env: environment,
      clientVersion: "0.0.0",
    });
    yield* Effect.acquireRelease(Effect.succeed(host), (handle) => handle.close());
    const started = yield* Effect.mapError(
      host.command("session/start", { workspaceRoot: request.cwd || cwd }),
      (cause) =>
        new TextGenerationError({
          operation: request.operation,
          detail: "Could not start a Muse helper session.",
          cause,
        }),
    );
    const sessionId = String(started.sessionId as unknown as string);
    const cleanup = Effect.ignore(host.command("session/delete", { sessionId }));
    const output = yield* Effect.gen(function* () {
      yield* Effect.mapError(
        host.command("turn/start", { sessionId, input: [{ type: "text", text: request.prompt }] }),
        (cause) =>
          new TextGenerationError({
            operation: request.operation,
            detail: "Muse helper turn failed.",
            cause,
          }),
      );
      // MSP streams items over notifications; the helper turn output is read
      // back from the folded session snapshot once the turn completes.
      const snapshot = yield* Effect.mapError(
        host.request("session/read", { sessionId }),
        (cause) =>
          new TextGenerationError({
            operation: request.operation,
            detail: "Could not read Muse helper output.",
            cause,
          }),
      );
      return extractAssistantText(snapshot);
    }).pipe(
      Effect.ensuring(cleanup),
      Effect.timeoutOption(MUSE_TEXT_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation: request.operation, detail: "Muse request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );
    const trimmed = output.trim();
    if (!trimmed) {
      return yield* new TextGenerationError({
        operation: request.operation,
        detail: "Muse returned empty output.",
      });
    }
    return yield* TextGenerationOperations.decodeJsonReply(request, "Muse", trimmed);
  }).pipe(
    Effect.mapError((cause) =>
      isTextGenerationError(cause)
        ? cause
        : new TextGenerationError({
            operation: request.operation,
            detail: "Muse text generation failed.",
            cause,
          }),
    ),
    Effect.scoped,
  );
}

function extractAssistantText(snapshot: Record<string, unknown>): string {
  const items = snapshot.items;
  if (!Array.isArray(items)) return "";
  const texts: string[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record.kind !== "agentMessage" && record.type !== "agentMessage") continue;
    const text = record.text ?? record.content;
    if (typeof text === "string") texts.push(text);
  }
  return texts.join("\n");
}
