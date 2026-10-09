import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { globToRegExp, listPresets, loadConfig, matchesAny, mergeConfig } from "../skills/tidy-tree/scripts/lib/config.mjs";
import { tempDir, write } from "./helpers.mjs";

test("globs: **, *, braces, plain folders and paths outside src", () => {
  assert.ok(matchesAny("components/ui/button.tsx", ["components/**"]));
  assert.ok(matchesAny("app/(shop)/cart/page.tsx", ["app/**/{page,layout}.{ts,tsx}"]));
  assert.ok(matchesAny("page.tsx", ["**/page.tsx"]));
  assert.ok(!matchesAny("components2/x.ts", ["components"]));
  assert.ok(matchesAny("lib/db/models/user.ts", ["lib/db"]));
  assert.ok(matchesAny("lib/db", ["lib/db"]));
  assert.ok(matchesAny("../tests/unit/a.test.ts", ["../tests/**"]));
  assert.ok(globToRegExp("app/(*)/**").test("app/(auth)/login/page.tsx"));
  assert.ok(!matchesAny("lib/a.ts", ["lib/*/x.ts"]));
});

test("merge: arrays concatenate without duplicates, objects merge, scalars override", () => {
  assert.deepEqual(mergeConfig({ a: [1, 2], b: { x: 1 }, c: 1 }, { a: [2, 3], b: { y: 2 }, c: 2 }), { a: [1, 2, 3], b: { x: 1, y: 2 }, c: 2 });
});

test("presets load, root rules extend top-level ones, other roots are excluded", (t) => {
  const repo = tempDir(t, "tt-config-");
  write(
    repo,
    "tidy-tree.config.json",
    JSON.stringify({
      extends: ["next-app-router"],
      protected: ["lib/auth/**"],
      roots: [
        { name: "web", dir: ".", src: "src", protected: ["lib/flags.ts"], verify: { typecheck: "tsc" } },
        { name: "api", dir: "src/server-pkg" },
      ],
    }),
  );
  const cfg = loadConfig({ repoRoot: repo, rootName: "web" });
  assert.equal(cfg.root.name, "web");
  assert.equal(cfg.root.src, join(repo, "src"));
  assert.deepEqual(cfg.rules.protected, ["lib/auth/**", "lib/flags.ts"]);
  assert.ok(cfg.rules.entryPoints.some((g) => g.startsWith("app/**/")));
  assert.ok(cfg.rules.frameworkExports.includes("GET"));
  assert.ok(cfg.root.exclude.includes(join(repo, "src/server-pkg")));
  assert.equal(cfg.verify.typecheck, "tsc");
});

test("several roots without --workspace, unknown roots and unknown presets fail with guidance", (t) => {
  const repo = tempDir(t, "tt-config-");
  write(repo, "tidy-tree.config.json", JSON.stringify({ roots: [{ name: "a" }, { name: "b", dir: "b" }] }));
  assert.throws(() => loadConfig({ repoRoot: repo }), /--workspace/);
  assert.throws(() => loadConfig({ repoRoot: repo, rootName: "zzz" }), /no root named/);
  write(repo, "bad.json", JSON.stringify({ extends: "nope", roots: [{ name: "a" }] }));
  assert.throws(() => loadConfig({ repoRoot: repo, configPath: join(repo, "bad.json") }), new RegExp(listPresets()[0]));
});
