#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, matchesAny } from "./lib/config.mjs";
import {
  aliasFor,
  aliasPrefixOf,
  clearListCache,
  collectSpecifiers,
  createResolver,
  extensionStyle,
  listSources,
  loadTypeScript,
  parseArgs,
  parseSource,
  relativeSpecifier,
  resolveRepoRoot,
  rootLevelSources,
  specifierCandidates,
  toPosix,
  withExtension,
} from "./lib/project.mjs";

const USAGE = `rewrite-imports.mjs: move files or exports and rewire every importer. Dry run unless --apply.

  node rewrite-imports.mjs --map moves.json [--config tidy-tree.config.json] [--workspace <root name>]
                           [--root <repo>] [--apply] [--ts path/to/typescript]

moves.json is an array. Paths are relative to the root's src folder and must stay inside the root:
  { "op": "move",    "from": "types/billing-invoice.ts", "to": "types/billing/invoice.ts" }
      git mv the file, rebase its own relative imports, rewrite every importer.
  { "op": "merge",   "from": "lib/constants/order-status.ts", "to": "lib/constants/orders.ts" }
      you already copied the exports into "to"; rewrite importers to "to", then git rm "from".
      Refuses if an importer uses a name "to" does not export, or if "from" has uncommitted edits.
  { "op": "symbols", "from": "types/index.ts", "to": "types/charts/chart-config.ts", "symbols": ["ChartConfig", "ChartKind"] }
      you already moved those declarations into "to"; split every import of them off to "to".

Refuses any operation whose source is "protected", and moves or merges of a "neverMove" file.
Every rewritten specifier is checked to resolve to the intended file after the change; if no
specifier form does, the operation is refused. Untracked sources are refused before anything is written.
Operations run in order, each against the tree the previous one left. A dry run previews only
operations that don't depend on an earlier one in the same map; apply the earlier one first.
Importers keep their style: the same alias prefix, relative stays relative, file extensions kept.
Also rewrites jest/vitest mock, requireActual and import() strings, export-from statements, and
source files at the top of the root folder (bundler and framework configs) and .storybook.
Prints files changed, protected files touched, anything needing a manual look, and docs citing the old path.`;

process.on("uncaughtException", (e) => {
  console.error(`error: ${e?.message ?? e}`);
  if (process.env.TIDY_TREE_DEBUG) console.error(e?.stack);
  process.exit(1);
});

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.map) {
  console.log(USAGE);
  process.exit(args.help ? 0 : 1);
}

const repoRoot = resolveRepoRoot(args.root);
const cfg = loadConfig({ repoRoot, configPath: args.config, rootName: args.workspace, cli: { src: args.src, dir: args.dir } });
const { rules } = cfg;
const appDir = cfg.root.dir;
const srcDir = cfg.root.src;
const ts = loadTypeScript([appDir, repoRoot], args.ts);
let resolver = createResolver(ts, cfg.root.tsconfig);
const aliases = resolver.aliases;
const resolveSpecifier = (spec, from) => resolver.resolve(spec, from);
const APPLY = Boolean(args.apply);
const moves = JSON.parse(fs.readFileSync(path.resolve(String(args.map)), "utf8"));
const relRepo = (a) => toPosix(path.relative(repoRoot, a));
const relSrc = (a) => toPosix(path.relative(srcDir, a));
const git = (...a) => execFileSync("git", ["-C", repoRoot, ...a], { stdio: "pipe" }).toString();

