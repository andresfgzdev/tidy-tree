import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadConfig, matchesAny } from "../skills/tidy-tree/scripts/lib/config.mjs";
import { DEFAULT_CONFIG, DISCOVER, makeRepo, MANUAL, run, section, snapshot, specOf, tempDir, TS_PATH } from "./helpers.mjs";

const LIB = { roots: [{ name: "lib", dir: ".", src: "src" }] };

function lib(t, files, tsconfig) {
  return makeRepo(t, { "tsconfig.json": JSON.stringify(tsconfig ?? {}), ...files }, { config: LIB, tsconfig: null });
}

test("baseUrl-only imports are found and rewritten in the same style", (t) => {
  const repo = lib(
    t,
    { "src/lib/a.ts": "export const A = 1;\n", "src/features/x.ts": 'import { A } from "lib/a";\nexport const X = A;\n' },
    { compilerOptions: { baseUrl: "src" } },
  );
  const r = repo.run([{ op: "move", from: "lib/a.ts", to: "lib/deep/a.ts" }], { apply: true });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(specOf(repo.read("src/features/x.ts"), "A"), ["lib/deep/a"]);
});

test("solution-style tsconfig with references is followed to the config that holds paths", (t) => {
  const repo = lib(
    t,
    {
      "tsconfig.app.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } }, include: ["src"] }),
      "src/lib/a.ts": "export const A = 1;\n",
      "src/features/x.ts": 'import { A } from "@/lib/a";\nexport const X = A;\n',
    },
    { files: [], references: [{ path: "./tsconfig.app.json" }] },
  );
  const r = repo.run([{ op: "move", from: "lib/a.ts", to: "lib/deep/a.ts" }], { apply: true });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(specOf(repo.read("src/features/x.ts"), "A"), ["@/lib/deep/a"]);
});

for (const [label, imports, spec, expected] of [
  ["a source pattern with .js specifiers", { "#lib/*": "./src/lib/*" }, "#lib/a.js", "#lib/deep/a.js"],
  ["a types/default pattern with bare specifiers", { "#lib/*": { types: "./src/lib/*.ts", default: "./dist/lib/*.js" } }, "#lib/a", "#lib/deep/a"],
])
  test(`package.json #imports keep their form: ${label}`, (t) => {
    const repo = lib(
      t,
      {
        "package.json": JSON.stringify({ name: "x", type: "module", imports }),
        "src/lib/a.ts": "export const A = 1;\n",
        "src/features/x.ts": `import { A } from "${spec}";\nexport const X = A;\n`,
      },
      { compilerOptions: { module: "nodenext", moduleResolution: "nodenext", rootDir: "src", outDir: "dist" } },
    );
    const r = repo.run([{ op: "move", from: "lib/a.ts", to: "lib/deep/a.ts" }], { apply: true });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(specOf(repo.read("src/features/x.ts"), "A"), [expected]);
  });

test("import x = require() is rewritten", (t) => {
  const repo = lib(t, {
    "src/lib/a.ts": "export const A = 1;\n",
    "src/x.ts": 'import a = require("./lib/a");\nexport const X = a.A;\n',
  });
  const r = repo.run([{ op: "move", from: "lib/a.ts", to: "lib/deep/a.ts" }], { apply: true });
  assert.equal(r.status, 0, r.out);
  assert.match(repo.read("src/x.ts"), /require\("\.\/lib\/deep\/a"\)/);
});

test("source folders named build, out or .server are scanned", (t) => {
  const repo = makeRepo(t, {
    "app/src/lib/a.ts": "export const A = 1;\n",
    "app/src/commands/build/run.ts": 'import { A } from "@/lib/a";\nexport const R = A;\n',
    "app/src/routes/.server/db.ts": 'import { A } from "@/lib/a";\nexport const D = A;\n',
  });
  const r = repo.run([{ op: "move", from: "lib/a.ts", to: "lib/deep/a.ts" }], { apply: true });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(specOf(repo.read("app/src/commands/build/run.ts"), "A"), ["@/lib/deep/a"]);
  assert.deepEqual(specOf(repo.read("app/src/routes/.server/db.ts"), "A"), ["@/lib/deep/a"]);
});

