import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

export function findUp(start, name) {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveRepoRoot(explicit) {
  if (explicit) return path.resolve(String(explicit));
  const git = findUp(process.cwd(), ".git");
  if (!git) throw new Error("No git checkout found. Run from inside the repository you are changing, or pass --root <repo>.");
  return path.dirname(git);
}

export function loadTypeScript(fromDirs, explicit) {
  const tries = [explicit, ...[].concat(fromDirs).filter(Boolean).map((d) => findUp(d, "node_modules/typescript"))].filter(Boolean);
  for (const t of tries) {
    try {
      return createRequire(path.join(t, "package.json"))(t);
    } catch {}
  }
  try {
    return createRequire(import.meta.url)("typescript");
  } catch {}
  throw new Error(
    "typescript not found. Run from a repository with node_modules installed, or pass --ts <path/to/node_modules/typescript>. In a git worktree, symlink the main checkout's node_modules first.",
  );
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = out[key] === undefined ? next : [].concat(out[key], next);
      i++;
    }
  }
  return out;
}

const SOURCE_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
export const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", ".output", ".svelte-kit", ".vercel", ".turbo", ".cache", "dist", "build", "out",
  "coverage", "storybook-static",
]);

export function isSource(file) {
  return SOURCE_EXT.includes(path.extname(file)) && !/\.d\.[cm]?ts$/.test(file);
}

function walk(dir, files = [], top = true) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || (top && SKIP_DIRS.has(entry.name))) continue;
      walk(full, files, false);
    } else if (isSource(full)) files.push(full);
  }
  return files;
}

const listCache = new Map();
function gitListed(dir) {
  if (listCache.has(dir)) return listCache.get(dir);
  let out = null;
  try {
    out = execFileSync("git", ["-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], {
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 512 * 1024 * 1024,
    })
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((r) => path.join(dir, r));
  } catch {}
  listCache.set(dir, out);
  return out;
}

export function clearListCache() {
  listCache.clear();
}

export function listSources(dir, exclude = () => false) {
  if (!fs.existsSync(dir)) return [];
  const listed = gitListed(dir);
  const files = listed ? [...new Set(listed)].filter((f) => isSource(f) && fs.existsSync(f)) : walk(dir);
  return files.filter((f) => !/[\\/]node_modules[\\/]/.test(f) && !exclude(f));
}

export function rootLevelSources(dir) {
  if (!fs.existsSync(dir)) return [];
  const top = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && isSource(e.name))
    .map((e) => path.join(dir, e.name));
  return [...top, ...listSources(path.join(dir, ".storybook"))];
}

export function findTsconfig(dir) {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function compilerOptionSets(ts, tsconfigPath) {
  const sets = [];
  const seen = new Set();
  const visit = (p, depth) => {
    if (seen.has(p)) return;
    seen.add(p);
    const read = ts.readConfigFile(p, ts.sys.readFile);
    if (read.error) return;
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(p), undefined, p);
    const refs = parsed.projectReferences ?? [];
    if (parsed.fileNames.length || !refs.length) sets.push({ options: parsed.options, dir: path.dirname(p) });
    if (depth < 3)
      for (const r of refs) {
        let rp = r.path;
        if (fs.existsSync(rp) && fs.statSync(rp).isDirectory()) rp = path.join(rp, "tsconfig.json");
        if (fs.existsSync(rp)) visit(rp, depth + 1);
      }
  };
  if (tsconfigPath && fs.existsSync(tsconfigPath)) visit(path.resolve(tsconfigPath), 0);
  if (!sets.length) sets.push({ options: {}, dir: tsconfigPath ? path.dirname(tsconfigPath) : process.cwd() });
  sets.sort((a, b) => Number(Boolean(b.options.paths)) - Number(Boolean(a.options.paths)));
  return sets.map(({ options, dir }) => ({
    dir,
    options: {
      ...options,
      allowJs: true,
      noEmit: true,
      resolveJsonModule: false,
      ...(options.moduleResolution === undefined && options.module === undefined ? { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext } : {}),
    },
  }));
}

function firstString(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(firstString).find(Boolean) ?? null;
  if (v && typeof v === "object") for (const k of ["types", "import", "default", "node", "require"]) if (k in v) return firstString(v[k]) ?? null;
  if (v && typeof v === "object") return Object.values(v).map(firstString).find(Boolean) ?? null;
  return null;
}

function packageImportAliases(fromDir, options) {
  const pkgPath = findUp(fromDir, "package.json");
  if (!pkgPath) return [];
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return [];
  }
  const out = [];
  for (const [key, value] of Object.entries(pkg.imports ?? {})) {
    if (!key.startsWith("#") || !key.endsWith("/*")) continue;
    const target = firstString(value);
    const m = target?.match(/^(\.\/.*?)\*(\.[a-z]+)?$/);
    if (!m) continue;
    let dirTarget = path.resolve(path.dirname(pkgPath), m[1]);
    if (options.outDir && (dirTarget === options.outDir || dirTarget.startsWith(options.outDir + path.sep)))
      dirTarget = path.join(options.rootDir ?? path.dirname(pkgPath), path.relative(options.outDir, dirTarget));
    out.push({ prefix: key.slice(0, -1), wildcard: true, targets: [dirTarget], kind: "imports" });
  }
  return out;
}

