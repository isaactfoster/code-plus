import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  HostProcessArguments,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  formatCliCommand,
  resolveRootCliCommand,
  resolveServerInstallation,
} from "./invocation.ts";

it("formats package runner commands from their cache entry paths", () => {
  for (const [entryPath, expected] of [
    ["/home/theo/.npm/_npx/abc123/node_modules/code-plus/dist/bin.mjs", "npx code-plus serve"],
    [
      "C:\\Users\\theo\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\code-plus\\dist\\bin.mjs",
      "npx code-plus serve",
    ],
    ["/home/theo/.cache/pnpm/dlx/abc/node_modules/code-plus/dist/bin.mjs", "pnpm dlx code-plus serve"],
    [
      "/home/theo/.local/share/pnpm/.pnpm/dlx/abc/node_modules/code-plus/dist/bin.mjs",
      "pnpm dlx code-plus serve",
    ],
    [
      "C:\\Users\\theo\\AppData\\Local\\pnpm-cache\\dlx\\abc\\node_modules\\code-plus\\dist\\bin.mjs",
      "pnpm dlx code-plus serve",
    ],
    ["/home/theo/.bun/install/cache/code-plus@0.0.31/dist/bin.mjs", "bunx code-plus serve"],
    ["/tmp/bunx-1000-code-plus@latest/node_modules/code-plus/dist/bin.mjs", "bunx code-plus serve"],
    [
      "C:\\Users\\theo\\AppData\\Local\\Temp\\bunx-0-code-plus@latest\\node_modules\\code-plus\\dist\\bin.mjs",
      "bunx code-plus serve",
    ],
  ] as const) {
    assert.equal(formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }), expected);
  }
});

it("treats stable installs as direct invocations", () => {
  for (const entryPath of [
    "/usr/local/lib/node_modules/code-plus/dist/bin.mjs",
    "/home/theo/Code/work/foscode/apps/server/dist/bin.mjs",
    "/home/theo/.t3/runtime/0.0.31/node_modules/code-plus/dist/bin.mjs",
    "",
  ]) {
    assert.equal(
      formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }),
      "code-plus serve",
    );
  }
});

it("re-suggests the prerelease channel only for prerelease builds", () => {
  for (const [version, expected] of [
    ["0.0.31-nightly.20260729", "npx code-plus@nightly serve"],
    ["0.0.31-preview.20260729.1", "npx code-plus@preview serve"],
    ["0.0.31-foo-preview.20260729.1", "npx code-plus serve"],
    ["0.0.31", "npx code-plus serve"],
  ] as const) {
    assert.equal(
      formatCliCommand({
        subcommand: "serve",
        entryPath: "/home/theo/.npm/_npx/abc123/node_modules/code-plus/dist/bin.mjs",
        version,
      }),
      expected,
    );
  }
});

it("formats serve suggestions to match the launching command", () => {
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/home/theo/.npm/_npx/abc/node_modules/code-plus/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "npx code-plus@nightly serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/tmp/bunx-1000-code-plus@latest/node_modules/code-plus/dist/bin.mjs",
      version: "0.0.31",
    }),
    "bunx code-plus serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/usr/local/lib/node_modules/code-plus/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "code-plus serve",
  );
});

it.effect("keeps a user-installed Node reachable when the command runs under sudo", () =>
  Effect.gen(function* () {
    const command = (node: string, entry: string) =>
      resolveRootCliCommand("browser setup").pipe(
        Effect.provideService(HostProcessExecutablePath, node),
        Effect.provideService(HostProcessArguments, [node, entry]),
      );
    const npx = "/home/theo/.npm/_npx/abc/node_modules/code-plus/dist/bin.mjs";
    // sudo's secure_path already has a system Node.
    expect(yield* command("/usr/bin/node", npx)).toBe("sudo npx code-plus browser setup");
    // nvm, fnm, and tarball installs are dropped by sudo's PATH reset.
    expect(yield* command("/home/theo/.nvm/versions/node/v24/bin/node", npx)).toBe(
      'sudo env "PATH=$PATH" npx code-plus browser setup',
    );
    expect(
      yield* command(
        "/home/theo/.local/node/bin/node",
        "/home/theo/.local/lib/node_modules/code-plus/dist/bin.mjs",
      ),
    ).toBe('sudo env "PATH=$PATH" code-plus browser setup');
  }),
);

