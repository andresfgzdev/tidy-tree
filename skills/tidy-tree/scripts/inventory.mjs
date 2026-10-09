#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, matchesAny, globToRegExp } from "./lib/config.mjs";
import {
  collectSpecifiers,
  markTypeOnlyUses,
  resolveRepoRoot,
  loadTypeScript,
  parseArgs,
  parseSource,
  toPosix,
  createResolver,
  listSources,
  rootLevelSources,
} from "./lib/project.mjs";

const USAGE = `inventory.mjs: facts about file placement, fan-in, tiny files, grab-bags and duplicates.

  node inventory.mjs --scope <token|dir,dir|full> [--config tidy-tree.config.json] [--workspace <root name>]
                     [--out file.json] [--top 15] [--tiny 6] [--dup-lines 5] [--grab-exports 15] [--grab-lines 300]
                     [--near-lines 10] [--near-sim 0.8] [--mixed-exports 4] [--root <repo>] [--ts path/to/node_modules/typescript]

Reads tidy-tree.config.json at the repository root (or --config). --scope takes "full", "shared"
(the config's sharedRoots), a named scope from the config's "scopes", or folders relative to the
root's src. The import graph always covers the whole root, so fan-in counts are complete even
for a narrow scope. Prints a compact summary; the full JSON goes to --out.`;

process.on("uncaughtException", (e) => {
  console.error(`error: ${e?.message ?? e}`);
  if (process.env.TIDY_TREE_DEBUG) console.error(e?.stack);
  process.exit(1);
});

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.scope) {
  console.log(USAGE);
  process.exit(args.help ? 0 : 1);
}

const repoRoot = resolveRepoRoot(args.root);
const cfg = loadConfig({ repoRoot, configPath: args.config, rootName: args.workspace, cli: { src: args.src, dir: args.dir } });
const { rules } = cfg;
const appDir = cfg.root.dir;
const srcDir = cfg.root.src;
const ts = loadTypeScript([appDir, repoRoot], args.ts);
const resolver = createResolver(ts, cfg.root.tsconfig);
const resolveSpecifier = (spec, from) => resolver.resolve(spec, from);
const th = cfg.thresholds ?? {};
const num = (v, key, d) => (v !== undefined ? Number(v) : th[key] !== undefined ? Number(th[key]) : d);
const TOP = num(args.top, "top", 15);
const TINY = num(args.tiny, "tiny", 6);
const DUP_LINES = num(args["dup-lines"], "dupLines", 5);
const NEAR_LINES = num(args["near-lines"], "nearLines", 10);
const NEAR_SIM = num(args["near-sim"], "nearSim", 0.8);
const GRAB_EXPORTS = num(args["grab-exports"], "grabExports", 15);
const GRAB_LINES = num(args["grab-lines"], "grabLines", 300);
const MIXED_EXPORTS = num(args["mixed-exports"], "mixedExports", 4);
const AREA_DEPTH = Number(rules.areaDepth ?? 2);
const SHARED = rules.sharedRoots.map((s) => s.replace(/\/$/, ""));
const srcRel = toPosix(path.relative(repoRoot, srcDir));
const normalizeScope = (s) => {
  let x = s.trim().replace(/\/$/, "");
  if (srcRel && srcRel !== "." && (x === srcRel || x.startsWith(srcRel + "/"))) x = x.slice(srcRel.length + 1);
  return x;
};
function expandScope(token) {
  if (token === "full") return [""];
  if (token === "shared") {
    if (!SHARED.length) {
      console.error(`note: the config has no "sharedRoots", so scope "shared" falls back to "full"`);
      return [""];
    }
    return SHARED;
  }
  if (rules.scopes[token]) return [].concat(rules.scopes[token]).map(normalizeScope);
  return [normalizeScope(token)];
}
const scopes = [...new Set(String(args.scope).split(",").filter(Boolean).flatMap(expandScope))];

const rel = (abs) => toPosix(path.relative(srcDir, abs));
const isTest = (r) => matchesAny(r, rules.tests);
const isStory = (r) => /\.stories\.[tj]sx?$/.test(r);
const stem = (r) => path.basename(r).replace(/\.[^.]+$/, "");
const inScope = (r) => !r.startsWith("..") && !isTest(r) && !isStory(r) && scopes.some((s) => s === "" || matchesAny(r, [s]));
const isEntry = (r) => matchesAny(r, rules.entryPoints);
const FRAMEWORK_EXPORTS = new Set(rules.frameworkExports);
const areaRootRes = rules.areaRoots.map(globToRegExp);

