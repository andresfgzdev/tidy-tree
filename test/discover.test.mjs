import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../skills/tidy-tree/scripts/lib/config.mjs";
import { DISCOVER, INVENTORY, run, snapshot, tempDir, TS_PATH, write } from "./helpers.mjs";

function fixture(t, files) {
  const root = tempDir(t, "tt-discover-");
  for (const [p, c] of Object.entries(files)) write(root, p, c);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-qm", "feat(app): initial structure");
  git("branch", "feat/cart/SHOP-12");
  git("branch", "fix/totals/SHOP-14");
  return { root, git };
}

function discover(t, repo) {
  const side = tempDir(t, "tt-discover-out-");
  const out = join(side, "arch.json");
  const cfg = join(side, "draft.json");
  const before = snapshot(repo.root);
  const r = run(DISCOVER, ["--root", repo.root, "--ts", TS_PATH, "--out", out, "--config-out", cfg]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(snapshot(repo.root), before, "discover must not change the repository");
  return { ...r, arch: JSON.parse(readFileSync(out, "utf8")), draft: JSON.parse(readFileSync(cfg, "utf8")), draftPath: cfg };
}

const pkg = (o) => JSON.stringify({ name: "fixture", version: "1.0.0", ...o });

test("discover: feature-first Vite app keeps its own shape, naming and test runner", (t) => {
  const files = {
    "package.json": pkg({ dependencies: { react: "19.0.0" }, devDependencies: { vite: "7.0.0", vitest: "3.0.0", typescript: "5.9.0" }, scripts: { test: "vitest" } }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx", baseUrl: ".", paths: { "~/*": ["./src/*"] } } }),
    "src/main.tsx": 'import { App } from "~/app/App";\nApp();\n',
    "src/app/App.tsx": 'import { CartPage } from "~/features/cart/components/CartPage";\nexport const App = () => CartPage();\n',
  };
  for (const f of ["cart", "catalog", "checkout"]) {
    const P = f[0].toUpperCase() + f.slice(1);
    files[`src/features/${f}/components/${P}Page.tsx`] = `import { use${P} } from "../hooks/use${P}";\nimport { Button } from "~/shared/ui/Button";\nexport const ${P}Page = () => [use${P}(), Button()];\n`;
    files[`src/features/${f}/hooks/use${P}.ts`] = `import { format } from "~/shared/lib/format";\nexport const use${P} = () => format(1);\n`;
    files[`src/features/${f}/components/${P}Page.test.tsx`] = `import { ${P}Page } from "./${P}Page";\ntest("x", () => ${P}Page());\n`;
  }
  files["src/shared/ui/Button.tsx"] = "export const Button = () => null;\n";
  files["src/shared/lib/format.ts"] = "export const format = (n: number) => String(n);\n";
  const repo = fixture(t, files);
  const { arch, draft, out, draftPath } = discover(t, repo);
  const root = arch.roots[0];
  assert.equal(root.src, "src");
  assert.match(root.style, /feature-first/);
  assert.deepEqual(root.framework.presets, ["vite"]);
  assert.match(root.testPlacement.convention, /co-located/);
  assert.equal(root.naming["features (jsx)"].convention, "PascalCase");
  assert.equal(root.naming["features (code)"].convention, "camelCase");
  assert.ok(root.verify.relatedTests.includes("vitest related"), JSON.stringify(root.verify));
  assert.equal(root.imports.aliasPrefixes["~/"] > 0, true);
  assert.deepEqual(draft.extends, ["vite"]);
  assert.deepEqual(draft.roots[0].sharedRoots, ["shared"]);
  assert.deepEqual(draft.roots[0].areaRoots, ["features/*"]);
  assert.ok(draft.roots[0].layers.some((l) => l.from === "shared/**" && l.to === "features/**"), JSON.stringify(draft.roots[0].layers));
  assert.match(arch.git.commitStyle, /conventional/);
  assert.ok(arch.git.branchesWithTicketIds >= 2);
  assert.match(out, /feature-first/);
  const cfg = loadConfig({ repoRoot: repo.root, configPath: draftPath });
  assert.equal(cfg.root.src, join(repo.root, "src"));
  const inv = run(INVENTORY, ["--root", repo.root, "--ts", TS_PATH, "--config", draftPath, "--scope", "full"]);
  assert.equal(inv.status, 0, inv.out);
});

test("discover: layer-first Next app proposes observed layer rules from its own import direction", (t) => {
  const files = {
    "package.json": pkg({ dependencies: { next: "16.0.0", react: "19.0.0" }, devDependencies: { jest: "30.0.0", typescript: "5.9.0", eslint: "9.0.0" } }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "preserve", baseUrl: ".", paths: { "@/*": ["./src/*"] } } }),
    "docs/architecture.md": "# Architecture\n\nComponents use lib, never the reverse.\n",
    "CONTRIBUTING.md": "# Contributing\n",
    "src/app/page.tsx": 'import { Card } from "@/components/card";\nexport default function Page() { return Card(); }\n',
  };
  for (let i = 0; i < 8; i++) files[`src/components/c${i}.tsx`] = `import { util${i} } from "@/lib/util${i}";\nexport const C${i} = () => util${i}();\n`;
  for (let i = 0; i < 8; i++) files[`src/lib/util${i}.ts`] = `export const util${i} = () => ${i};\n`;
  files["src/components/card.tsx"] = 'import { util0 } from "@/lib/util0";\nexport const Card = () => util0();\n';
  files["src/lib/bad.ts"] = 'import { Card } from "@/components/card";\nexport const bad = Card;\n';
  const repo = fixture(t, files);
  const { arch, draft } = discover(t, repo);
  const root = arch.roots[0];
  assert.deepEqual(root.framework.presets, ["next-app-router"]);
  assert.match(root.style, /layer-first/);
  assert.ok(
    root.proposedLayers.some((l) => l.from === "lib/**" && l.to === "components/**" && l.basis === "observed"),
    JSON.stringify(root.proposedLayers),
  );
  assert.ok(draft.roots[0].layers.length >= 1);
  assert.ok(arch.conventions.docs.includes("docs/architecture.md"), JSON.stringify(arch.conventions.docs));
  assert.ok(arch.conventions.docs.includes("CONTRIBUTING.md"));
  assert.ok(root.verify.relatedTests.includes("jest --findRelatedTests"));
  assert.ok(root.verify.lint.includes("eslint {files}"));
});

test("discover: a monorepo yields one root per JS workspace and reports other languages as out of reach", (t) => {
  const repo = fixture(t, {
    "package.json": pkg({ private: true, workspaces: ["packages/*"] }),
    "packages/web/package.json": pkg({ name: "@acme/web", dependencies: { react: "19.0.0" } }),
    "packages/web/src/a.ts": "export const A = 1;\n",
    "packages/web/src/b.ts": 'import { A } from "./a";\nexport const B = A;\n',
    "packages/web/src/c.ts": 'import { B } from "./b";\nexport const C = B;\n',
    "packages/api/package.json": pkg({ name: "@acme/api", main: "src/index.ts", dependencies: { express: "5.0.0" } }),
    "packages/api/src/index.ts": 'import { route } from "./routes/route";\nexport default route;\n',
    "packages/api/src/routes/route.ts": "export const route = 1;\n",
    "packages/api/src/routes/other.ts": "export const other = 1;\n",
    "ml/pyproject.toml": "[project]\nname='ml'\n",
  });
  const { arch, draft, draftPath } = discover(t, repo);
  assert.deepEqual(arch.roots.map((r) => r.dir).sort(), ["packages/api", "packages/web"]);
  assert.deepEqual(draft.roots.map((r) => r.name).sort(), ["api", "web"]);
  const api = arch.roots.find((r) => r.dir === "packages/api");
  assert.deepEqual(api.entryPoints, ["index.*"]);
  assert.ok(arch.outOfReach.otherLanguageDirs.includes("ml"));
  assert.throws(() => loadConfig({ repoRoot: repo.root, configPath: draftPath }), /--workspace/);
  const cfg = loadConfig({ repoRoot: repo.root, configPath: draftPath, rootName: "api" });
  assert.equal(cfg.root.src, join(repo.root, "packages/api/src"));
  assert.ok(cfg.rules.entryPoints.includes("index.*"));
});