it.layer(NodeServices.layer)("manual server installation ownership", (it) => {
  it.effect("recognizes runner caches for both script and executable packages", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const [relative, kind] of [
        ["npm/_npx/hash/node_modules/code-plus/dist/bin.mjs", "npx"],
        ["npm/_npx/hash/node_modules/@codeplus/code-plus-linux-x64/code-plus", "npx"],
        ["pnpm/dlx/hash/node_modules/code-plus/dist/bin.mjs", "pnpm-dlx"],
        [".bun/install/cache/code-plus/dist/bin.mjs", "bunx"],
      ] as const) {
        const entry = path.join(root, relative);
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.writeFileString(entry, "");
        const installation = yield* resolveServerInstallation.pipe(
          Effect.provideService(HostProcessArguments, ["node", entry]),
          Effect.provideService(HostProcessExecutablePath, entry),
          Effect.provideService(HostProcessIsExecutable, entry.endsWith("/code-plus")),
        );
        expect(installation).toEqual({ kind });
      }
    }),
  );

  it.effect("requires the npm prefix's bin to point to the running package", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/code-plus");
      const entry = path.join(packageRoot, "dist/bin.mjs");
      const globalBin = path.join(prefix, "bin/code-plus");
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.makeDirectory(path.dirname(globalBin), { recursive: true });
      yield* fs.writeFileString(entry, "");
      yield* fs.writeFileString(
        path.join(packageRoot, "package.json"),
        '{"name":"code-plus","version":"0.0.45","bin":{"code-plus":"./dist/bin.mjs"}}',
      );
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcessArguments, ["node", entry]),
        Effect.provideService(HostProcessIsExecutable, false),
        Effect.provideService(HostProcessPlatform, "linux"),
      );
      expect(yield* resolve).toBeNull();
      yield* fs.symlink(entry, globalBin);
      expect(yield* resolve).toEqual({ kind: "npm-global", prefix });
      yield* fs.remove(globalBin);
      yield* fs.writeFileString(globalBin, "an unrelated code-plus command");
      expect(yield* resolve).toBeNull();
      expect(yield* resolve.pipe(Effect.provideService(HostProcessPlatform, "win32"))).toBeNull();
    }),
  );

  it.effect("proves the native executable belongs to the npm launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/code-plus");
      const launcher = path.join(packageRoot, "bin/code-plus.js");
      const entry = path.join(packageRoot, "node_modules/@codeplus/code-plus-linux-x64/code-plus");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.makeDirectory(path.join(prefix, "bin"));
      yield* fs.writeFileString(launcher, "");
      yield* fs.writeFileString(entry, "");
      yield* fs.writeFileString(
        path.join(packageRoot, "package.json"),
        '{"name":"code-plus","version":"0.0.45","bin":{"code-plus":"./bin/code-plus.js"},"optionalDependencies":{"@codeplus/code-plus-linux-x64":"0.0.45"}}',
      );
      yield* fs.symlink(launcher, path.join(prefix, "bin/code-plus"));
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcessExecutablePath, entry),
        Effect.provideService(HostProcessIsExecutable, true),
        Effect.provideService(HostProcessPlatform, "linux"),
      );
      for (const [version, expected] of [
        ["0.0.44", null],
        ["0.0.45", { kind: "npm-global", prefix }],
      ]) {
        yield* fs.writeFileString(
          path.join(path.dirname(entry), "package.json"),
          `{"name":"@codeplus/code-plus-linux-x64","version":"${version}"}`,
        );
        expect(yield* resolve).toEqual(expected);
      }
    }),
  );

  it.effect("leaves local, standalone, missing and unreadable installs unknown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const relative of [
        "project/node_modules/code-plus/dist/bin.mjs",
        "project/apps/server/dist/bin.mjs",
        ".code-plus/runtime/0.0.45/code-plus",
        "missing/dist/bin.mjs",
      ]) {
        const entry = path.join(root, relative);
        if (!relative.startsWith("missing")) {
          yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
          yield* fs.writeFileString(entry, "");
        }
        expect(
          yield* resolveServerInstallation.pipe(
            Effect.provideService(HostProcessArguments, ["node", entry]),
            Effect.provideService(HostProcessIsExecutable, false),
          ),
        ).toBeNull();
      }
    }),
  );
});