function areaOf(r) {
  if (isTest(r)) return "tests";
  if (r.startsWith("../")) return r.split("/").slice(0, 2).join("/");
  const dirs = r.split("/").filter((seg) => !/^\(.*\)$/.test(seg)).slice(0, -1);
  if (!dirs.length) return "(root)";
  for (let n = dirs.length; n >= 1; n--) {
    const prefix = dirs.slice(0, n).join("/");
    if (areaRootRes.some((re) => re.test(prefix))) return prefix;
  }
  return dirs.slice(0, AREA_DEPTH).join("/");
}

const files = [
  ...new Set([
    ...listSources(srcDir, cfg.root.isExcluded),
    ...cfg.root.include.flatMap((d) => listSources(d, cfg.root.isExcluded)),
    ...(cfg.root.rootFiles ? rootLevelSources(appDir) : []),
  ]),
];
const info = new Map();

function lineOf(sf, pos) {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function normalize(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, text);
  const out = [];
  for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) out.push(scanner.getTokenText());
  return out.join(" ");
}

function anonymizedTokens(ts, node, sf) {
  const ids = new Map();
  const out = [];
  const visit = (n) => {
    if (ts.isIdentifier(n)) {
      if (!ids.has(n.text)) ids.set(n.text, `$${ids.size}`);
      out.push(ids.get(n.text));
    } else if (n.getChildCount(sf) === 0) out.push(n.getText(sf));
    else n.getChildren(sf).forEach(visit);
  };
  visit(node);
  return out;
}

function shingles(tokens, k = 4) {
  const set = new Set();
  for (let i = 0; i + k <= tokens.length; i++) set.add(tokens.slice(i, i + k).join(" "));
  return set;
}

function jaccard(a, b) {
  let inter = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function structuralHash(ts, node, sf) {
  const ids = new Map();
  let out = "";
  const visit = (n) => {
    if (ts.isIdentifier(n)) {
      if (!ids.has(n.text)) ids.set(n.text, `$${ids.size}`);
      out += ids.get(n.text) + " ";
    } else if (n.getChildCount(sf) === 0) out += n.getText(sf) + " ";
    else n.getChildren(sf).forEach(visit);
  };
  visit(node);
  return crypto.createHash("sha1").update(out).digest("hex").slice(0, 12);
}

for (const abs of files) {
  const text = fs.readFileSync(abs, "utf8");
  const sf = parseSource(ts, abs, text);
  const r = rel(abs);
  const lines = text.split("\n").length;
  const nonBlank = text.split("\n").filter((l) => l.trim() && !/^\s*(\/\/|\/\*|\*)/.test(l)).length;
  const exportsList = [];
  const functions = [];
  const declarations = [];
  let statementsAreReexports = sf.statements.length > 0;
  let typeOnlyStatements = sf.statements.length > 0;

  for (const st of sf.statements) {
    const mods = ts.canHaveModifiers?.(st) ? ts.getModifiers(st) ?? [] : st.modifiers ?? [];
    const exported = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    const span = lineOf(sf, st.getEnd()) - lineOf(sf, st.getStart(sf)) + 1;
    const isReexport = ts.isExportDeclaration(st) && Boolean(st.moduleSpecifier);
    if (!isReexport && !ts.isImportDeclaration(st)) statementsAreReexports = false;
    const isTypeDecl = ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st);
    if (!isTypeDecl && !ts.isImportDeclaration(st) && !(ts.isExportDeclaration(st) && st.isTypeOnly)) typeOnlyStatements = false;

    const record = (name, kind, node) => {
      const entry = { name, kind, line: lineOf(sf, st.getStart(sf)), lines: span, typeOnly: isTypeDecl };
      if (exported) exportsList.push(entry);
      declarations.push({ ...entry, exported, file: r, norm: normalize(node.getText(sf).replace(new RegExp(`\\b${name}\\b`, "g"), "_")) });
    };

    if (ts.isFunctionDeclaration(st) && st.name) {
      record(isDefault ? "default" : st.name.text, "function", st);
      if (st.body) functions.push({ name: st.name.text, node: st.body, start: st.getStart(sf), exported });
    } else if (ts.isClassDeclaration(st) && st.name) record(isDefault ? "default" : st.name.text, "class", st);
    else if (ts.isInterfaceDeclaration(st)) record(st.name.text, "interface", st);
    else if (ts.isTypeAliasDeclaration(st)) record(st.name.text, "type", st);
    else if (ts.isEnumDeclaration(st)) record(st.name.text, "enum", st);
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const init = d.initializer;
        const fnLike = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        record(d.name.text, fnLike ? "function" : "const", d);
        if (fnLike) functions.push({ name: d.name.text, node: init.body, start: d.getStart(sf), exported });
      }
    } else if (ts.isExportAssignment(st)) exportsList.push({ name: "default", kind: "default", line: lineOf(sf, st.getStart(sf)), lines: span });
    else if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) exportsList.push({ name: el.name.text, kind: "export-list", line: lineOf(sf, st.getStart(sf)), lines: 1 });
    }
  }

  const specs = markTypeOnlyUses(ts, sf, collectSpecifiers(ts, sf));
  for (const s of specs) {
    if (s.kind === "reexport") for (const n of s.names) exportsList.push({ name: n, kind: "reexport", from: s.spec, line: 0, lines: 1 });
  }

  info.set(abs, {
    file: r,
    area: areaOf(r),
    lines,
    nonBlank,
    isBarrel: statementsAreReexports && specs.some((s) => s.kind === "reexport"),
    typeOnlyFile: typeOnlyStatements,
    exports: exportsList,
    functions,
    declarations,
    sf,
    specs,
    importers: [],
    preview: text.split("\n").filter((l) => l.trim()).slice(0, 4).join("\n"),
  });
}