function aliasList(sets) {
  const { options, dir } = sets.find((s) => s.options.paths) ?? sets[0];
  const base = options.baseUrl ?? options.pathsBasePath ?? dir;
  const list = Object.entries(options.paths ?? {}).map(([pattern, targets]) => ({
    prefix: pattern.replace(/\*$/, ""),
    wildcard: pattern.endsWith("*"),
    targets: targets.map((t) => path.resolve(base, String(t).replace(/\*$/, ""))),
    kind: "paths",
  }));
  list.push(...packageImportAliases(dir, options));
  list.sort((a, b) => b.prefix.length - a.prefix.length);
  if (options.baseUrl) list.push({ prefix: "", wildcard: true, targets: [path.resolve(options.baseUrl)], kind: "baseUrl" });
  return list;
}

export function createResolver(ts, tsconfigPath, overlay = null) {
  const sets = compilerOptionSets(ts, tsconfigPath);
  const aliases = aliasList(sets);
  const added = new Set((overlay?.add ?? []).map((p) => path.resolve(p)));
  const removed = new Set((overlay?.remove ?? []).map((p) => path.resolve(p)));
  const addedDirs = new Set();
  for (const f of added) for (let d = path.dirname(f); d !== path.dirname(d) && !addedDirs.has(d); d = path.dirname(d)) addedDirs.add(d);
  const host = {
    fileExists: (p) => {
      const a = path.resolve(p);
      if (removed.has(a)) return false;
      return added.has(a) || ts.sys.fileExists(p);
    },
    readFile: (p) => ts.sys.readFile(p),
    directoryExists: (p) => addedDirs.has(path.resolve(p)) || ts.sys.directoryExists(p),
    getCurrentDirectory: () => process.cwd(),
    getDirectories: (p) => ts.sys.getDirectories(p),
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };
  const canonical = ts.sys.useCaseSensitiveFileNames ? (x) => x : (x) => x.toLowerCase();
  const caches = sets.map((s) => ts.createModuleResolutionCache(process.cwd(), canonical, s.options));
  const memo = new Map();
  function resolve(spec, fromFile) {
    const key = `${path.dirname(fromFile)}\u0000${spec}\u0000${/\.[cm]?ts$|\.tsx$/.test(fromFile) ? "ts" : "js"}`;
    if (memo.has(key)) return memo.get(key);
    let hit = null;
    for (let i = 0; i < sets.length && !hit; i++) {
      const r = ts.resolveModuleName(spec, fromFile, sets[i].options, host, caches[i]).resolvedModule;
      if (!r || r.isExternalLibraryImport) continue;
      const f = path.resolve(r.resolvedFileName);
      if (/[\\/]node_modules[\\/]/.test(f) || /\.d\.[cm]?ts$/.test(f) || removed.has(f)) continue;
      hit = f;
    }
    memo.set(key, hit);
    return hit;
  }
  return {
    aliases,
    resolve,
    withOverlay: (o) => createResolver(ts, tsconfigPath, o),
    looksLocal: (spec) =>
      !/\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|ico|json|md|mdx|html|txt|woff2?|ttf|otf|mp4|webm|wasm|graphql|gql)(\?.*)?$/i.test(spec) &&
      (spec.startsWith(".") || aliases.some((a) => a.kind !== "baseUrl" && (a.wildcard ? spec.startsWith(a.prefix) : spec === a.prefix))),
  };
}