test("a multi-target alias never rebinds an import to a different file with the same alias path", (t) => {
  const repo = lib(
    t,
    {
      "src/api/x.ts": "export const X = 'src';\n",
      "src/old/x.ts": "export const X = 'old';\n",
      "src/use.ts": 'import { X } from "@/old/x";\nexport const U = X;\n',
      "generated/keep.ts": "export const K = 1;\n",
    },
    { compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*", "./generated/*"] } } },
  );
  const r = repo.run([{ op: "move", from: "old/x.ts", to: "../generated/api/x.ts" }], { apply: true });
  assert.equal(r.status, 0, r.out);
  const spec = specOf(repo.read("src/use.ts"), "X")[0];
  assert.notEqual(spec, "@/api/x");
  assert.equal(spec, "../generated/api/x");
});

test("moving into foo/index.ts next to an existing foo.ts writes an explicit /index specifier", (t) => {
  const repo = lib(t, {
    "src/a/foo.ts": "export const F = 'a';\n",
    "src/b/foo.ts": "export const F = 'b';\n",
    "src/use.ts": 'import { F } from "./a/foo";\nexport const U = F;\n',
  });
  const r = repo.run([{ op: "move", from: "a/foo.ts", to: "b/foo/index.ts" }], { apply: true });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(specOf(repo.read("src/use.ts"), "F"), ["./b/foo/index"]);
});

test("merge flags default imports, and export-star forms don't bypass the missing-name check", (t) => {
  const repo = lib(t, {
    "src/lib/dates.ts": "export const fmt = 1;\n",
    "src/lib/old.ts": "export default function formatA() { return 1; }\nexport const keep = 1;\n",
    "src/lib/new.ts": 'export default function formatB() { return 2; }\nexport const keep = 1;\nexport * as dates from "./dates";\n',
    "src/use.ts": 'import fmt, { keep } from "./lib/old";\nexport const U = [fmt, keep];\n',
  });
  const ok = repo.run([{ op: "merge", from: "lib/old.ts", to: "lib/new.ts" }]);
  assert.equal(ok.status, 0, ok.out);
  assert.ok(section(ok.stdout, MANUAL).some((l) => l.includes("default import")), ok.out);

  repo.write("src/use2.ts", 'import { gone } from "./lib/old";\nexport const G = gone;\n');
  repo.git("add", "-A");
  repo.git("commit", "-qm", "use2");
  const refused = repo.run([{ op: "merge", from: "lib/old.ts", to: "lib/new.ts" }]);
  assert.notEqual(refused.status, 0, refused.out);
  assert.match(refused.out, /gone/);
});

test("export * from another module contributes that module's names to the merge check", (t) => {
  const repo = lib(t, {
    "src/lib/x.ts": "export const fromX = 1;\n",
    "src/lib/old.ts": "export const fromX = 1;\n",
    "src/lib/new.ts": 'export * from "./x";\n',
    "src/use.ts": 'import { fromX } from "./lib/old";\nexport const U = fromX;\n',
  });
  const r = repo.run([{ op: "merge", from: "lib/old.ts", to: "lib/new.ts" }]);
  assert.equal(r.status, 0, r.out);
});

test("an untracked source is refused before any importer is rewritten", (t) => {
  const repo = lib(t, { "src/use.ts": "export const U = 1;\n" });
  repo.write("src/lib/x.ts", "export const X = 1;\n");
  repo.write("src/use.ts", 'import { X } from "./lib/x";\nexport const U = X;\n');
  const before = snapshot(repo.root);
  const r = repo.run([{ op: "move", from: "lib/x.ts", to: "lib/x/x.ts" }], { apply: true });
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.stderr, /not tracked by git/);
  assert.deepEqual(snapshot(repo.root), before);
});

test("protected files outside src are still listed when their imports change", (t) => {
  const repo = makeRepo(
    t,
    {
      "app/src/lib/old.ts": "export const OLD = 1;\n",
      "app/scripts/seed.ts": 'import { OLD } from "../src/lib/old";\nexport const S = OLD;\n',
    },
    { config: { ...DEFAULT_CONFIG, protected: ["../scripts/seed.ts"] } },
  );
  const r = repo.run([{ op: "move", from: "lib/old.ts", to: "lib/n/old.ts" }]);
  assert.equal(r.status, 0, r.out);
  assert.ok(section(r.stdout, /protected files/i).some((l) => l.includes("app/scripts/seed.ts")), r.out);
});

test("exclude, sharedRoots and scopes accept globs; brackets and ? in braces are literal-safe", (t) => {
  const repo = makeRepo(
    t,
    {
      "app/src/generated/client.ts": "export const C = 1;\n",
      "app/src/lib/utils/a.ts": "export const A = 1;\n",
      "app/src/features/x.ts": 'import { A } from "@/lib/utils/a";\nimport { C } from "@/generated/client";\nexport const X = A + C;\n',
    },
    { config: { roots: [{ name: "app", dir: "app", src: "src", exclude: ["generated/**"], sharedRoots: ["lib/**"], scopes: { ui: ["features/**"] } }] } },
  );
  const full = repo.inventory("full").json;
  assert.ok(!full.files.some((f) => f.file.startsWith("generated/")), JSON.stringify(full.files.map((f) => f.file)));
  assert.deepEqual(repo.inventory("shared").json.files.map((f) => f.file), ["lib/utils/a.ts"]);
  assert.deepEqual(repo.inventory("ui").json.files.map((f) => f.file), ["features/x.ts"]);
  assert.ok(matchesAny("app/[slug]/helper.ts", ["app/[slug]"]));
  assert.ok(!matchesAny("b", ["{a,b?c}"]));
});

test("react-router route modules never move", (t) => {
  const repo = makeRepo(
    t,
    { "app/src/routes/_index.tsx": "export default function Index() { return null; }\n" },
    { config: { extends: ["react-router"], roots: [{ name: "app", dir: "app", src: "src" }] } },
  );
  const r = repo.run([{ op: "move", from: "routes/_index.tsx", to: "components/home.tsx" }]);
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /neverMove/);
});

test("discover keeps a root-level app next to workspaces, gives each root its own presets, and includes sibling test folders", (t) => {
  const root = tempDir(t, "tt-mono-");
  const repo = makeRepo(
    t,
    {
      "package.json": JSON.stringify({ name: "web", workspaces: ["packages/*"], dependencies: { next: "16.0.0" } }),
      "src/app/page.tsx": 'import { A } from "../lib/a";\nexport default function P() { return A; }\n',
      "src/lib/a.ts": "export const A = 1;\n",
      "src/lib/b.ts": "export const B = 1;\n",
      "__tests__/a.test.ts": 'import { A } from "../src/lib/a";\ntest("a", () => A);\n',
      "packages/api/package.json": JSON.stringify({ name: "@x/api", main: "src/index.ts", dependencies: { express: "5.0.0" } }),
      "packages/api/src/index.ts": 'import { r } from "./r";\nexport default r;\n',
      "packages/api/src/r.ts": "export const r = 1;\n",
      "packages/api/src/s.ts": "export const s = 1;\n",
    },
    { config: null, tsconfig: null },
  );
  const out = join(root, "draft.json");
  const r = run(DISCOVER, ["--root", repo.root, "--ts", TS_PATH, "--config-out", out]);
  assert.equal(r.status, 0, r.out);
  const cfgWeb = loadConfig({ repoRoot: repo.root, configPath: out, rootName: "web" });
  const cfgApi = loadConfig({ repoRoot: repo.root, configPath: out, rootName: "api" });
  assert.ok(cfgWeb.rules.entryPoints.some((g) => g.startsWith("app/**/")), JSON.stringify(cfgWeb.rules.entryPoints));
  assert.ok(!cfgApi.rules.entryPoints.some((g) => g.startsWith("app/**/")), JSON.stringify(cfgApi.rules.entryPoints));
  assert.ok(cfgWeb.root.include.includes(join(repo.root, "__tests__")), JSON.stringify(cfgWeb.root.include));
  assert.ok(cfgWeb.root.exclude.includes(join(repo.root, "packages/api")));
});

test("a root whose src is its own folder treats test/ as tests", (t) => {
  const repo = lib(t, { "src/a.ts": "export const A = 1;\n" });
  const cfg = loadConfig({ repoRoot: repo.root, configPath: undefined, cli: {} });
  assert.ok(!matchesAny("test/a.js", cfg.rules.tests));
  const flat = loadConfig({ repoRoot: repo.root, configPath: undefined, cli: {} });
  assert.ok(flat);
  const dir = tempDir(t, "tt-flat-");
  const c = loadConfig({ repoRoot: dir, cli: { src: "." } });
  assert.ok(matchesAny("test/a.js", c.rules.tests));
});