const unresolved = [];
const typeNamesOf = (abs) => new Set(info.get(abs).declarations.filter((d) => d.typeOnly && d.exported).map((d) => d.name));
for (const [abs, f] of info) {
  for (const s of f.specs) {
    const target = resolveSpecifier(s.spec, abs);
    if (target && info.has(target) && !s.typeOnly && (s.kind === "import" || s.kind === "reexport") && s.names.length && !s.names.some((n) => n === "*" || n === "default")) {
      const typeNames = typeNamesOf(target);
      if (s.names.every((n) => typeNames.has(n))) s.typeOnly = true;
    }
    if (!target && resolver.looksLocal(s.spec)) unresolved.push({ file: f.file, spec: s.spec, kind: s.kind });
    if (!target || !info.has(target) || target === abs) continue;
    info.get(target).importers.push({ file: f.file, area: f.area, test: isTest(f.file), names: s.names, kind: s.kind });
  }
}

const scoped = [...info.values()].filter((f) => inScope(f.file));
if (!scoped.length) {
  console.error(`no source files matched --scope ${args.scope} under ${srcRel || "."}; check the path`);
  process.exit(1);
}
const prodImporters = (f) => f.importers.filter((i) => !i.test);
const consumerAreas = (f) => {
  const counts = {};
  for (const i of prodImporters(f)) counts[i.area] = (counts[i.area] ?? 0) + 1;
  return counts;
};
const sharedRootOf = (r) => SHARED.length > 0 && matchesAny(r, SHARED);

const tiny = scoped
  .filter((f) => f.nonBlank <= TINY && !f.isBarrel && !isEntry(f.file))
  .map((f) => ({ file: f.file, nonBlank: f.nonBlank, importers: f.importers.length, preview: f.preview }));

const barrels = scoped
  .filter((f) => f.isBarrel)
  .map((f) => ({
    file: f.file,
    reexports: f.exports.filter((e) => e.kind === "reexport").length,
    importers: f.importers.length,
    passThrough: f.exports.length <= 2 && !f.exports.some((e) => e.name === "*"),
  }));

