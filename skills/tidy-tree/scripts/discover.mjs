#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { listPresets } from "./lib/config.mjs";
import {
  collectSpecifiers,
  findTsconfig,
  createResolver,
  listSources,
  loadTypeScript,
  parseArgs,
  parseSource,
  resolveRepoRoot,
  SKIP_DIRS,
  toPosix,
} from "./lib/project.mjs";

const USAGE = `discover.mjs: describe how a repository is organised today, and draft a tidy-tree config from it.

  node discover.mjs [--root <repo>] [--out architecture.json] [--config-out tidy-tree.config.json]
                    [--ts path/to/node_modules/typescript]

Reads package manifests, tsconfig/jsconfig, the folder tree, the import graph, convention docs,
lint boundary rules and git history. Prints a summary of the architecture it observed (folder
style, naming, test placement, barrels, import style, dependency direction between folders) and
writes a DRAFT config to --config-out. Nothing in the repository is changed. The draft is a
proposal: confirm it with the user before saving it into the repository.`;

process.on("uncaughtException", (e) => {
  console.error(`error: ${e?.message ?? e}`);
  if (process.env.TIDY_TREE_DEBUG) console.error(e?.stack);
  process.exit(1);
});

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const repoRoot = resolveRepoRoot(args.root);
const rel = (abs) => toPosix(path.relative(repoRoot, abs)) || ".";
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const exists = (p) => fs.existsSync(p);
const git = (...a) => {
  try {
    return execFileSync("git", ["-C", repoRoot, ...a], { stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return "";
  }
};
const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);

const rootPkg = readJson(path.join(repoRoot, "package.json")) ?? {};
const packageManager =
  (exists(path.join(repoRoot, "pnpm-lock.yaml")) && "pnpm") ||
  (exists(path.join(repoRoot, "yarn.lock")) && "yarn") ||
  ((exists(path.join(repoRoot, "bun.lockb")) || exists(path.join(repoRoot, "bun.lock"))) && "bun") ||
  (exists(path.join(repoRoot, "package-lock.json")) && "npm") ||
  (String(rootPkg.packageManager ?? "").split("@")[0] || "npm");
const exec = { pnpm: "pnpm exec", yarn: "yarn", bun: "bunx", npm: "npx" }[packageManager] ?? "npx";

function workspacePatterns() {
  const fromPkg = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces?.packages ?? [];
  const pnpm = path.join(repoRoot, "pnpm-workspace.yaml");
  const fromPnpm = exists(pnpm)
    ? fs
        .readFileSync(pnpm, "utf8")
        .split("\n")
        .map((l) => l.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*$/)?.[1])
        .filter(Boolean)
    : [];
  const lerna = readJson(path.join(repoRoot, "lerna.json"))?.packages ?? [];
  return [...new Set([...fromPkg, ...fromPnpm, ...lerna])].filter((p) => !p.startsWith("!"));
}

function expandWorkspace(pattern) {
  const clean = pattern.replace(/\/$/, "");
  if (!/[*?]/.test(clean)) return exists(path.join(repoRoot, clean, "package.json")) ? [path.join(repoRoot, clean)] : [];
  const [head] = clean.split(/\/?\*/);
  const base = path.join(repoRoot, head);
  if (!exists(base)) return [];
  const out = [];
  const visit = (dir, depth) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const d = path.join(dir, e.name);
      if (exists(path.join(d, "package.json"))) out.push(d);
      else if (clean.includes("**") && depth < 3) visit(d, depth + 1);
    }
  };
  visit(base, 0);
  return out;
}

const workspaceDirs = workspacePatterns().flatMap(expandWorkspace);
const notInWorkspace = (dir) => (f) => workspaceDirs.some((w) => w !== dir && (f === w || f.startsWith(w + path.sep)));
const rootHasOwnApp =
  workspaceDirs.length > 0 &&
  listSources(repoRoot, notInWorkspace(repoRoot)).filter((f) => !/[\\/](scripts|tools|\.github)[\\/]/.test(f) && !/^[^/\\]+\.[cm]?[jt]s$/.test(path.relative(repoRoot, f))).length >= 3;