function inside(r, field, i) {
  const p = path.resolve(srcDir, String(r ?? ""));
  if (!r || !p.startsWith(appDir + path.sep) || cfg.root.isExcluded(p))
    throw new Error(`operation ${i + 1}: "${field}" must be a path inside the "${cfg.root.name}" root (${relRepo(appDir) || "."}): ${r}`);
  return p;
}
if (!Array.isArray(moves) || !moves.length) throw new Error("moves.json must be a non-empty array");
moves.forEach((m, i) => {
  if (!["move", "merge", "symbols"].includes(m.op)) throw new Error(`operation ${i + 1}: unknown op "${m.op}"`);
  m.fromAbs = inside(m.from, "from", i);
  m.toAbs = inside(m.to, "to", i);
  if (m.op === "symbols" && !(Array.isArray(m.symbols) && m.symbols.length)) throw new Error(`operation ${i + 1}: symbols op needs a non-empty "symbols" array`);
  const fromRel = relSrc(m.fromAbs);
  if (matchesAny(fromRel, rules.protected)) throw new Error(`operation ${i + 1}: ${m.from} is protected by the config; its contents and location must not change`);
  if (m.op !== "symbols" && matchesAny(fromRel, rules.neverMove)) throw new Error(`operation ${i + 1}: ${m.from} matches "neverMove" in the config (the framework or the project needs it where it is)`);
});

function loadSources() {
  clearListCache();
  resolver = createResolver(ts, cfg.root.tsconfig);
  const files = new Set([
    ...listSources(srcDir, cfg.root.isExcluded),
    ...cfg.root.include.flatMap((d) => listSources(d, cfg.root.isExcluded)),
    ...(cfg.root.rootFiles ? rootLevelSources(appDir) : []),
  ]);
  return new Map(
    [...files].map((f) => {
      const text = fs.readFileSync(f, "utf8");
      return [f, { text, sf: parseSource(ts, f, text) }];
    }),
  );
}

function sourceOf(sources, file) {
  return sources.get(file) ?? { sf: parseSource(ts, file, fs.readFileSync(file, "utf8")) };
}

function bindingNames(name, out) {
  if (ts.isIdentifier(name)) out.add(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
}

function exportedNames(sources, file, { ignoreReexportsOf, seen = new Set() } = {}) {
  const names = new Set();
  if (seen.has(file)) return names;
  seen.add(file);
  for (const st of sourceOf(sources, file).sf.statements) {
    const mods = ts.canHaveModifiers?.(st) ? ts.getModifiers(st) ?? [] : [];
    const exported = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isExportAssignment(st)) names.add("default");
    if (ts.isExportDeclaration(st)) {
      const target = st.moduleSpecifier ? resolveSpecifier(st.moduleSpecifier.text, file) : null;
      if (ignoreReexportsOf && target === ignoreReexportsOf) continue;
      if (st.exportClause && ts.isNamedExports(st.exportClause)) st.exportClause.elements.forEach((e) => names.add(e.name.text));
      else if (st.exportClause && ts.isNamespaceExport?.(st.exportClause)) names.add(st.exportClause.name.text);
      else if (target && fs.existsSync(target)) for (const n of exportedNames(sources, target, { seen })) n !== "default" && names.add(n);
      else names.add("*");
    }
    if (!exported) continue;
    if (isDefault) names.add("default");
    if (st.name?.text) names.add(st.name.text);
    if (ts.isVariableStatement(st)) st.declarationList.declarations.forEach((d) => bindingNames(d.name, names));
  }
  return names;
}

function newSpecifier(oldSpec, importer, target, post, importerAfter = importer) {
  const candidates = specifierCandidates(oldSpec, importerAfter, target, aliases);
  const ok = candidates.find((c) => post.resolve(c, importerAfter) === target);
  if (ok) return ok;
  throw new Error(
    `no import specifier from ${relRepo(importer)} resolves to ${relRepo(target)} after this change (tried ${candidates.map((c) => `"${c}"`).join(", ")}); a file with the same name probably shadows it. Pick another destination or name.`,
  );
}