export function collectSpecifiers(ts, sf) {
  const specs = [];
  const push = (node, kind, typeOnly, names, extra = {}) =>
    specs.push({ spec: node.text, start: node.getStart(sf) + 1, end: node.getEnd() - 1, kind, typeOnly, names, ...extra });
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names = [];
      const locals = [];
      let typeOnly = Boolean(clause?.isTypeOnly);
      if (clause?.name) names.push("default"), locals.push(clause.name.text);
      const nb = clause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) names.push((el.propertyName ?? el.name).text), locals.push(el.name.text);
      if (nb && ts.isNamespaceImport(nb)) names.push("*"), locals.push(nb.name.text);
      if (!typeOnly && clause && !clause.name && nb && ts.isNamedImports(nb) && nb.elements.length && nb.elements.every((el) => el.isTypeOnly))
        typeOnly = true;
      if (!clause) typeOnly = false;
      push(node.moduleSpecifier, "import", typeOnly, names, { locals });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      push(node.moduleReference.expression, "import", Boolean(node.isTypeOnly), ["*"]);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const names = [];
      if (node.exportClause && ts.isNamedExports(node.exportClause))
        for (const el of node.exportClause.elements) names.push((el.propertyName ?? el.name).text);
      else names.push("*");
      push(node.moduleSpecifier, "reexport", Boolean(node.isTypeOnly), names);
    } else if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression.getText(sf);
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        /^(require|require\.resolve|jest\.(mock|requireActual|requireMock|doMock|unmock|createMockFromModule)|vi\.(mock|doMock|unmock|importActual|importMock))$/.test(callee)
      )
        push(node.arguments[0], /^(jest|vi)\./.test(callee) ? "mock" : "dynamic", false, ["*"], {
          hasFactory: /\.(mock|doMock)$/.test(callee) && node.arguments.length > 1,
          factoryKeepsActual: /\.(mock|doMock)$/.test(callee) && node.arguments.length > 1 && /requireActual|importActual|importOriginal/.test(node.arguments[1].getText(sf)),
        });
    } else if (ts.isImportTypeNode?.(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      push(node.argument.literal, "import-type", true, ["*"]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

export function valueUsedNames(ts, sf) {
  const used = new Set();
  const visit = (node, inType) => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return;
    if (ts.isExpressionWithTypeArguments(node) && ts.isHeritageClause(node.parent) && node.parent.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(node.parent.parent)) {
      visit(node.expression, inType);
      node.typeArguments?.forEach((t) => visit(t, true));
      return;
    }
    const typeHere = inType || ts.isTypeNode(node) || (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ImplementsKeyword);
    if (ts.isIdentifier(node) && !typeHere) used.add(node.text);
    if (ts.isJsxOpeningLikeElement?.(node) && ts.isIdentifier(node.tagName)) used.add(node.tagName.text);
    ts.forEachChild(node, (c) => visit(c, typeHere));
  };
  visit(sf, false);
  return used;
}

export function markTypeOnlyUses(ts, sf, specs) {
  let used = null;
  for (const s of specs) {
    if (s.typeOnly || s.kind !== "import" || !s.locals?.length) continue;
    used ??= valueUsedNames(ts, sf);
    if (s.locals.every((l) => !used.has(l))) s.typeOnly = true;
  }
  return specs;
}

export function scriptKindFor(ts, file) {
  const ext = path.extname(file);
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if ([".js", ".mjs", ".cjs"].includes(ext)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function parseSource(ts, file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(ts, file));
}

export function toPosix(p) {
  return p.split(path.sep).join("/");
}

const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/;

export function aliasFor(absFile, aliases, preferPrefix) {
  const noExt = absFile.replace(CODE_EXT, "").replace(/\/index$/, "");
  const covering = aliases
    .filter((a) => a.wildcard)
    .flatMap((a) => a.targets.map((t) => ({ a, t })))
    .filter(({ t }) => noExt === t || noExt.startsWith(t.endsWith(path.sep) ? t : t + path.sep));
  if (!covering.length) return null;
  const preferred = preferPrefix === null || preferPrefix === undefined ? null : covering.find(({ a }) => a.prefix === preferPrefix);
  const { a, t } =
    preferred ?? covering.filter(({ a }) => a.kind !== "baseUrl").sort((x, y) => y.t.length - x.t.length || y.a.prefix.length - x.a.prefix.length)[0] ?? covering[0];
  return a.prefix + toPosix(path.relative(t, noExt));
}

export function aliasPrefixOf(spec, aliases) {
  if (spec.startsWith(".")) return null;
  return aliases.find((a) => (a.wildcard ? spec.startsWith(a.prefix) : spec === a.prefix))?.prefix ?? null;
}

export function extensionStyle(spec) {
  const m = spec.match(/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/);
  return m ? `.${m[1]}` : "";
}

const TS_TO_JS = { ".ts": ".js", ".tsx": ".js", ".mts": ".mjs", ".cts": ".cjs", ".js": ".js", ".jsx": ".jsx", ".mjs": ".mjs", ".cjs": ".cjs" };

export function withExtension(spec, targetFile, style) {
  if (!style) return spec;
  const ext = path.extname(targetFile);
  const isIndex = /\/index\.[^/]+$/.test(toPosix(targetFile)) && !spec.endsWith("/index");
  const suffix = [".ts", ".tsx", ".mts", ".cts"].includes(style) ? ext : TS_TO_JS[ext] ?? style;
  return isIndex ? `${spec}/index${suffix}` : `${spec}${suffix}`;
}

export function relativeSpecifier(fromFile, toFile) {
  let rel = toPosix(path.relative(path.dirname(fromFile), toFile.replace(CODE_EXT, "")));
  rel = rel.replace(/\/index$/, "");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

export function specifierCandidates(oldSpec, importer, target, aliases, preferAlias = true) {
  const ext = extensionStyle(oldSpec);
  const prefix = aliasPrefixOf(oldSpec, aliases);
  const out = [];
  const add = (base) => {
    if (!base) return;
    out.push(withExtension(base, target, ext));
    if (/[\\/]index\.[^\\/]+$/.test(target) && !ext && !base.endsWith("/index")) out.push(`${base}/index`);
  };
  if (preferAlias && !oldSpec.startsWith(".")) add(aliasFor(target, aliases, prefix));
  add(relativeSpecifier(importer, target));
  return [...new Set(out)];
}
