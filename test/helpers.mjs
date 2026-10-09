import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "../skills/tidy-tree/scripts");
export const REWRITE = join(SCRIPTS, "rewrite-imports.mjs");
export const BUILD = join(SCRIPTS, "build-report.mjs");
export const INVENTORY = join(SCRIPTS, "inventory.mjs");
export const DISCOVER = join(SCRIPTS, "discover.mjs");
const require = createRequire(import.meta.url);
export const TS_PATH = process.env.TIDY_TREE_TS || dirname(require.resolve("typescript/package.json"));
export const ts = require(TS_PATH);

export const TSCONFIG = JSON.stringify(
  { compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] }, jsx: "preserve", isolatedModules: true } },
  null,
  2,
);

export const DEFAULT_CONFIG = {
  roots: [{ name: "app", dir: "app", src: "src", include: ["tests", "scripts"] }],
  protected: ["lib/billing/ledger.ts"],
  docs: ["docs"],
};

export function write(root, p, c) {
  const abs = join(root, p);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, c);
}

export function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function run(script, args, opts = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", ...opts });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}\n${r.stderr}` };
}

export function makeRepo(t, files, { config = DEFAULT_CONFIG, tsconfig = TSCONFIG } = {}) {
  const root = tempDir(t, "tt-test-repo-");
  const side = tempDir(t, "tt-test-side-");
  const all = {
    ...(tsconfig === null ? {} : { "app/tsconfig.json": tsconfig }),
    ...(config === null ? {} : { "tidy-tree.config.json": JSON.stringify(config, null, 2) }),
    ...files,
  };
  for (const [p, c] of Object.entries(all)) write(root, p, c);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "tidy-tree test");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-qm", "init");
  const head = git("rev-parse", "HEAD").trim();
  let n = 0;
  return {
    root,
    side,
    git,
    head,
    read: (p) => readFileSync(join(root, p), "utf8"),
    exists: (p) => existsSync(join(root, p)),
    write: (p, c) => write(root, p, c),
    status: () => git("status", "--porcelain"),
    run(map, { apply = false, extra = [] } = {}) {
      const mapFile = join(side, `map-${n++}.json`);
      writeFileSync(mapFile, JSON.stringify(map, null, 2));
      const args = ["--root", root, "--ts", TS_PATH, "--map", mapFile, ...extra];
      if (apply) args.push("--apply");
      return run(REWRITE, args);
    },
    inventory(scope, extra = []) {
      const out = join(side, `inv-${n++}.json`);
      const r = run(INVENTORY, ["--root", root, "--ts", TS_PATH, "--scope", scope, "--out", out, ...extra]);
      return { ...r, json: r.status === 0 ? JSON.parse(readFileSync(out, "utf8")) : null };
    },
  };
}

export function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out[relative(root, abs)] = readFileSync(abs, "utf8");
    }
  };
  walk(root);
  return out;
}

export function imports(code, fileName = "f.tsx") {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const res = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    const spec = st.moduleSpecifier.text;
    const clause = st.importClause;
    const entry = { spec, default: clause?.name?.text ?? null, names: [], typeOnly: !!clause?.isTypeOnly };
    const nb = clause?.namedBindings;
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) entry.names.push(el.name.text);
    res.push(entry);
  }
  return res;
}

export function specOf(code, name) {
  return imports(code)
    .filter((i) => i.names.includes(name) || i.default === name)
    .map((h) => h.spec);
}

export function syntaxErrors(code, fileName = "f.tsx") {
  const r = ts.transpileModule(code, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, isolatedModules: true },
  });
  return (r.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

const EXTS = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"];
export function resolveSpec(repo, fromFile, spec) {
  let base;
  if (spec.startsWith("@/")) base = join(repo.root, "app/src", spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(join(repo.root, dirname(fromFile)), spec);
  else return true;
  if (EXTS.some((e) => existsSync(base + e) && statSync(base + e).isFile())) return true;
  const js = base.match(/\.(js|jsx)$/);
  return Boolean(js && [".ts", ".tsx"].some((e) => existsSync(base.slice(0, -js[0].length) + e)));
}

export function allSpecifiersResolve(repo) {
  const broken = [];
  const re = /(?:from\s*|import\s*\(\s*|jest\.mock\(\s*|require\(\s*)["']([^"']+)["']/g;
  for (const [file, code] of Object.entries(snapshot(repo.root))) {
    if (!/\.(ts|tsx|mjs|js|jsx)$/.test(file)) continue;
    for (const m of code.matchAll(re)) if (!resolveSpec(repo, file, m[1])) broken.push(`${file}: ${m[1]}`);
  }
  return broken;
}

export function section(out, headerRe) {
  const lines = out.split("\n");
  const collected = [];
  lines.forEach((line, i) => {
    if (!headerRe.test(line)) return;
    const indent = line.match(/^\s*/)[0].length;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) break;
      if (l.match(/^\s*/)[0].length <= indent) break;
      collected.push(l.trim());
    }
  });
  return collected;
}

export const MANUAL = /manual look/i;

export function assertManualMentions(r, needle) {
  const manual = section(r.stdout, MANUAL);
  assert.ok(
    manual.some((l) => l.includes(needle)),
    `manual-look section should mention ${needle}: ${JSON.stringify(manual)}\n${r.out}`,
  );
}
