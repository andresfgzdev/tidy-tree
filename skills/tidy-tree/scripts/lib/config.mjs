import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findTsconfig, toPosix } from "./project.mjs";

const PRESETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../presets");
export const CONFIG_NAMES = ["tidy-tree.config.json", ".tidy-tree.json"];

const ROOT_RULE_KEYS = [
  "sharedRoots", "areaRoots", "areaDepth", "layers", "entryPoints", "neverMove", "protected", "frameworkExports", "tests", "scopes", "exclude", "verify",
];

const DEFAULTS = {
  tests: [
    "**/__tests__/**",
    "**/__mocks__/**",
    "**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
    "../test/**",
    "../tests/**",
    "../spec/**",
    "../e2e/**",
    "../cypress/**",
    "../playwright/**",
    "../__tests__/**",
  ],
  areaDepth: 2,
  sharedRoots: [],
  areaRoots: [],
  layers: [],
  entryPoints: [],
  neverMove: [],
  protected: [],
  frameworkExports: [],
  scopes: {},
  exclude: [],
  docs: [],
  standards: [],
  verify: {},
  git: {},
  thresholds: {},
};

const GLOB_CHARS = /[*?{]/;
const globCache = new Map();

export function globToRegExp(glob) {
  if (globCache.has(glob)) return globCache.get(glob);
  let g = String(glob).replace(/^\.\//, "");
  const dirPrefix = !GLOB_CHARS.test(g);
  if (g.endsWith("/")) g = g.slice(0, -1) + "/**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += "(?:" + g.slice(i + 1, end).split(",").map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join("|") + ")";
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  const out = new RegExp(`^${re}${dirPrefix ? "(?:/.*)?" : ""}$`);
  globCache.set(glob, out);
  return out;
}

export function matchesAny(rel, globs) {
  return (globs ?? []).some((g) => globToRegExp(g).test(rel));
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

export function mergeConfig(a, b) {
  if (b === undefined) return a;
  if (Array.isArray(a) && Array.isArray(b)) {
    const seen = new Set();
    return [...a, ...b].filter((x) => {
      const k = JSON.stringify(x);
      return seen.has(k) ? false : seen.add(k);
    });
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in a ? mergeConfig(a[k], v) : v;
    return out;
  }
  return b;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`could not read ${file}: ${e.message}`);
  }
}

function loadPreset(name, fromDir, seen = new Set()) {
  const file = /[\\/]|\.json$/.test(name) ? path.resolve(fromDir, name) : path.join(PRESETS_DIR, `${name}.json`);
  if (seen.has(file)) throw new Error(`preset cycle through ${name}`);
  if (!fs.existsSync(file)) {
    const known = fs.existsSync(PRESETS_DIR) ? fs.readdirSync(PRESETS_DIR).map((f) => f.replace(/\.json$/, "")) : [];
    throw new Error(`unknown preset "${name}". Built-in presets: ${known.join(", ")}`);
  }
  seen.add(file);
  return expandExtends(readJson(file), path.dirname(file), seen);
}

function expandExtends(cfg, fromDir, seen = new Set()) {
  const { extends: ext, ...rest } = cfg;
  let base = {};
  for (const name of [].concat(ext ?? [])) base = mergeConfig(base, loadPreset(name, fromDir, new Set(seen)));
  return mergeConfig(base, rest);
}

export function findConfigFile(repoRoot) {
  for (const n of CONFIG_NAMES) {
    const p = path.join(repoRoot, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function listPresets() {
  return fs.existsSync(PRESETS_DIR) ? fs.readdirSync(PRESETS_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")) : [];
}

export function loadConfig({ repoRoot, configPath, rootName, cli = {} }) {
  const file = configPath ? path.resolve(String(configPath)) : findConfigFile(repoRoot);
  let raw;
  if (file) raw = readJson(file);
  else if (cli.src) raw = { roots: [{ name: "cli", dir: cli.dir ?? ".", src: cli.src }] };
  else
    throw new Error(
      `no ${CONFIG_NAMES[0]} in ${repoRoot}. Run scripts/discover.mjs to draft one, then pass --config <file> or save it at the repository root.`,
    );
  const cfg = mergeConfig(DEFAULTS, expandExtends(raw, file ? path.dirname(file) : repoRoot));
  if (!Array.isArray(cfg.roots) || !cfg.roots.length) throw new Error(`${file ?? "config"}: "roots" must list at least one source root`);

  let root;
  if (rootName) {
    root = cfg.roots.find((r) => r.name === rootName);
    if (!root) throw new Error(`no root named "${rootName}"; roots: ${cfg.roots.map((r) => r.name).join(", ")}`);
  } else if (cfg.roots.length === 1) root = cfg.roots[0];
  else throw new Error(`this repository has several roots; pass --workspace <name> (one of: ${cfg.roots.map((r) => r.name).join(", ")})`);

  const rootExpanded = root.extends ? expandExtends({ extends: root.extends }, file ? path.dirname(file) : repoRoot) : {};
  const rules = {};
  for (const k of ROOT_RULE_KEYS) rules[k] = mergeConfig(mergeConfig(cfg[k], rootExpanded[k]), root[k]);
  for (const k of ["sharedRoots", "areaRoots", "entryPoints", "neverMove", "protected", "frameworkExports", "tests", "exclude"])
    rules[k] = [].concat(rules[k] ?? []);

  const dir = path.resolve(repoRoot, root.dir ?? ".");
  const src = path.resolve(dir, root.src ?? ".");
  if (src === dir) rules.tests = mergeConfig(rules.tests, ["test/**", "tests/**", "spec/**", "e2e/**", "cypress/**"]);
  const tsconfig = root.tsconfig ? path.resolve(dir, root.tsconfig) : findTsconfig(dir) ?? findTsconfig(src) ?? findTsconfig(repoRoot);
  const otherRoots = cfg.roots.filter((r) => r !== root).map((r) => path.resolve(repoRoot, r.dir ?? "."));
  const exclude = otherRoots.filter((d) => d !== dir && (d.startsWith(src + path.sep) || d.startsWith(dir + path.sep)));
  const isExcluded = (abs) =>
    exclude.some((x) => abs === x || abs.startsWith(x + path.sep)) || (rules.exclude.length > 0 && matchesAny(toPosix(path.relative(src, abs)), rules.exclude));

  return {
    configFile: file,
    repoRoot,
    root: {
      name: root.name ?? path.basename(dir),
      dir,
      src,
      tsconfig,
      include: [].concat(root.include ?? []).map((d) => path.resolve(dir, d)),
      rootFiles: root.rootFiles !== false,
      exclude,
      isExcluded,
    },
    rules,
    docs: cfg.docs,
    standards: cfg.standards,
    verify: rules.verify,
    git: cfg.git,
    thresholds: cfg.thresholds,
  };
}