const candidateDirs = workspaceDirs.length ? [...(rootHasOwnApp ? [repoRoot] : []), ...workspaceDirs] : [repoRoot];
const nonJsWorkspaces = [];

function deps(pkg) {
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
}

function detectFramework(dir, pkg) {
  const d = deps(pkg);
  const has = (p) => exists(path.join(dir, p));
  if (d.next) {
    const appDir = has("src/app") || has("app");
    const pagesDir = has("src/pages") || has("pages");
    if (appDir && pagesDir) return { name: "next", presets: ["next-app-router", "next-pages"] };
    return { name: "next", presets: [appDir || !pagesDir ? "next-app-router" : "next-pages"] };
  }
  if (d["@react-router/dev"] || d["@remix-run/react"] || d["@remix-run/dev"]) return { name: "react-router", presets: ["react-router"] };
  if (d.vite && !d["@sveltejs/kit"] && !d.nuxt && !d.astro) return { name: d.react ? "vite-react" : "vite", presets: ["vite"] };
  if (d["@nestjs/core"]) return { name: "nestjs", presets: ["node"] };
  if (d.express || d.fastify || d.koa || d.hono || d["@hapi/hapi"]) return { name: "node-server", presets: ["node"] };
  if (d["@sveltejs/kit"] || d.nuxt || d.astro || d.vue || d.svelte || d["@angular/core"])
    return { name: Object.keys(d).find((k) => ["@sveltejs/kit", "nuxt", "astro", "vue", "svelte", "@angular/core"].includes(k)), presets: [], partial: true };
  if (pkg.bin || pkg.exports || pkg.main) return { name: "library-or-cli", presets: ["node"] };
  if (d.react) return { name: "react", presets: [] };
  return { name: "unknown", presets: [] };
}

function pickSrc(dir) {
  const hasSources = (c) => exists(path.join(dir, c)) && fs.statSync(path.join(dir, c)).isDirectory() && listSources(path.join(dir, c)).length >= 3;
  if (hasSources("src")) return "src";
  if (hasSources("app") && ["root.tsx", "root.jsx", "root.ts", "root.js"].some((f) => exists(path.join(dir, "app", f)))) return "app";
  return ".";
}

const KIND_DIRS = new Set([
  "components", "component", "hooks", "hook", "utils", "util", "helpers", "lib", "libs", "services", "service", "types", "typings",
  "constants", "config", "configs", "models", "model", "controllers", "controller", "routes", "router", "api", "store", "stores",
  "reducers", "actions", "selectors", "contexts", "context", "providers", "styles", "assets", "middleware", "middlewares",
  "schemas", "schema", "validators", "repositories", "repository", "entities", "dto", "dtos", "interfaces", "enums", "pages", "views",
  "layouts", "fetchers", "clients", "adapters", "mappers", "queries", "mutations", "handlers", "jobs", "workers", "db", "database",
]);
const FEATURE_PARENTS = new Set(["features", "feature", "modules", "module", "domains", "domain", "slices", "entities", "widgets", "apps", "packages"]);

function caseOf(stem) {
  if (/^[a-z0-9]+$/.test(stem)) return "lower";
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(stem)) return "kebab-case";
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(stem)) return "snake_case";
  if (/^[a-z][a-zA-Z0-9]*$/.test(stem)) return "camelCase";
  if (/^[A-Z][a-zA-Z0-9]*$/.test(stem)) return "PascalCase";
  return "mixed";
}

