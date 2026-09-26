import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

const run = (
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> =>
  spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 90_000 });

const expectSuccess = (label: string, result: SpawnSyncReturns<string>) => {
  expect(result.error, `${label} failed to start`).toBeUndefined();
  expect(
    result.status,
    `${label} exited ${String(result.status)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
};

describe("packed package", () => {
  it("D10 builds during npm pack, resolves ESM and declarations, and runs the installed CLI under Node", () => {
    const temporary = mkdtempSync(join(tmpdir(), "plangraph-pack-audit-"));
    const packDirectory = join(temporary, "pack");
    const consumer = join(temporary, "consumer");
    const onlineInstall = process.env.PLANGRAPH_PACK_ONLINE === "1";
    mkdirSync(packDirectory);
    mkdirSync(consumer);
    const env = {
      ...process.env,
      npm_config_cache: join(temporary, "npm-cache"),
      npm_config_update_notifier: "false",
      npm_config_yes: "false",
      ...(onlineInstall ? {} : { npm_config_offline: "true" }),
    };

    try {
      const packed = run(
        "npm",
        ["pack", "--ignore-scripts=false", "--pack-destination", packDirectory],
        root,
        env,
      );
      expectSuccess("npm pack", packed);
      const tarballs = readdirSync(packDirectory).filter((name) => name.endsWith(".tgz"));
      expect(tarballs).toHaveLength(1);
      const tarball = join(packDirectory, tarballs[0]);

      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify({ name: "plangraph-pack-consumer", private: true, type: "module" }),
      );
      // Local sandboxes can seed the declared runtime dependency from the frozen install;
      // CI deliberately omits it to prove clean registry resolution from package metadata.
      const dependencySeed = onlineInstall ? [] : [join(root, "node_modules/yaml")];
      const installed = run(
        "npm",
        [
          "install",
          "--ignore-scripts=false",
          "--no-audit",
          "--no-fund",
          "--no-package-lock",
          ...dependencySeed,
          tarball,
        ],
        consumer,
        env,
      );
      expectSuccess("npm install packed tarball", installed);
      const installedManifest = JSON.parse(
        readFileSync(join(consumer, "node_modules/plangraph/package.json"), "utf8"),
      ) as { dependencies?: Record<string, string> };
      expect(installedManifest.dependencies?.yaml).toBe("^2.6.1");

      writeFileSync(
        join(consumer, "runtime.mjs"),
        [
          'import { report } from "plangraph";',
          'import { loadPlanFile } from "plangraph/node";',
          'if (typeof report !== "function") throw new Error("report export did not resolve");',
          'if (typeof loadPlanFile !== "function") throw new Error("plangraph/node export did not resolve");',
          'console.log(typeof report);',
        ].join("\n"),
      );
      const imported = run("node", ["runtime.mjs"], consumer, env);
      expectSuccess("Node ESM import", imported);
      expect(imported.stdout.trim()).toBe("function");

      writeFileSync(
        join(consumer, "types.ts"),
        [
          'import { report, type Plan, type Report } from "plangraph";',
          "declare const plan: Plan;",
          "const result: Report = report(plan);",
          "void result;",
        ].join("\n"),
      );
      const declarations = run(
        "node",
        [
          join(root, "node_modules/typescript/bin/tsc"),
          "--noEmit",
          "--strict",
          "--target",
          "ES2022",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "types.ts",
        ],
        consumer,
        env,
      );
      expectSuccess("TypeScript declaration resolution", declarations);

      const example = join("node_modules", "plangraph", "examples", "studio.yaml");
      const checked = run(
        "npx",
        ["--no-install", "plangraph", "check", example],
        consumer,
        env,
      );
      expectSuccess("installed plangraph CLI", checked);
      expect(checked.stdout).toContain("✓ no errors");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 120_000);
});
