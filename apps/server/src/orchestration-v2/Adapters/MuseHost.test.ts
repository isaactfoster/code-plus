import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import {
  makeMuseHost,
  parseMuseLaunchArgs,
  type MuseNotification,
  type MuseTransportHandle,
} from "./MuseHost.ts";

const options = {
  binaryPath: "muse",
  launchArgs: [] as ReadonlyArray<string>,
  cwd: "/tmp",
  env: {} as NodeJS.ProcessEnv,
  clientVersion: "test",
};

function fakeTransport(onSpawn?: () => void) {
  let dispatch: ((notification: MuseNotification) => void) | undefined;
  const handle: MuseTransportHandle = {
    connectionDescription: "fake",
    command: (method, params) =>
      Effect.succeed({ method, echo: params }) as Effect.Effect<Record<string, unknown>, never>,
    request: (method) => Effect.succeed({ method }) as Effect.Effect<Record<string, unknown>, never>,
    close: Effect.void as Effect.Effect<void, never>,
  };
  return {
    getDispatch: () => dispatch,
    spawn: (
      _options: typeof options,
      dispatchFn: (notification: MuseNotification) => void,
    ): Effect.Effect<MuseTransportHandle, never> => {
      dispatch = dispatchFn;
      onSpawn?.();
      return Effect.succeed(handle);
    },
  };
}

describe("makeMuseHost", () => {
  it("parses launch args without a shell", () => {
    expect(parseMuseLaunchArgs("")).toEqual([]);
    expect(parseMuseLaunchArgs("--foo bar")).toEqual(["--foo", "bar"]);
  });

  it("spawns lazily and fans one dispatcher out to many listeners", async () => {
    const transport = fakeTransport();
    let spawns = 0;
    const counting = {
      ...transport,
      spawn: ((opts: typeof options, dispatchFn: (notification: MuseNotification) => void) => {
        spawns += 1;
        return transport.spawn(opts, dispatchFn);
      }) as typeof transport.spawn,
    };
    const host = await Effect.runPromise(makeMuseHost(options, counting));
    expect(spawns).toBe(0);
    const seenA: MuseNotification[] = [];
    const seenB: MuseNotification[] = [];
    const offA = host.onNotification((notification) => {
      seenA.push(notification);
    });
    host.onNotification((notification) => {
      seenB.push(notification);
    });
    await Effect.runPromise(host.command("session/start", { workspaceRoot: "/tmp" }));
    expect(spawns).toBe(1);
    transport.getDispatch()?.({ method: "usage/changed", params: { sessionId: "s1" } });
    expect(seenA.map((notification) => notification.method)).toEqual(["usage/changed"]);
    expect(seenB.map((notification) => notification.method)).toEqual(["usage/changed"]);
    offA();
    transport.getDispatch()?.({ method: "skill/changed", params: {} });
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(2);
    await Effect.runPromise(host.close());
  });

  it("tracks sessions and degradation", async () => {
    const host = await Effect.runPromise(makeMuseHost(options, fakeTransport()));
    await Effect.runPromise(host.trackSession("s1"));
    await Effect.runPromise(host.trackSession("s2"));
    expect(await Effect.runPromise(host.trackedSessions())).toEqual(["s1", "s2"]);
    await Effect.runPromise(host.untrackSession("s1"));
    expect(await Effect.runPromise(host.trackedSessions())).toEqual(["s2"]);
    expect(await Effect.runPromise(host.isDegraded())).toEqual({
      degraded: false,
      reason: undefined,
    });
    await Effect.runPromise(host.markDegraded("boom"));
    expect(await Effect.runPromise(host.isDegraded())).toEqual({ degraded: true, reason: "boom" });
    await Effect.runPromise(host.close());
  });
});