function dominant(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const [name, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? ["none", 0];
  return { convention: name, share: pct(n, total), total, counts };
}

let tsLib = null;
function ts() {
  tsLib ??= loadTypeScript([repoRoot, ...candidateDirs], args.ts);
  return tsLib;
}

function analyseRoot(dir) {
  const pkg = readJson(path.join(dir, "package.json")) ?? {};
  const srcRel = pickSrc(dir);
  const src = path.resolve(dir, srcRel);
  const otherWorkspaces = workspaceDirs.filter((w) => w !== dir);
  const inOther = (f) => otherWorkspaces.some((w) => f === w || f.startsWith(w + path.sep));
  const files = listSources(src, inOther);
  const framework = detectFramework(dir, pkg);
  const tsconfig = findTsconfig(dir) ?? findTsconfig(src);
  const resolver = createResolver(ts(), tsconfig);
  const aliases = resolver.aliases;
  const r = (abs) => toPosix(path.relative(src, abs));
  const isTest = (p) => /(^|\/)(__tests__|__mocks__)\//.test(p) || /\.(test|spec)\.[cm]?[tj]sx?$/.test(p);
  const isStory = (p) => /\.stories\.[tj]sx?$/.test(p);
  const prod = files.filter((f) => !isTest(r(f)) && !isStory(r(f)));
  const stemOf = (f) => path.basename(f).replace(/\.[^.]+$/, "").replace(/\.(test|spec|stories|module|service|controller|config|types?|d)$/i, "");

  const top = new Map();
  for (const f of prod) {
    const seg = r(f).split("/");
    const key = seg.length > 1 ? seg[0] : "(root files)";
    top.set(key, (top.get(key) ?? 0) + 1);
  }
  const topFolders = [...top.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, files: n, kind: KIND_DIRS.has(name.toLowerCase()) ? "kind" : FEATURE_PARENTS.has(name.toLowerCase()) ? "feature-parent" : "domain" }));
  const kindFiles = topFolders.filter((t) => t.kind === "kind").reduce((n, t) => n + t.files, 0);
  const featureFiles = topFolders.filter((t) => t.kind !== "kind" && t.name !== "(root files)").reduce((n, t) => n + t.files, 0);
  const featureSubfolders = topFolders
    .filter((t) => t.kind === "feature-parent")
    .map((t) => {
      const d = path.join(src, t.name);
      const subs = fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      const kindInside = subs.filter((s) => {
        const inner = path.join(d, s);
        return fs.readdirSync(inner, { withFileTypes: true }).some((e) => e.isDirectory() && KIND_DIRS.has(e.name.toLowerCase()));
      }).length;
      return { parent: t.name, features: subs.length, withKindFolders: kindInside };
    });
  const style =
    !prod.length ? "empty" :
    pct(kindFiles, prod.length) >= 70 ? "layer-first (folders by kind: components, hooks, utils…)" :
    pct(featureFiles, prod.length) >= 60 ? "feature-first (folders by domain or feature)" :
    "hybrid (kind folders and domain folders side by side)";

  const byFolder = new Map();
  for (const f of prod) {
    const p = r(f);
    const stem = stemOf(f);
    if (stem === "index") continue;
    const segs = p.split("/").slice(0, -1);
    const kind = /\.[jt]sx$/.test(f) ? "jsx" : "code";
    for (const depth of [1, 2]) {
      if (segs.length < depth && !(depth === 1 && !segs.length)) continue;
      const folder = segs.slice(0, depth).join("/") || ".";
      const k = `${folder} (${kind})`;
      const m = byFolder.get(k) ?? {};
      m[caseOf(stem)] = (m[caseOf(stem)] ?? 0) + 1;
      byFolder.set(k, m);
    }
  }
  const naming = {};
  for (const [k, counts] of [...byFolder.entries()].sort()) {
    const d = dominant(counts);
    if (d.total < 3) continue;
    const [folder, kind] = k.split(" ");
    if (folder.includes("/")) {
      const parent = byFolder.get(`${folder.split("/")[0]} ${kind}`);
      if (parent && dominant(parent).convention === d.convention) continue;
    }
    naming[k] = d;
  }

  const tests = { colocated: 0, testsDir: 0, outsideSrc: 0 };
  for (const f of files) {
    const p = r(f);
    if (!isTest(p)) continue;
    if (/(^|\/)__tests__\//.test(p)) tests.testsDir++;
    else tests.colocated++;
  }
  for (const d of ["test", "tests", "e2e", "__tests__"]) {
    const p = path.join(dir, d);
    if (src !== dir && exists(p)) tests.outsideSrc += listSources(p).length;
  }
  const testPlacement = dominant({ "co-located *.test.* next to the code": tests.colocated, "__tests__ folders": tests.testsDir, "separate test/ or tests/ folder": tests.outsideSrc });

  const folders = new Map();
  for (const f of prod) {
    const d = path.dirname(f);
    if (d !== src) folders.set(d, (folders.get(d) ?? []).concat(f));
  }
  const withIndex = [...folders.values()].filter((list) => list.some((f) => stemOf(f) === "index")).length;

  const t = ts();
  const graph = { alias: 0, relative: 0, relativeWithExt: 0, aliasPrefixes: {}, edges: new Map() };
  const area = (p) => {
    const seg = p.split("/");
    return seg.length > 1 ? seg[0] : "(root files)";
  };
  for (const f of prod) {
    const text = fs.readFileSync(f, "utf8");
    const sf = parseSource(t, f, text);
    for (const s of collectSpecifiers(t, sf)) {
      if (s.kind === "mock") continue;
      const target = resolver.resolve(s.spec, f);
      if (!target || !target.startsWith(src + path.sep)) continue;
      if (s.spec.startsWith(".")) {
        graph.relative++;
        if (/\.[cm]?[jt]sx?$/.test(s.spec)) graph.relativeWithExt++;
      } else {
        graph.alias++;
        const prefix = aliases.find((a) => (a.wildcard ? s.spec.startsWith(a.prefix) : s.spec === a.prefix))?.prefix || "(baseUrl)";
        graph.aliasPrefixes[prefix] = (graph.aliasPrefixes[prefix] ?? 0) + 1;
      }
      if (s.typeOnly || s.kind === "import-type" || isTest(r(target))) continue;
      const a = area(r(f));
      const b = area(r(target));
      if (a === b) continue;
      const key = `${a}\u0000${b}`;
      graph.edges.set(key, (graph.edges.get(key) ?? 0) + 1);
    }
  }
  const pairs = new Set();
  for (const key of graph.edges.keys()) pairs.add(key.split("\u0000").sort().join("\u0000"));
  const direction = [];
  const proposedLayers = [];
  for (const id of pairs) {
    const [a, b] = id.split("\u0000");
    const ab = graph.edges.get(`${a}\u0000${b}`) ?? 0;
    const ba = graph.edges.get(`${b}\u0000${a}`) ?? 0;
    const [hi, lo, hiN, loN] = ab >= ba ? [a, b, ab, ba] : [b, a, ba, ab];
    direction.push({ from: hi, to: lo, imports: hiN, reverse: loN });
    if (hi === "(root files)" || lo === "(root files)") continue;
    if (loN > 0 && hiN + loN >= 6 && hiN / (hiN + loN) >= 0.85)
      proposedLayers.push({
        from: `${lo}/**`,
        to: `${hi}/**`,
        basis: "observed",
        why: `${hi}/ imports ${lo}/ ${hiN} times; ${lo}/ imports ${hi}/ only ${loN} times, so those look like the exceptions`,
      });
    else if (loN === 0 && hiN >= 5)
      proposedLayers.push({
        from: `${lo}/**`,
        to: `${hi}/**`,
        basis: "observed",
        why: `${hi}/ imports ${lo}/ ${hiN} times and never the reverse`,
      });
  }
  direction.sort((x, y) => y.imports - x.imports);

  const entryPoints = [];
  const addEntry = (p) => {
    if (typeof p !== "string") return;
    const abs = path.resolve(dir, p);
    if (abs.startsWith(src + path.sep)) entryPoints.push(r(abs).replace(/\.(d\.)?[cm]?[jt]sx?$/, ".*"));
  };
  addEntry(pkg.main);
  addEntry(pkg.module);
  addEntry(pkg.source);
  for (const v of Object.values(typeof pkg.bin === "string" ? { x: pkg.bin } : pkg.bin ?? {})) addEntry(v);
  const walkExports = (e) => (typeof e === "string" ? addEntry(e) : e && typeof e === "object" ? Object.values(e).forEach(walkExports) : null);
  walkExports(pkg.exports);

  const runners = deps(pkg);
  const rootDeps = deps(rootPkg);
  const hasDep = (n) => n in runners || n in rootDeps;
  const scripts = pkg.scripts ?? {};
  const cwd = rel(dir);
  const verify = { cwd };
  const typecheckScript = ["typecheck", "type-check", "check-types", "types", "tsc"].find((s) => scripts[s]);
  if (typecheckScript) verify.typecheck = `${packageManager} run ${typecheckScript}`;
  else if (tsconfig && hasDep("typescript")) verify.typecheck = `${exec} tsc -p ${toPosix(path.relative(dir, tsconfig))} --noEmit`;
  if (hasDep("@biomejs/biome")) verify.lint = `${exec} biome check {files}`;
  else if (hasDep("eslint")) verify.lint = `${exec} eslint {files}`;
  const scriptText = Object.values(scripts).join(" ");
  const runner = /\bvitest\b/.test(scriptText) ? "vitest" : /\bjest\b/.test(scriptText) ? "jest" : "vitest" in runners ? "vitest" : "jest" in runners ? "jest" : null;
  const wrapper = runner
    ? Object.keys(scripts)
        .filter((k) => new RegExp(`\\b${runner}\\b`).test(scripts[k]) && !/--watch|\bwatch\b|--coverage|&&|\|\|/.test(scripts[k]) && !/related|findRelatedTests/.test(scripts[k]))
        .sort((a, b) => Number(/:|unit/.test(b)) - Number(/:|unit/.test(a)) || a.length - b.length)[0]
    : null;
  const runScript = (name) => (packageManager === "npm" ? `npm run ${name} --` : packageManager === "bun" ? `bun run ${name}` : `${packageManager} ${name}`);
  if (runner === "vitest") verify.relatedTests = wrapper && !/\brun\b/.test(scripts[wrapper]) ? `${exec} vitest related --run --passWithNoTests {files}` : wrapper ? `${runScript(wrapper)} --passWithNoTests {files}` : `${exec} vitest related --run --passWithNoTests {files}`;
  else if (runner === "jest") verify.relatedTests = wrapper ? `${runScript(wrapper)} --findRelatedTests --passWithNoTests {files}` : `${exec} jest --findRelatedTests --passWithNoTests {files}`;
  else if (scripts.test) verify.tests = `${packageManager} run test`;

  return {
    name: pkg.name ?? path.basename(dir),
    dir: rel(dir),
    src: srcRel,
    tsconfig: tsconfig ? toPosix(path.relative(dir, tsconfig)) : null,
    framework,
    files: files.length,
    productionFiles: prod.length,
    style,
    topFolders,
    featureSubfolders,
    naming,
    testPlacement,
    barrels: { foldersWithIndex: withIndex, folders: folders.size, share: pct(withIndex, folders.size) },
    imports: {
      aliasShare: pct(graph.alias, graph.alias + graph.relative),
      aliasPrefixes: graph.aliasPrefixes,
      relativeWithExtensionShare: pct(graph.relativeWithExt, graph.relative),
      aliases: aliases.map((a) => `${a.prefix || "(baseUrl) "}${a.wildcard ? "*" : ""} -> ${a.targets.map((t) => toPosix(path.relative(repoRoot, t))).join(" | ")}`),
    },
    dependencyDirection: direction.slice(0, 25),
    proposedLayers,
    sharedRoots: topFolders.filter((t) => /^(shared|common)$/i.test(t.name)).map((t) => t.name),
    areaRoots: featureSubfolders.filter((f) => f.features >= 2).map((f) => `${f.parent}/*`),
    entryPoints,
    verify,
    include:
      src === dir
        ? []
        : fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && e.name !== path.basename(src) && e.name !== ".storybook" && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
            .map((e) => e.name)
            .filter((n) => listSources(path.join(dir, n), inOther).length > 0),
  };
}