const grabBags = scoped
  .filter((f) => !f.isBarrel && (f.exports.length >= GRAB_EXPORTS || (f.nonBlank >= GRAB_LINES && f.exports.length >= 4) || (sharedRootOf(f.file) && f.exports.length >= MIXED_EXPORTS)))
  .map((f) => {
    const starImporters = f.importers.filter((i) => i.names.includes("*"));
    const perExport = f.exports
      .filter((e) => e.kind !== "reexport")
      .map((e) => {
        const users = f.importers.filter((i) => i.names.includes(e.name) || i.names.includes("*"));
        const areas = {};
        for (const u of users.filter((u) => !u.test)) areas[u.area] = (areas[u.area] ?? 0) + 1;
        const dominant = Object.entries(areas).sort((a, b) => b[1] - a[1])[0]?.[0] ?? (users.length ? "tests-only" : "unused");
        return { name: e.name, kind: e.kind, line: e.line, lines: e.lines, users: users.length, areas, dominant };
      });
    const groups = {};
    for (const e of perExport) (groups[e.dominant] ??= []).push(e.name);
    const big = f.exports.length >= GRAB_EXPORTS || (f.nonBlank >= GRAB_LINES && f.exports.length >= 4);
    const singleAreaExports = perExport.filter((e) => Object.keys(e.areas).length === 1 && e.dominant !== f.area);
    const mixed = new Set(singleAreaExports.map((e) => e.dominant)).size >= 2;
    return {
      file: f.file,
      reason: big ? "size" : mixed ? "mixed-consumers" : null,
      nonBlank: f.nonBlank,
      exports: f.exports.length,
      importers: f.importers.length,
      consumerAreas: Object.keys(consumerAreas(f)).length,
      starImporters: starImporters.length,
      proposedGroups: Object.entries(groups)
        .map(([area, names]) => ({ area, count: names.length, names }))
        .sort((a, b) => b.count - a.count),
      perExport,
    };
  })
  .filter((g) => g.reason)
  .sort((a, b) => b.consumerAreas * b.exports - a.consumerAreas * a.exports);

const singleConsumer = scoped
  .filter((f) => sharedRootOf(f.file) && !f.isBarrel && prodImporters(f).length > 0)
  .map((f) => ({ f, areas: consumerAreas(f) }))
  .filter(({ f, areas }) => Object.keys(areas).length === 1 && Object.keys(areas)[0] !== f.area)
  .map(({ f, areas }) => ({
    file: f.file,
    onlyConsumerArea: Object.keys(areas)[0],
    importers: prodImporters(f).map((i) => i.file),
    nonBlank: f.nonBlank,
  }));

const dirs = new Map();
for (const f of scoped) {
  const d = path.posix.dirname(f.file);
  (dirs.get(d) ?? dirs.set(d, []).get(d)).push(f);
}
const loose = [];
for (const [d, list] of dirs) {
  const absDir = path.join(srcDir, d);
  if (!fs.existsSync(absDir)) continue;
  const subdirs = fs.readdirSync(absDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("__")).map((e) => e.name);
  if (!subdirs.length) continue;
  const looseFiles = list.filter((f) => stem(f.file) !== "index" && !isEntry(f.file));
  const matches = looseFiles
    .map((f) => {
      const s = stem(f.file).toLowerCase();
      const hit = subdirs.find((sd) => {
        const n = sd.toLowerCase();
        return s === n || s.startsWith(n + "-") || s.endsWith("-" + n) || s.replace(/-/g, "") === n.replace(/-/g, "");
      });
      return hit ? { file: f.file, suggestedDir: `${d}/${hit}` } : null;
    })
    .filter(Boolean);
  if (matches.length) loose.push({ dir: d, subdirs: subdirs.length, looseFiles: looseFiles.map((f) => f.file), nameMatches: matches });
}

const fnGroups = new Map();
for (const f of info.values()) {
  if (isTest(f.file) || isStory(f.file) || f.file.startsWith("..")) continue;
  for (const fn of f.functions) {
    const span = lineOf(f.sf, fn.node.getEnd()) - lineOf(f.sf, fn.node.getStart(f.sf)) + 1;
    if (span < DUP_LINES) continue;
    const exact = crypto.createHash("sha1").update(normalize(fn.node.getText(f.sf))).digest("hex").slice(0, 12);
    const shape = structuralHash(ts, fn.node, f.sf);
    for (const [key, kind] of [[`e:${exact}`, "exact"], [`s:${shape}`, "renamed"]]) {
      (fnGroups.get(key) ?? fnGroups.set(key, []).get(key)).push({ file: f.file, name: fn.name, line: lineOf(f.sf, fn.start), lines: span, kind, exported: fn.exported });
    }
  }
}
const seenPairs = new Set();
const duplicates = [];
for (const [key, members] of fnGroups) {
  const filesInvolved = new Set(members.map((m) => m.file));
  if (members.length < 2 || filesInvolved.size < 2) continue;
  const id = members.map((m) => `${m.file}#${m.name}`).sort().join("|");
  if (seenPairs.has(id)) continue;
  seenPairs.add(id);
  const touchesScope = members.some((m) => inScope(m.file));
  if (!touchesScope) continue;
  duplicates.push({ match: key.startsWith("e:") ? "exact" : "renamed", lines: members[0].lines, members: members.map(({ kind, ...m }) => m) });
}
duplicates.sort((a, b) => b.lines * b.members.length - a.lines * a.members.length);