function styleOf(sf, file) {
  const specs = collectSpecifiers(ts, sf).filter((s) => s.kind === "import" || s.kind === "reexport");
  const local = specs.filter((s) => resolveSpecifier(s.spec, file));
  const aliased = local.filter((s) => !s.spec.startsWith("."));
  const prefixCounts = {};
  for (const s of aliased) prefixCounts[aliasPrefixOf(s.spec, aliases)] = (prefixCounts[aliasPrefixOf(s.spec, aliases)] ?? 0) + 1;
  const prefix = Object.entries(prefixCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const ext = local.map((s) => extensionStyle(s.spec)).find(Boolean) ?? "";
  return { useAlias: aliased.length > 0 && aliased.length >= local.length - aliased.length, prefix, ext, file };
}

function specifierInStyle(style, target, post) {
  const candidates = [];
  if (style.useAlias) {
    const alias = aliasFor(target, aliases, style.prefix);
    if (alias) candidates.push(withExtension(alias, target, style.ext));
  }
  candidates.push(withExtension(relativeSpecifier(style.file, target), target, style.ext));
  const ok = candidates.find((c) => post.resolve(c, style.file) === target);
  if (!ok) throw new Error(`no import specifier from ${relRepo(style.file)} resolves to ${relRepo(target)}; tried ${candidates.join(", ")}`);
  return ok;
}

const DECLARATION_PARENTS = new Set([
  "VariableDeclaration", "FunctionDeclaration", "ClassDeclaration", "InterfaceDeclaration", "TypeAliasDeclaration",
  "EnumDeclaration", "Parameter", "PropertySignature", "PropertyDeclaration", "PropertyAssignment", "MethodDeclaration",
  "MethodSignature", "EnumMember", "ImportSpecifier", "ExportSpecifier", "GetAccessor", "SetAccessor",
]);
function isReference(n) {
  const p = n.parent;
  if (!p) return true;
  const kind = ts.SyntaxKind[p.kind];
  if (ts.isPropertyAccessExpression(p) && p.name === n) return false;
  if (ts.isQualifiedName(p) && p.right === n) return false;
  if (ts.isBindingElement(p) && p.propertyName === n) return false;
  if (DECLARATION_PARENTS.has(kind) && p.name === n) return false;
  return true;
}

function insertionPoint(sf) {
  const lastImport = [...sf.statements].reverse().find((st) => ts.isImportDeclaration(st));
  if (lastImport) return { at: lastImport.getEnd(), lead: "\n", trail: "" };
  let directiveEnd = null;
  for (const st of sf.statements) {
    if (ts.isExpressionStatement(st) && ts.isStringLiteral(st.expression)) directiveEnd = st.getEnd();
    else break;
  }
  if (directiveEnd !== null) return { at: directiveEnd, lead: "\n", trail: "" };
  return { at: 0, lead: "", trail: "\n" };
}

function existingImportFrom(sf, file, target, typeOnly, isImport) {
  return sf.statements.find((st) => {
    if (isImport ? !ts.isImportDeclaration(st) : !(ts.isExportDeclaration(st) && st.moduleSpecifier)) return false;
    if (resolveSpecifier(st.moduleSpecifier.text, file) !== target) return false;
    if (isImport) {
      const c = st.importClause;
      const nb = c?.namedBindings;
      return c && Boolean(c.isTypeOnly) === typeOnly && nb && ts.isNamedImports(nb);
    }
    return Boolean(st.isTypeOnly) === typeOnly && st.exportClause && ts.isNamedExports(st.exportClause);
  });
}

function stringLiteralHits(sf, specPositions, needles) {
  const hits = [];
  const visit = (n) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !specPositions.has(n.getStart(sf) + 1)) {
      const text = n.text;
      if (needles.some((x) => (x.exact ? text === x.value : text.includes(x.value)))) hits.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

function planOp(m, sources) {
  const { op, fromAbs: from, toAbs: to } = m;
  const edits = new Map();
  const manual = [];
  const addEdit = (file, start, end, text) => (edits.get(file) ?? edits.set(file, []).get(file)).push({ start, end, text });

  if (!fs.existsSync(from)) throw new Error(`from does not exist: ${m.from}`);
  if (op === "move" && fs.existsSync(to)) throw new Error(`move target already exists: ${m.to}`);
  const preview = !APPLY && op === "symbols" && !fs.existsSync(to);
  if (op !== "move" && !fs.existsSync(to) && !preview) throw new Error(`${op} target must exist first: ${m.to}`);
  if (op !== "move" && from === to) throw new Error(`${op}: from and to are the same file`);
  const toExports = op === "merge" ? exportedNames(sources, to) : null;
  const symbols = new Set(m.symbols ?? []);
  const movedNames = op === "symbols" ? [...symbols] : [...exportedNames(sources, from)].filter((n) => n !== "*" && n !== "default");
  const post = resolver.withOverlay(
    op === "move" ? { add: [to], remove: [from] } : op === "merge" ? { remove: [from] } : { add: fs.existsSync(to) ? [] : [to] },
  );

  for (const [file, { sf }] of sources) {
    if (file === from && op === "move") continue;
    const all = collectSpecifiers(ts, sf);
    const specs = all.filter((s) => resolveSpecifier(s.spec, file) === from);

    if (op !== "move" && movedNames.length)
      for (const s of all.filter((s) => s.kind === "mock" && s.hasFactory && !s.factoryKeepsActual && resolveSpecifier(s.spec, file) === to))
        manual.push(`${relRepo(file)}: mock factory for ${m.to} replaces the whole module, so ${movedNames.slice(0, 6).join(", ")}${movedNames.length > 6 ? ", …" : ""} moving into it will be stubbed out here; add them to the factory or spread the actual module`);

    if (!specs.length) continue;

    if (op === "move" || op === "merge") {
      for (const s of specs) {
        if (op === "merge") {
          const missing = s.names.filter((n) => n !== "*" && !toExports.has(n) && !toExports.has("*"));
          if (missing.length) throw new Error(`${relRepo(file)} imports ${missing.join(", ")} from ${m.from}, but ${m.to} does not export them`);
          if (s.names.includes("*") && s.kind !== "mock") manual.push(`${relRepo(file)}: namespace or star import of ${m.from}; check it still resolves after the merge`);
          if (file === to) manual.push(`${relRepo(file)}: imports ${m.from}, which is merging into this same file; remove the import and use the local declaration`);
          if (s.names.includes("default")) manual.push(`${relRepo(file)}: default import of ${m.from} now binds to the default export of ${m.to}; check it is the same function or value`);
        }
        if (s.kind === "mock" && s.hasFactory)
          manual.push(`${relRepo(file)}: mock factory for ${m.from} now mocks ${m.to}${op === "merge" ? " as a whole; keep the real exports with requireActual/importActual" : ""}`);
        if (file === to) continue;
        const next = newSpecifier(s.spec, file, to, post);
        if (next !== s.spec) addEdit(file, s.start, s.end, next);
      }
      continue;
    }

    const freshByTarget = new Map();
    for (const st of sf.statements) {
      const isImport = ts.isImportDeclaration(st);
      const isReexport = ts.isExportDeclaration(st) && st.moduleSpecifier;
      if (!isImport && !isReexport) continue;
      if (resolveSpecifier(st.moduleSpecifier.text, file) !== from) continue;
      const named = isImport ? st.importClause?.namedBindings : st.exportClause;
      const elements = named && (ts.isNamedImports(named) || ts.isNamedExports(named)) ? named.elements : null;
      if (!elements) {
        if (isImport && named && ts.isNamespaceImport(named)) manual.push(`${relRepo(file)}: namespace import of ${m.from}; members ${[...symbols].join(", ")} moved`);
        if (isReexport && !st.exportClause) manual.push(`${relRepo(file)}: export * from ${m.from} no longer re-exports ${[...symbols].join(", ")}; add an export * from ${m.to} if consumers import them through this file`);
        continue;
      }
      const moved = elements.filter((e) => symbols.has((e.propertyName ?? e.name).text));
      if (!moved.length) continue;
      const kept = elements.filter((e) => !moved.includes(e));
      const quote = st.moduleSpecifier.getText(sf)[0];
      const spec = newSpecifier(st.moduleSpecifier.text, file, to, post);
      const typeOnly = Boolean(isImport ? st.importClause.isTypeOnly : st.isTypeOnly);
      const movedText = moved.map((e) => e.getText(sf));
      const existing = existingImportFrom(sf, file, to, typeOnly, isImport);
      let fresh = "";
      if (existing) {
        const target = isImport ? existing.importClause.namedBindings : existing.exportClause;
        const have = new Set(target.elements.map((e) => e.getText(sf)));
        const add = movedText.filter((t) => !have.has(t));
        const key = existing.getStart(sf);
        const merged = freshByTarget.get(key) ?? { target, names: [...have] };
        merged.names.push(...add.filter((t) => !merged.names.includes(t)));
        freshByTarget.set(key, merged);
      } else {
        const keyword = isImport ? (typeOnly ? "import type" : "import") : typeOnly ? "export type" : "export";
        fresh = `${keyword} { ${movedText.join(", ")} } from ${quote}${spec}${quote};`;
      }
      const defaultName = isImport ? st.importClause.name?.getText(sf) : null;
      if (!kept.length && !defaultName) addEdit(file, st.getStart(sf), st.getEnd(), fresh);
      else if (!kept.length) addEdit(file, st.getStart(sf), st.getEnd(), `import ${defaultName} from ${st.moduleSpecifier.getText(sf)};${fresh ? "\n" + fresh : ""}`);
      else {
        addEdit(file, named.getStart(sf), named.getEnd(), `{ ${kept.map((e) => e.getText(sf)).join(", ")} }`);
        if (fresh) addEdit(file, st.getEnd(), st.getEnd(), "\n" + fresh);
      }
    }
    for (const { target, names } of freshByTarget.values()) addEdit(file, target.getStart(sf), target.getEnd(), `{ ${names.join(", ")} }`);
    for (const s of specs.filter((s) => s.kind === "mock" || s.kind === "dynamic"))
      manual.push(`${relRepo(file)}: ${s.kind} reference to ${m.from}; check whether it needs the moved symbols`);
  }

  if (op === "symbols") {
    const { sf } = sources.get(from);
    const stillDeclared = [...symbols].filter((s) => exportedNames(sources, from, { ignoreReexportsOf: to }).has(s));
    if (stillDeclared.length && APPLY) throw new Error(`${m.from} still exports ${stillDeclared.join(", ")}; move the declarations into ${m.to} first`);
    if (stillDeclared.length || preview) {
      manual.push(`preview only: ${preview ? `${m.to} doesn't exist yet` : `${m.from} still declares ${stillDeclared.join(", ")}`}. Importer rewrites are shown; the back-import into ${m.from} and the declaration check run after you prepare the code and dry-run again`);
      return finish(edits, manual);
    }
    const used = new Set();
    const visit = (n) => {
      if (ts.isIdentifier(n) && symbols.has(n.text) && isReference(n)) used.add(n.text);
      ts.forEachChild(n, visit);
    };
    sf.statements.filter((st) => !ts.isImportDeclaration(st) && !(ts.isExportDeclaration(st) && st.moduleSpecifier)).forEach(visit);
    if (used.size) {
      const toSf = sourceOf(sources, to).sf;
      const typeNames = new Set(toSf.statements.filter((st) => ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)).map((st) => st.name.text));
      const spec = specifierInStyle(styleOf(sf, from), to, post);
      const typeOnly = [...used].filter((n) => typeNames.has(n));
      const values = [...used].filter((n) => !typeNames.has(n));
      const lines = [];
      if (typeOnly.length) lines.push(`import type { ${typeOnly.join(", ")} } from "${spec}";`);
      if (values.length) lines.push(`import { ${values.join(", ")} } from "${spec}";`);
      const { at, lead, trail } = insertionPoint(sf);
      addEdit(from, at, at, lead + lines.join("\n") + trail);
      manual.push(`${relRepo(from)}: imports ${[...used].join(", ")} back from ${m.to}; check none of them is a shadowing local`);
    }
  }

  if (op === "move") {
    const { sf } = sources.get(from);
    for (const s of collectSpecifiers(ts, sf)) {
      if (!s.spec.startsWith(".")) continue;
      const target = resolveSpecifier(s.spec, from);
      if (!target || target === from) continue;
      const next = newSpecifier(s.spec, from, target, post, to);
      if (next !== s.spec) addEdit(from, s.start, s.end, next);
    }
  }

  if (op !== "symbols") {
    const oldRel = relSrc(from).replace(/\.[^./]+$/, "");
    const needles = [
      ...(oldRel.includes("/") ? [{ value: oldRel, exact: false }] : []),
      ...(!/^index\./.test(path.basename(from)) ? [{ value: path.basename(from), exact: true }] : []),
    ];
    for (const [file, { sf }] of sources) {
      if (file === from) continue;
      const specPositions = new Set(collectSpecifiers(ts, sf).map((s) => s.start));
      for (const h of stringLiteralHits(sf, specPositions, needles))
        manual.push(`${relRepo(file)}:${h.line}: string "${h.text.length > 60 ? h.text.slice(0, 57) + "…" : h.text}" looks like a hard-coded path to ${m.from} (a guard test, fs read or glob?)`);
    }
  }

  return finish(edits, manual);
}

function finish(edits, manual) {
  for (const [file, list] of edits) {
    const sorted = [...list].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < sorted.length; i++)
      if (sorted[i].start < sorted[i - 1].end) throw new Error(`overlapping edits in ${relRepo(file)}; split this operation`);
  }
  return { edits, manual };
}

function render(sources, file, list) {
  let text = sources.get(file)?.text ?? fs.readFileSync(file, "utf8");
  for (const e of [...list].sort((a, b) => b.start - a.start || b.end - a.end)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  return text;
}

function refuseUntracked(file) {
  try {
    git("ls-files", "--error-unmatch", "--", file);
  } catch {
    throw new Error(`${relRepo(file)} is not tracked by git, so git mv/rm would fail after the importers were rewritten; git add it first. Nothing was written.`);
  }
}

function refuseDirty(file, why) {
  const status = git("status", "--porcelain", "--", file).trim();
  if (status) throw new Error(`${relRepo(file)} has uncommitted changes (${status.slice(0, 2).trim()}); ${why}`);
}

const report = [];
let sources = loadSources();
const unresolvedLocal = [];
for (const [file, { sf }] of sources)
  for (const sp of collectSpecifiers(ts, sf)) if (resolver.looksLocal(sp.spec) && !resolveSpecifier(sp.spec, file)) unresolvedLocal.push(`${relRepo(file)}: "${sp.spec}"`);
if (unresolvedLocal.length)
  console.log(`warning: ${unresolvedLocal.length} local-looking import(s) don't resolve with this tsconfig and config, so they can't be rewired if they point at a moved file:\n${unresolvedLocal.slice(0, 5).map((x) => "  " + x).join("\n")}${unresolvedLocal.length > 5 ? "\n  …" : ""}\n`);
const touched = new Set();
for (const [i, m] of moves.entries()) {
  const label = `op ${i + 1} (${m.op} ${m.from} -> ${m.to})`;
  if (!APPLY && (touched.has(m.fromAbs) || touched.has(m.toAbs))) {
    report.push({ label, skipped: `depends on an earlier operation in this map; apply that one first, then dry-run again` });
    continue;
  }
  const { edits, manual } = planOp(m, sources);
  const changed = [...edits.keys()].map(relRepo).sort();
  const shared = !APPLY ? changed.filter((f) => touched.has(path.join(repoRoot, f))) : [];
  if (shared.length) manual.unshift(`preview against the current tree: ${shared.length} importer(s) also change in an earlier operation (${shared.slice(0, 3).join(", ")}${shared.length > 3 ? ", …" : ""}); --apply runs them in order`);
  if (APPLY) {
    if (m.op !== "symbols") refuseUntracked(m.fromAbs);
    if (m.op === "merge") refuseDirty(m.fromAbs, `merge deletes it; move those edits into ${m.to} or commit them first`);
    for (const [file, list] of edits) fs.writeFileSync(file, render(sources, file, list));
    if (m.op === "move") {
      fs.mkdirSync(path.dirname(m.toAbs), { recursive: true });
      git("mv", m.fromAbs, m.toAbs);
    }
    if (m.op === "merge") git("rm", "-q", m.fromAbs);
    sources = loadSources();
  }
  for (const f of [...edits.keys(), m.fromAbs, m.toAbs]) touched.add(f);
  report.push({ label, m, changed, manual: [...new Set(manual)] });
}

const DOC_PATHSPECS = cfg.docs.length ? cfg.docs : [":(glob)**/*.md", ":(glob)**/*.mdx"];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function docHits(m) {
  const srcRel = toPosix(path.relative(repoRoot, srcDir));
  const bare = toPosix(path.relative(srcDir, m.fromAbs));
  const aliasForms = [...new Set(aliases.filter((a) => a.wildcard && a.kind !== "baseUrl").map((a) => aliasFor(m.fromAbs, [a])).filter(Boolean))];
  const needles = [bare, ...aliasForms, srcRel ? `${srcRel}/${bare}` : null].filter(Boolean);
  const patterns = [new RegExp(`(^|[^\\w-])${escape(bare)}(?![\\w/-])`), ...aliasForms.map((a) => new RegExp(`${escape(a)}(?![\\w/.-])`))];
  const hits = new Set();
  for (const needle of needles) {
    let out = "";
    try {
      out = git("grep", "-n", "-F", needle, "--", ...DOC_PATHSPECS).trim();
    } catch {}
    for (const line of out ? out.split("\n") : []) {
      const body = line.replace(/^[^:]+:\d+:/, "");
      if (!patterns.some((p) => p.test(body))) continue;
      if (m.op === "symbols" && !(m.symbols ?? []).some((s) => new RegExp(`\\b${escape(s)}\\b`).test(body))) continue;
      hits.add(line);
    }
  }
  const stem = path.basename(m.fromAbs).replace(/\.[^.]+$/, "");
  if (m.op !== "symbols" && stem !== "index") {
    let named = "";
    try {
      named = git("ls-files", "--", ...DOC_PATHSPECS).trim();
    } catch {}
    for (const f of named ? named.split("\n") : []) if (new RegExp(`(^|/)${escape(stem)}\\.mdx?$`).test(f)) hits.add(`${f}: doc named after the moved file; move it if docs mirror the code tree`);
  }
  return [...hits];
}

const isProtected = (repoRel) => {
  const abs = path.join(repoRoot, repoRel);
  return matchesAny(relSrc(abs), rules.protected);
};

console.log(`${APPLY ? "APPLIED" : "DRY RUN"}: ${moves.length} operation(s) in root "${cfg.root.name}"`);
for (const r of report) {
  console.log(`\n## ${r.label}`);
  if (r.skipped) {
    console.log(`  not previewed: ${r.skipped}`);
    continue;
  }
  if (r.m.op === "move") console.log(`  move   ${relRepo(r.m.fromAbs)} -> ${relRepo(r.m.toAbs)}`);
  if (r.m.op === "merge") console.log(`  remove ${relRepo(r.m.fromAbs)}`);
  console.log(`  files rewritten (${r.changed.length}):`);
  r.changed.forEach((f) => console.log("    " + f));
  const prot = r.changed.filter(isProtected);
  if (prot.length) {
    console.log(`  protected files with rewritten import lines (${prot.length}); import paths only, declare them in the hand-off:`);
    prot.forEach((f) => console.log("    " + f));
  }
  if (r.manual.length) {
    console.log(`  needs a manual look (${r.manual.length}):`);
    r.manual.forEach((x) => console.log("    " + x));
  }
  const hits = docHits(r.m);
  if (hits.length) {
    console.log(`  docs and agent files citing the old path (${hits.length}):`);
    hits.forEach((h) => console.log("    " + h));
  }
}
if (!APPLY) console.log("\nRe-run with --apply to write these changes.");