function conventionSources() {
  const tracked = git("ls-files").split("\n").filter(Boolean);
  const list = tracked.length ? tracked : [];
  const rank = (f) =>
    /(^|\/)(CLAUDE|AGENTS|GEMINI)\.md$/i.test(f) || /constitution\.md$/i.test(f) ? 0
    : /^\.(claude|cursor)\/rules\/|^\.cursorrules$|^\.github\/(copilot-instructions\.md|instructions\/)/.test(f) ? 1
    : /(^|\/)(CONTRIBUTING|ARCHITECTURE|CONVENTIONS|STYLEGUIDE|STRUCTURE)\.md$/.test(f) ? 1
    : /(^|\/)(standards|conventions|guidelines)\//i.test(f) ? 2
    : /(^|\/)(adrs?|decisions)\//i.test(f) ? 3
    : 4;
  const docs = list
    .filter(
      (f) =>
        !/(^|\/)templates?\/|-template\.mdx?$|^\.claude\/(commands|skills|agents)\/|(^|\/)specs?\/|CHANGELOG/i.test(f) &&
        (/(^|\/)(CLAUDE|AGENTS|GEMINI|CONTRIBUTING|ARCHITECTURE|CONVENTIONS|STYLEGUIDE|STRUCTURE)\.md$/i.test(f) ||
          /constitution\.md$/i.test(f) ||
          /^\.cursor\/rules\//.test(f) ||
          /^\.cursorrules$/.test(f) ||
          /^\.github\/(copilot-instructions\.md|instructions\/)/.test(f) ||
          /^\.claude\/rules\//.test(f) ||
          (/\.(md|mdx)$/.test(f) &&
            (/(^|\/)(adrs?|decisions|standards|conventions|guidelines|architecture)\//i.test(f) ||
              /(^|\/)[^/]*(architecture|convention|naming|structure|boundar|layering)[^/]*\.mdx?$/i.test(f)))),
    )
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const projectSkills = list
    .filter((f) => /^\.(claude|agents|cursor)\/skills\/[^/]+\/SKILL\.md$/.test(f))
    .filter((f) => {
      try {
        const head = fs.readFileSync(path.join(repoRoot, f), "utf8").slice(0, 1500);
        return /(file structure|folder|placement|reorganiz|restructur|where (code|files?) (lives|belongs)|grab-bag|tidy)/i.test(head);
      } catch {
        return false;
      }
    });
  const enforced = [];
  for (const f of list) {
    if (/^\.dependency-cruiser\.(c?js|json)$/.test(path.basename(f)) || /(^|\/)knip\.jsonc?$/.test(f)) enforced.push({ file: f, what: "dependency rules" });
    else if (/(^|\/)(\.eslintrc(\.\w+)?|eslint\.config\.[cm]?[jt]s)$/.test(f)) {
      const text = (() => {
        try {
          return fs.readFileSync(path.join(repoRoot, f), "utf8");
        } catch {
          return "";
        }
      })();
      const rules = ["no-restricted-imports", "import/no-restricted-paths", "boundaries/", "import/no-cycle", "enforce-module-boundaries", "no-restricted-syntax"].filter((r) => text.includes(r));
      if (rules.length) enforced.push({ file: f, what: `lint rules: ${rules.join(", ")}` });
    }
  }
  const guardTests = list.filter((f) => {
    if (!/\.(test|spec)\.[cm]?[jt]sx?$/.test(f)) return false;
    if (/\.guard\.(test|spec)\.|(^|[/.-])(boundar|architecture|structure|layering)[^/]*\.(test|spec)\./i.test(f)) return true;
    try {
      const text = fs.readFileSync(path.join(repoRoot, f), "utf8");
      return text.length < 200000 && /\b(readdirSync|globSync|fast-glob|globby|walkSync)\b/.test(text) && /["'`/]src\b|__dirname|process\.cwd\(\)/.test(text);
    } catch {
      return false;
    }
  });
  return { docs: docs.slice(0, 80), docsTotal: docs.length, projectSkills, enforced, guardTests };
}

function gitConventions() {
  const head = git("symbolic-ref", "--short", "refs/remotes/origin/HEAD").trim().replace(/^origin\//, "");
  const current = git("branch", "--show-current").trim();
  const branches = git("for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes")
    .split("\n")
    .map((b) => b.trim().replace(/^origin\//, ""))
    .filter((b) => b && b !== "HEAD" && b !== "origin");
  const longLived = ["main", "master", "dev", "develop", "development", "staging", "production", "release"].filter((b) => branches.includes(b));
  const prefixes = {};
  let ticketed = 0;
  for (const b of new Set(branches)) {
    if (b.includes("/")) prefixes[b.split("/")[0]] = (prefixes[b.split("/")[0]] ?? 0) + 1;
    if (/[A-Z][A-Z0-9]+-\d+/.test(b)) ticketed++;
  }
  const subjects = git("log", "-n", "200", "--format=%s").split("\n").filter(Boolean);
  const conventional = subjects.filter((s) => /^[a-z]+(\([^)]+\))?!?: /.test(s)).length;
  return {
    defaultBranch: head || longLived[0] || current || null,
    currentBranch: current || null,
    protectedBranches: [...new Set([head, ...longLived].filter(Boolean))],
    branchPrefixes: Object.entries(prefixes).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p, n]) => `${p}/ (${n})`),
    branchesWithTicketIds: ticketed,
    commitStyle: subjects.length ? (pct(conventional, subjects.length) >= 60 ? `conventional commits (${pct(conventional, subjects.length)}% of the last ${subjects.length})` : `free-form (${pct(conventional, subjects.length)}% conventional)`) : "no history",
    recentSubjects: subjects.slice(0, 5),
  };
}