const byName = new Map();
for (const f of info.values()) {
  if (isTest(f.file) || isStory(f.file) || f.file.startsWith("..")) continue;
  for (const d of f.declarations) {
    if (!d.exported || d.name === "default" || d.name.length < 3) continue;
    if (isEntry(f.file) && FRAMEWORK_EXPORTS.has(d.name)) continue;
    (byName.get(d.name) ?? byName.set(d.name, []).get(d.name)).push(d);
  }
}
const sameName = [];
for (const [name, decls] of byName) {
  if (new Set(decls.map((d) => d.file)).size < 2) continue;
  if (!decls.some((d) => inScope(d.file))) continue;
  const identical = new Set(decls.map((d) => d.norm)).size === 1;
  sameName.push({ name, identical, kinds: [...new Set(decls.map((d) => d.kind))], files: decls.map((d) => `${d.file}:${d.line}`) });
}
sameName.sort((a, b) => Number(b.identical) - Number(a.identical) || b.files.length - a.files.length);

const orphans = scoped
  .filter((f) => f.importers.length === 0 && !isEntry(f.file))
  .map((f) => ({ file: f.file, nonBlank: f.nonBlank }));

const unusedExports = scoped
  .filter((f) => !isEntry(f.file) && f.importers.length > 0 && !f.importers.some((i) => i.names.includes("*")))
  .map((f) => {
    const used = new Set(f.importers.flatMap((i) => i.names));
    const unused = f.exports.filter((e) => e.kind !== "reexport" && !used.has(e.name)).map((e) => e.name);
    return { file: f.file, unused, exports: f.exports.length };
  })
  .filter((u) => u.unused.length)
  .sort((a, b) => b.unused.length - a.unused.length);

const folderStats = [...dirs.entries()]
  .map(([d, list]) => ({ dir: d, files: list.length, nonBlank: list.reduce((n, f) => n + f.nonBlank, 0) }))
  .sort((a, b) => b.files - a.files);

const exactPairs = new Set(duplicates.flatMap((d) => d.members.flatMap((a) => d.members.map((b) => `${a.file}#${a.name}|${b.file}#${b.name}`))));
const nearPool = [];
for (const f of info.values()) {
  if (isTest(f.file) || isStory(f.file) || f.file.startsWith("..")) continue;
  for (const fn of f.functions) {
    const span = lineOf(f.sf, fn.node.getEnd()) - lineOf(f.sf, fn.node.getStart(f.sf)) + 1;
    if (span < NEAR_LINES) continue;
    const sh = shingles(anonymizedTokens(ts, fn.node, f.sf));
    nearPool.push({ file: f.file, name: fn.name, line: lineOf(f.sf, fn.start), lines: span, sh, scoped: inScope(f.file) });
  }
}
nearPool.sort((a, b) => a.sh.size - b.sh.size);
const nearDuplicates = [];
for (let i = 0; i < nearPool.length; i++) {
  const a = nearPool[i];
  for (let j = i + 1; j < nearPool.length; j++) {
    const b = nearPool[j];
    if (b.sh.size > a.sh.size / NEAR_SIM) break;
    if (a.file === b.file || !(a.scoped || b.scoped)) continue;
    if (exactPairs.has(`${a.file}#${a.name}|${b.file}#${b.name}`)) continue;
    const sim = jaccard(a.sh, b.sh);
    if (sim >= NEAR_SIM && sim < 1) nearDuplicates.push({ similarity: Number(sim.toFixed(2)), lines: Math.max(a.lines, b.lines), members: [a, b].map(({ sh, scoped, ...m }) => m) });
  }
}
const parent = new Map();
const find = (k) => (parent.get(k) === k ? k : (parent.set(k, find(parent.get(k))), parent.get(k)));
const memberOf = new Map();
for (const pair of nearDuplicates) {
  const [a, b] = pair.members.map((m) => `${m.file}#${m.name}`);
  pair.members.forEach((m, i) => memberOf.set(i ? b : a, m));
  for (const k of [a, b]) if (!parent.has(k)) parent.set(k, k);
  parent.set(find(a), find(b));
}
const grouped = new Map();
for (const pair of nearDuplicates) {
  const root = find(`${pair.members[0].file}#${pair.members[0].name}`);
  const g = grouped.get(root) ?? grouped.set(root, { keys: new Set(), minSimilarity: 1, lines: 0 }).get(root);
  pair.members.forEach((m) => g.keys.add(`${m.file}#${m.name}`));
  g.minSimilarity = Math.min(g.minSimilarity, pair.similarity);
  g.lines = Math.max(g.lines, pair.lines);
}
const nearDuplicateGroups = [...grouped.values()]
  .map((g) => ({ minSimilarity: g.minSimilarity, lines: g.lines, members: [...g.keys].map((k) => memberOf.get(k)) }))
  .sort((a, b) => b.members.length * b.lines - a.members.length * a.lines);