const roots = [];
for (const dir of candidateDirs) {
  const hasJs = listSources(dir, notInWorkspace(dir)).length > 0;
  if (!hasJs) {
    nonJsWorkspaces.push(rel(dir));
    continue;
  }
  roots.push(analyseRoot(dir));
}
const otherLanguageDirs = fs
  .readdirSync(repoRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
  .filter((e) => ["pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "Gemfile", "composer.json", "main.tf"].some((m) => exists(path.join(repoRoot, e.name, m))))
  .map((e) => e.name);

const conventions = conventionSources();
const gitInfo = gitConventions();
const docDirs = ["docs", "doc", "documentation"].filter((d) => exists(path.join(repoRoot, d)));

const result = {
  generatedAt: new Date().toISOString(),
  repoRoot: toPosix(repoRoot),
  packageManager,
  workspaces: workspaceDirs.map(rel),
  roots,
  outOfReach: { nonJsWorkspaces, otherLanguageDirs },
  conventions,
  git: gitInfo,
  presetsAvailable: listPresets(),
};

const draft = {
  $comment: "Draft written by tidy-tree discover.mjs. Every rule here should describe how THIS project already works; review it with the user before saving.",
  ...(roots.length === 1 && roots[0].framework.presets.length ? { extends: roots[0].framework.presets } : {}),
  roots: roots.map((r) => ({
    name: r.name.replace(/^@[^/]+\//, ""),
    dir: r.dir,
    src: r.src,
    ...(r.tsconfig ? { tsconfig: r.tsconfig } : {}),
    ...(roots.length > 1 && r.framework.presets.length ? { extends: r.framework.presets } : {}),
    ...(r.include.length ? { include: r.include } : {}),
    ...(r.entryPoints.length ? { entryPoints: r.entryPoints } : {}),
    ...(r.sharedRoots.length ? { sharedRoots: r.sharedRoots } : {}),
    ...(r.areaRoots.length ? { areaRoots: r.areaRoots } : {}),
    ...(r.proposedLayers.length ? { layers: r.proposedLayers } : {}),
    verify: r.verify,
  })),
  protected: [],
  standards: [...conventions.docs.slice(0, 40), ...conventions.projectSkills, ...conventions.enforced.map((e) => e.file)],
  docs: [...docDirs, ":(glob)*.md", ":(glob)**/README.md", ...(exists(path.join(repoRoot, ".claude")) ? [".claude"] : [])],
  git: {
    protectedBranches: gitInfo.protectedBranches,
    commits: "user",
  },
};

if (args.out) fs.writeFileSync(path.resolve(String(args.out)), JSON.stringify(result, null, 2));
if (args["config-out"]) {
  const out = path.resolve(String(args["config-out"]));
  if (exists(out) && !args.force) {
    console.error(`${out} exists; pass --force to overwrite the draft`);
    process.exit(1);
  }
  fs.writeFileSync(out, JSON.stringify(draft, null, 2) + "\n");
}

const line = (s = "") => console.log(s);
line(`# architecture of ${path.basename(repoRoot)} (${packageManager}${workspaceDirs.length ? `, ${workspaceDirs.length} workspaces` : ""})`);
if (!roots.length) line("\nNo JavaScript or TypeScript sources found. tidy-tree's scripts only understand JS/TS.");
for (const r of roots) {
  line(`\n## root ${r.name}: ${r.dir}/${r.src === "." ? "" : r.src} (${r.productionFiles} source files, ${r.files - r.productionFiles} tests/stories)`);
  line(`- framework: ${r.framework.name}${r.framework.presets.length ? ` -> preset ${r.framework.presets.join(", ")}` : " (no preset; describe entry points by hand)"}${r.framework.partial ? " (component files in non-JS formats are invisible to the scripts)" : ""}`);
  line(`- organisation: ${r.style}`);
  line(`- top folders: ${r.topFolders.slice(0, 12).map((t) => `${t.name}(${t.files}${t.kind === "kind" ? ",kind" : ""})`).join(" ")}`);
  for (const f of r.featureSubfolders) line(`- ${f.parent}/ holds ${f.features} features; ${f.withKindFolders} of them have kind subfolders inside`);
  line(`- tests: ${r.testPlacement.convention} (${r.testPlacement.share}%)`);
  line(`- barrels: ${r.barrels.foldersWithIndex}/${r.barrels.folders} folders have an index file (${r.barrels.share}%)`);
  line(`- imports: ${r.imports.aliasShare}% alias ${JSON.stringify(r.imports.aliasPrefixes)}; ${r.imports.relativeWithExtensionShare}% of relative imports carry a file extension`);
  if (r.imports.aliases.length) line(`- aliases: ${r.imports.aliases.join(", ")}`);
  const names = Object.entries(r.naming).slice(0, 20);
  if (names.length) line(`- file naming: ${names.map(([k, d]) => `${k}=${d.convention} ${d.share}%`).join("; ")}`);
  line(`- dependency direction (runtime imports between top folders):`);
  for (const d of r.dependencyDirection.slice(0, 10)) line(`    ${d.from} -> ${d.to}: ${d.imports}${d.reverse ? ` (reverse ${d.reverse})` : ""}`);
  if (r.proposedLayers.length) line(`- proposed observed layer rules: ${r.proposedLayers.map((l) => `${l.from} must not import ${l.to}`).join("; ")}`);
  if (r.entryPoints.length) line(`- package entry points: ${r.entryPoints.join(", ")}`);
  line(`- verify: ${Object.entries(r.verify).map(([k, v]) => `${k}=\`${v}\``).join(", ")}`);
}
line(`\n## conventions written down`);
line(conventions.docs.length ? conventions.docs.slice(0, 25).map((d) => `- ${d}`).join("\n") + (conventions.docsTotal > 25 ? `\n- … ${conventions.docsTotal - 25} more in --out` : "") : "- none found: placement will follow the conventions observed above");
if (conventions.projectSkills.length) line(`\n## project skills about file placement (read their references; they encode this repo's rules)\n${conventions.projectSkills.map((d) => `- ${d}`).join("\n")}`);
if (conventions.enforced.length) line(`\n## rules enforced by tooling\n${conventions.enforced.map((e) => `- ${e.file}: ${e.what}`).join("\n")}`);
if (conventions.guardTests.length) line(`\n## tests that read source files or enforce structure (run them after any move)\n${conventions.guardTests.map((g) => `- ${g}`).join("\n")}`);
line(`\n## git`);
line(`- default branch ${gitInfo.defaultBranch ?? "?"}; protected: ${gitInfo.protectedBranches.join(", ") || "none detected"}`);
line(`- branch prefixes: ${gitInfo.branchPrefixes.join(", ") || "none"}; ${gitInfo.branchesWithTicketIds} branches carry ticket ids`);
line(`- commits: ${gitInfo.commitStyle}`);
if (nonJsWorkspaces.length || otherLanguageDirs.length) line(`\n## out of reach (not JS/TS): ${[...nonJsWorkspaces, ...otherLanguageDirs].join(", ")}`);
if (args.out) line(`\nfull JSON: ${args.out}`);
if (args["config-out"]) line(`draft config: ${args["config-out"]}`);