const LAYER_RULES = rules.layers.map((l, i) => {
  if (!l.from || !l.to) throw new Error(`layers[${i}] needs "from" and "to" globs`);
  return { ...l, basis: l.basis ?? (l.source ? "documented" : "heuristic") };
});
const layerViolations = [];
for (const [abs, f] of info) {
  if (!inScope(f.file)) continue;
  for (const s of f.specs) {
    if (s.kind === "mock") continue;
    const target = resolveSpecifier(s.spec, abs);
    if (!target || !info.has(target)) continue;
    const t = info.get(target).file;
    const rule = LAYER_RULES.find(
      (r) =>
        matchesAny(f.file, [].concat(r.from)) &&
        matchesAny(t, [].concat(r.to)) &&
        !matchesAny(f.file, r.exceptFrom) &&
        !matchesAny(t, r.exceptTo) &&
        !(r.allowTypeOnly && s.typeOnly),
    );
    if (rule) layerViolations.push({ file: f.file, imports: t, typeOnly: s.typeOnly, basis: rule.basis, source: rule.source ?? null, why: rule.why ?? `${rule.from} must not import ${rule.to}` });
  }
}

const graph = new Map();
for (const [abs, f] of info) {
  if (isTest(f.file) || f.file.startsWith("..")) continue;
  const outs = new Set();
  for (const s of f.specs) {
    if (s.kind === "mock" || s.kind === "import-type" || s.typeOnly) continue;
    const t = resolveSpecifier(s.spec, abs);
    if (t && info.has(t) && t !== abs) outs.add(t);
  }
  graph.set(abs, outs);
}
const sccs = [];
{
  let index = 0;
  const stack = [];
  const meta = new Map();
  for (const root of graph.keys()) {
    if (meta.has(root)) continue;
    const work = [{ v: root, it: (graph.get(root) ?? new Set()).values() }];
    meta.set(root, { index, low: index++, on: true });
    stack.push(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const next = frame.it.next();
      if (!next.done) {
        const w = next.value;
        if (!graph.has(w)) continue;
        if (!meta.has(w)) {
          meta.set(w, { index, low: index++, on: true });
          stack.push(w);
          work.push({ v: w, it: graph.get(w).values() });
        } else if (meta.get(w).on) meta.get(frame.v).low = Math.min(meta.get(frame.v).low, meta.get(w).index);
        continue;
      }
      work.pop();
      const mv = meta.get(frame.v);
      if (work.length) {
        const parent = meta.get(work[work.length - 1].v);
        parent.low = Math.min(parent.low, mv.low);
      }
      if (mv.low === mv.index) {
        const comp = [];
        let w;
        do {
          w = stack.pop();
          meta.get(w).on = false;
          comp.push(w);
        } while (w !== frame.v);
        if (comp.length > 1) sccs.push(comp);
      }
    }
  }
}
const importCycles = sccs
  .map((c) => c.map((a) => info.get(a).file))
  .filter((c) => c.some(inScope))
  .map((files) => ({ size: files.length, files: files.sort() }))
  .sort((a, b) => a.size - b.size);

const result = {
  generatedAt: new Date().toISOString(),
  repoRoot: toPosix(repoRoot),
  configFile: cfg.configFile ? toPosix(path.relative(repoRoot, cfg.configFile)) : null,
  root: cfg.root.name,
  srcDir: srcRel || ".",
  scope: scopes,
  thresholds: { TINY, DUP_LINES, NEAR_LINES, NEAR_SIM, GRAB_EXPORTS, GRAB_LINES, MIXED_EXPORTS, SHARED, AREA_DEPTH },
  totals: { graphFiles: info.size, scopedFiles: scoped.length },
  folderStats,
  grabBags,
  tiny,
  barrels,
  singleConsumer,
  loose,
  duplicates,
  nearDuplicateGroups,
  layerViolations,
  importCycles,
  sameName,
  orphans,
  unusedExports,
  unresolved,
  files: scoped.map((f) => ({
    file: f.file,
    area: f.area,
    nonBlank: f.nonBlank,
    isBarrel: f.isBarrel,
    typeOnlyFile: f.typeOnlyFile,
    exports: f.exports.map((e) => e.name),
    importers: f.importers.length,
    testImporters: f.importers.filter((i) => i.test).length,
    consumerAreas: consumerAreas(f),
  })),
};

if (args.out) fs.writeFileSync(path.resolve(args.out), JSON.stringify(result, null, 2));

const head = (title, list, fmt) => {
  console.log(`\n## ${title} (${list.length})`);
  for (const x of list.slice(0, TOP)) console.log("- " + fmt(x));
  if (list.length > TOP) console.log(`- … ${list.length - TOP} more in --out`);
};
console.log(`# inventory: root=${cfg.root.name} scope=${scopes.map((x) => x || "full").join(",")} scoped=${scoped.length} graph=${info.size}`);
head("folders by file count", folderStats, (x) => `${x.dir}: ${x.files} files, ${x.nonBlank} lines`);
head("grab-bag files", grabBags, (x) => `${x.file} [${x.reason}]: ${x.exports} exports, ${x.nonBlank} lines, ${x.importers} importers across ${x.consumerAreas} areas; groups ${x.proposedGroups.slice(0, 6).map((g) => `${g.area}=${g.count}`).join(" ")}`);
head(`tiny files (<= ${TINY} lines)`, tiny, (x) => `${x.file}: ${x.nonBlank} lines, ${x.importers} importers`);
head("pass-through barrels", barrels.filter((b) => b.passThrough), (x) => `${x.file}: ${x.reexports} re-exports, ${x.importers} importers`);
head("shared files with a single consumer area", singleConsumer, (x) => `${x.file} -> only ${x.onlyConsumerArea} (${x.importers.length} importers)`);
head("loose files matching a sibling folder", loose.flatMap((l) => l.nameMatches), (x) => `${x.file} -> ${x.suggestedDir}/`);
head(`duplicate function bodies (>= ${DUP_LINES} lines)`, duplicates, (x) => `${x.match} ${x.lines}L: ${x.members.map((m) => `${m.file}#${m.name}`).join("  ==  ")}`);
head(`near-duplicate functions (>= ${NEAR_LINES} lines, similarity >= ${NEAR_SIM})`, nearDuplicateGroups, (x) => `${x.members.length} copies ~${x.lines}L sim>=${x.minSimilarity}: ${x.members.map((m) => `${m.file}#${m.name}`).join("  ~  ")}`);
head("layer violations", layerViolations, (x) => `${x.file} -> ${x.imports}${x.typeOnly ? " (type-only)" : ""}: [${x.basis}] ${x.why}`);
head("import cycles involving the scope", importCycles, (x) => `${x.size} files: ${x.files.slice(0, 6).join(" <-> ")}${x.size > 6 ? " …" : ""}`);
head("same exported name in several files", sameName, (x) => `${x.name}${x.identical ? " (same text)" : ""} [${x.kinds.join("/")}]: ${x.files.join(", ")}`);
head("orphan files (no importers)", orphans, (x) => `${x.file}: ${x.nonBlank} lines`);
head("files with unused exports", unusedExports, (x) => `${x.file}: ${x.unused.length}/${x.exports} unused (${x.unused.slice(0, 6).join(", ")})`);
head("local-looking imports that did not resolve (check tsconfig/config before trusting fan-in)", unresolved, (x) => `${x.file}: "${x.spec}" (${x.kind})`);
if (args.out) console.log(`\nfull JSON: ${args.out}`);
