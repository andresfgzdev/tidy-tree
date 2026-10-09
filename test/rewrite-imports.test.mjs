import { test } from "node:test";
import assert from "node:assert/strict";
import { allSpecifiersResolve, DEFAULT_CONFIG, imports, makeRepo, MANUAL, resolveSpec, section, snapshot, specOf, syntaxErrors } from "./helpers.mjs";

test("1. dry run changes no files and makes no git changes", (t) => {
  const repo = makeRepo(t, {
    "app/src/zz/old.ts": "export const OLD = 1;\n",
    "app/src/lib/user.ts": 'import { OLD } from "@/zz/old";\nexport const U = OLD;\n',
  });
  const before = snapshot(repo.root);
  const r = repo.run([{ op: "move", from: "zz/old.ts", to: "zz/deep/old.ts" }]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(snapshot(repo.root), before);
  assert.equal(repo.status(), "");
  assert.equal(repo.git("rev-parse", "HEAD").trim(), repo.head);
});

test("2. move: git rename, importers keep style, moved file's relative imports re-based", (t) => {
  const repo = makeRepo(t, {
    "app/src/lib/util.ts": "export const UTIL = 1;\n",
    "app/src/zz/old.ts": 'import { UTIL } from "../lib/util";\nexport const OLD = UTIL;\n',
    "app/src/features/alias-user.ts": 'import { OLD } from "@/zz/old";\nexport const A = OLD;\n',
    "app/src/features/rel-user.ts": 'import { OLD } from "../zz/old";\nexport const R = OLD;\n',
  });
  const r = repo.run([{ op: "move", from: "zz/old.ts", to: "zz/deep/old.ts" }], { apply: true });
  assert.equal(r.status, 0, r.out);
  assert.ok(!repo.exists("app/src/zz/old.ts"));
  assert.ok(repo.exists("app/src/zz/deep/old.ts"));
  const st = repo.git("status", "--porcelain", "-M");
  assert.match(st, /^R. +app\/src\/zz\/old\.ts -> app\/src\/zz\/deep\/old\.ts$/m, st);
  assert.deepEqual(specOf(repo.read("app/src/features/alias-user.ts"), "OLD"), ["@/zz/deep/old"]);
  assert.deepEqual(specOf(repo.read("app/src/features/rel-user.ts"), "OLD"), ["../zz/deep/old"]);
  assert.deepEqual(specOf(repo.read("app/src/zz/deep/old.ts"), "UTIL"), ["../../lib/util"]);
  assert.deepEqual(allSpecifiersResolve(repo), []);
});

test("3. two sibling moves where one imports the other resolve to ../b/q", (t) => {
  const repo = makeRepo(t, {
    "app/src/zz/q.ts": "export const Q = 1;\n",
    "app/src/zz/p.ts": 'import { Q } from "./q";\nexport const P = Q;\n',
  });
  const r = repo.run(
    [
      { op: "move", from: "zz/p.ts", to: "zz/a/p.ts" },
      { op: "move", from: "zz/q.ts", to: "zz/b/q.ts" },
    ],
    { apply: true },
  );
  assert.equal(r.status, 0, r.out);
  const p = repo.read("app/src/zz/a/p.ts");
  assert.deepEqual(specOf(p, "Q"), ["../b/q"], p);
  assert.ok(resolveSpec(repo, "app/src/zz/a/p.ts", "../b/q"));
  assert.deepEqual(allSpecifiersResolve(repo), []);
});

test("4. chained merge then move points importers at the moved destination", (t) => {
  const repo = makeRepo(t, {
    "app/src/zz/x.ts": "export const X = 1;\n",
    "app/src/zz/y.ts": "export const X = 1;\nexport const Y = 2;\n",
    "app/src/lib/alias-user.ts": 'import { X } from "@/zz/x";\nexport const A = X;\n',
    "app/src/lib/rel-user.ts": 'import { X } from "../zz/x";\nexport const R = X;\n',
    "app/src/lib/y-user.ts": 'import { Y } from "@/zz/y";\nexport const B = Y;\n',
  });
  const r = repo.run(
    [
      { op: "merge", from: "zz/x.ts", to: "zz/y.ts" },
      { op: "move", from: "zz/y.ts", to: "zz/dom/y.ts" },
    ],
    { apply: true },
  );
  assert.equal(r.status, 0, r.out);
  assert.ok(!repo.exists("app/src/zz/x.ts"));
  assert.ok(!repo.exists("app/src/zz/y.ts"));
  assert.ok(repo.exists("app/src/zz/dom/y.ts"));
  assert.deepEqual(specOf(repo.read("app/src/lib/alias-user.ts"), "X"), ["@/zz/dom/y"]);
  assert.deepEqual(specOf(repo.read("app/src/lib/rel-user.ts"), "X"), ["../zz/dom/y"]);
  assert.deepEqual(specOf(repo.read("app/src/lib/y-user.ts"), "Y"), ["@/zz/dom/y"]);
  assert.deepEqual(allSpecifiersResolve(repo), []);
});

test("5. two symbols ops from the same source split one type import cleanly", (t) => {
  const repo = makeRepo(t, {
    "app/src/types/index.ts": "export type C = { c: number };\n",
    "app/src/types/charts/a.ts": "export type A = { a: number };\n",
    "app/src/types/charts/b.ts": "export type B = { b: number };\n",
    "app/src/features/user.ts": 'import type { A, B, C } from "@/types";\n\nexport const f = (a: A, b: B, c: C) => [a, b, c];\n',
  });
  const r = repo.run(
    [
      { op: "symbols", from: "types/index.ts", to: "types/charts/a.ts", symbols: ["A"] },
      { op: "symbols", from: "types/index.ts", to: "types/charts/b.ts", symbols: ["B"] },
    ],
    { apply: true },
  );
  assert.equal(r.status, 0, r.out);
  const code = repo.read("app/src/features/user.ts");
  assert.deepEqual(syntaxErrors(code, "user.ts"), [], code);
  assert.deepEqual(specOf(code, "A"), ["@/types/charts/a"], code);
  assert.deepEqual(specOf(code, "B"), ["@/types/charts/b"], code);
  assert.deepEqual(specOf(code, "C"), ["@/types"], code);
  assert.doesNotMatch(code, /\{\s*\}/, code);
  assert.doesNotMatch(code, /,\s*,|\{\s*,|,\s*\}/, code);
  assert.match(code, /export const f = \(a: A, b: B, c: C\) => \[a, b, c\];/, code);
  assert.deepEqual(allSpecifiersResolve(repo), []);
});

test("6. dry run reports a dependent operation as not previewed", (t) => {
  const repo = makeRepo(t, {
    "app/src/zz/old.ts": "export const OLD = 1;\n",
    "app/src/lib/user.ts": 'import { OLD } from "@/zz/old";\nexport const U = OLD;\n',
  });
  const r = repo.run([
    { op: "move", from: "zz/old.ts", to: "zz/n/old.ts" },
    { op: "move", from: "zz/n/old.ts", to: "zz/m/old.ts" },
  ]);
  assert.equal(r.status, 0, r.out);
  const op2 = r.stdout.split(/^## /m).find((s) => s.startsWith("op 2"));
  assert.ok(op2, r.out);
  assert.match(op2, /not previewed/i, op2);
  assert.doesNotMatch(op2, /zz\/m\/old\.ts\s*$/m, op2);
  assert.equal(repo.status(), "");
});

test('7. symbols op adds the back-import after the "use client" directive', (t) => {
  const repo = makeRepo(t, {
    "app/src/zz/src.tsx": '"use client";\n\nexport const KEEP = MOVED + 1;\n',
    "app/src/zz/dest.ts": "export const MOVED = 1;\n",
    "app/src/lib/user.ts": 'import { MOVED, KEEP } from "@/zz/src";\nexport const U = MOVED + KEEP;\n',
  });
  const r = repo.run([{ op: "symbols", from: "zz/src.tsx", to: "zz/dest.ts", symbols: ["MOVED"] }], {
    apply: true,
  });
  assert.equal(r.status, 0, r.out);
  const code = repo.read("app/src/zz/src.tsx");
  const firstLine = code.split("\n").find((l) => l.trim());
  assert.match(firstLine, /^["']use client["'];?$/, code);
  assert.deepEqual(specOf(code, "MOVED"), ["./dest"], code);
  assert.ok(code.indexOf("use client") < code.indexOf("import"), code);
  assert.deepEqual(syntaxErrors(code, "src.tsx"), [], code);
});

test("8. symbols op does not add an import for property-only uses", (t) => {
  const repo = makeRepo(t, {
    "app/src/zz/src.ts": "const o = { MOVED: 1 };\nexport const v = o.MOVED;\n",
    "app/src/zz/dest.ts": "export const MOVED = 1;\n",
    "app/src/lib/user.ts": 'import { MOVED, v } from "@/zz/src";\nexport const U = MOVED + v;\n',
  });
  const r = repo.run([{ op: "symbols", from: "zz/src.ts", to: "zz/dest.ts", symbols: ["MOVED"] }], {
    apply: true,
  });
  assert.equal(r.status, 0, r.out);
  const code = repo.read("app/src/zz/src.ts");
  assert.deepEqual(imports(code), [], code);
  assert.doesNotMatch(code, /\bimport\b/, code);
  assert.deepEqual(specOf(repo.read("app/src/lib/user.ts"), "MOVED"), ["@/zz/dest"]);
});

test("9. symbols op allows a compatibility re-export in the source", (t) => {
  const repo = makeRepo(t, {
    "app/src/zz/src.ts": 'export { MOVED } from "./dest";\nexport const KEEP = 1;\n',
    "app/src/zz/dest.ts": "export const MOVED = 1;\n",
    "app/src/lib/user.ts": 'import { MOVED, KEEP } from "@/zz/src";\nexport const U = MOVED + KEEP;\n',
  });
  const r = repo.run([{ op: "symbols", from: "zz/src.ts", to: "zz/dest.ts", symbols: ["MOVED"] }], {
    apply: true,
  });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /still exports/i, r.out);
  const user = repo.read("app/src/lib/user.ts");
  assert.deepEqual(specOf(user, "MOVED"), ["@/zz/dest"], user);
  assert.deepEqual(specOf(user, "KEEP"), ["@/zz/src"], user);
});

test("10. symbols op flags an export-star barrel of the source for a manual look", (t) => {
  const repo = makeRepo(t, {
    "app/src/zz/src.ts": "export const KEEP = 1;\n",
    "app/src/zz/dest.ts": "export const MOVED = 1;\n",
    "app/src/zz/index.ts": 'export * from "./src";\n',
    "app/src/lib/user.ts": 'import { KEEP } from "@/zz";\nexport const U = KEEP;\n',
  });
  const r = repo.run([{ op: "symbols", from: "zz/src.ts", to: "zz/dest.ts", symbols: ["MOVED"] }]);
  const manual = section(r.stdout, MANUAL);
  assert.ok(
    manual.some((l) => l.includes("app/src/zz/index.ts")),
    `manual-look section: ${JSON.stringify(manual)}\n${r.out}`,
  );
});

test("11. default + named import keeps the default and splits the named one", (t) => {
  const repo = makeRepo(t, {
    "app/src/zz/src.ts": "export default function Def() { return 1; }\nexport const KEEP = 1;\n",
    "app/src/zz/dest.ts": "export const A = 1;\n",
    "app/src/zz/user.ts": 'import Def, { A } from "./src";\nexport const U = Def() + A;\n',
  });
  const r = repo.run([{ op: "symbols", from: "zz/src.ts", to: "zz/dest.ts", symbols: ["A"] }], { apply: true });
  assert.equal(r.status, 0, r.out);
  const code = repo.read("app/src/zz/user.ts");
  assert.match(code, /^import Def from "\.\/src";$/m, code);
  assert.deepEqual(specOf(code, "A"), ["./dest"], code);
  assert.doesNotMatch(code, /\{\s*\}/, code);
  assert.deepEqual(syntaxErrors(code, "user.ts"), [], code);
});

test("12. merge refuses when an importer uses a name the destination lacks", (t) => {
  const repo = makeRepo(t, {
    "app/src/zz/m-from.ts": "export const X = 1;\nexport const Z = 2;\n",
    "app/src/zz/m-to.ts": "export const X = 1;\n",
    "app/src/lib/user.ts": 'import { Z } from "@/zz/m-from";\nexport const U = Z;\n',
  });
  const before = snapshot(repo.root);
  const r = repo.run([{ op: "merge", from: "zz/m-from.ts", to: "zz/m-to.ts" }], { apply: true });
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual(snapshot(repo.root), before);
  assert.equal(repo.status(), "");
});

test("13. merge refuses and deletes nothing when from has uncommitted edits", (t) => {
  const repo = makeRepo(t, {
    "app/src/zz/m-from.ts": "export const X = 1;\n",
    "app/src/zz/m-to.ts": "export const X = 1;\nexport const Y = 2;\n",
    "app/src/lib/user.ts": 'import { X } from "@/zz/m-from";\nexport const U = X;\n',
  });
  repo.write("app/src/zz/m-from.ts", "export const X = 1;\n// local edit\n");
  const before = snapshot(repo.root);
  const statusBefore = repo.status();
  const r = repo.run([{ op: "merge", from: "zz/m-from.ts", to: "zz/m-to.ts" }], { apply: true });
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual(snapshot(repo.root), before);
  assert.equal(repo.status(), statusBefore);
});

test("14. merge rewrites jest.mock specifiers and flags them for a manual look", (t) => {
  const repo = makeRepo(t, {
    "app/src/zz/m-from.ts": "export const X = 1;\n",
    "app/src/zz/m-to.ts": "export const X = 1;\nexport const Y = 2;\n",
    "app/src/__tests__/m.test.ts":
      'import { X } from "@/zz/m-from";\n\njest.mock("@/zz/m-from", () => ({ X: 1 }));\n\ntest("x", () => expect(X).toBe(1));\n',
  });
  const r = repo.run([{ op: "merge", from: "zz/m-from.ts", to: "zz/m-to.ts" }], { apply: true });
  assert.equal(r.status, 0, r.out);
  const code = repo.read("app/src/__tests__/m.test.ts");
  assert.match(code, /jest\.mock\("@\/zz\/m-to",/, code);
  assert.doesNotMatch(code, /m-from/, code);
  const manual = section(r.stdout, MANUAL);
  assert.ok(
    manual.some((l) => l.includes("app/src/__tests__/m.test.ts")),
    `manual-look section: ${JSON.stringify(manual)}\n${r.out}`,
  );
});

test("15. merge flags a destination that imports from the source", (t) => {
  const repo = makeRepo(t, {
    "app/src/zz/m-from.ts": "export const X = 1;\nexport const H = 3;\n",
    "app/src/zz/m-to.ts": 'import { H } from "./m-from";\nexport const X = 1;\nexport { H };\nexport const Y = H;\n',
    "app/src/lib/user.ts": 'import { X, H } from "@/zz/m-from";\nexport const U = X + H;\n',
  });
  const r = repo.run([{ op: "merge", from: "zz/m-from.ts", to: "zz/m-to.ts" }]);
  const manual = section(r.stdout, MANUAL);
  assert.ok(
    manual.some((l) => l.includes("app/src/zz/m-to.ts")),
    `manual-look section: ${JSON.stringify(manual)}\n${r.out}`,
  );
});

test("16. a map path escaping app/src is refused and nothing changes", (t) => {
  const repo = makeRepo(t, {
    "README.md": "# readme\n",
    "app/src/zz/a.ts": "export const A = 1;\n",
  });
  const before = snapshot(repo.root);
  for (const map of [
    [{ op: "move", from: "../../README.md", to: "zz/readme.md" }],
    [{ op: "move", from: "zz/a.ts", to: "../../escaped.ts" }],
  ]) {
    const r = repo.run(map, { apply: true });
    assert.notEqual(r.status, 0, `${JSON.stringify(map)}\n${r.out}`);
    assert.deepEqual(snapshot(repo.root), before);
    assert.equal(repo.status(), "");
  }
});

test("17. files at the app root (next.config.ts) are rewritten", (t) => {
  const repo = makeRepo(t, {
    "app/src/lib/routes.ts": "export const ROUTES = {};\n",
    "app/next.config.ts": 'import { ROUTES } from "./src/lib/routes";\n\nexport default { env: { r: String(ROUTES) } };\n',
  });
  const r = repo.run([{ op: "move", from: "lib/routes.ts", to: "lib/nav/routes.ts" }], { apply: true });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(specOf(repo.read("app/next.config.ts"), "ROUTES"), ["./src/lib/nav/routes"]);
  assert.deepEqual(allSpecifiersResolve(repo), []);
});

test("18. protected importers are listed in a protected files section", (t) => {
  const repo = makeRepo(t, {
    "app/src/zz/old.ts": "export const OLD = 1;\n",
    "app/src/lib/billing/ledger.ts": 'import { OLD } from "@/zz/old";\nexport const P = OLD;\n',
  });
  const r = repo.run([{ op: "move", from: "zz/old.ts", to: "zz/n/old.ts" }]);
  assert.equal(r.status, 0, r.out);
  const prot = section(r.stdout, /protected files/i);
  assert.ok(
    prot.some((l) => l.includes("app/src/lib/billing/ledger.ts")),
    `protected section: ${JSON.stringify(prot)}\n${r.out}`,
  );
});

test("19. docs citing the old path are listed; a prefix-sharing alias is not", (t) => {
  const repo = makeRepo(t, {
    "app/src/zz/old.ts": "export const OLD = 1;\n",
    "app/src/zz/old-other.ts": "export const OTHER = 1;\n",
    "docs/x.md": "# x\n\nSee `app/src/zz/old.ts` for the constant.\n",
    "docs/y.md": "# y\n\nSee `@/zz/old-other` for the other constant.\n",
  });
  const r = repo.run([{ op: "move", from: "zz/old.ts", to: "zz/n/old.ts" }]);
  assert.equal(r.status, 0, r.out);
  const docs = section(r.stdout, /docs/i);
  assert.ok(
    docs.some((l) => l.startsWith("docs/x.md:3")),
    `docs section: ${JSON.stringify(docs)}\n${r.out}`,
  );
  assert.ok(!docs.some((l) => l.includes("docs/y.md")), `docs section: ${JSON.stringify(docs)}\n${r.out}`);
});


test("25. symbols op merges into an existing import from the destination instead of adding a second line", (t) => {
  const repo = makeRepo(t, {
    "app/src/types/index.ts": "export type C = { c: number };\n",
    "app/src/types/charts.ts": "export type A = { a: number };\nexport type B = { b: number };\n",
    "app/src/features/user.ts": 'import type { A, C } from "@/types";\nimport type { B } from "@/types/charts";\n\nexport const f = (a: A, b: B, c: C) => [a, b, c];\n',
  });
  const r = repo.run([{ op: "symbols", from: "types/index.ts", to: "types/charts.ts", symbols: ["A"] }], { apply: true });
  assert.equal(r.status, 0, r.out);
  const code = repo.read("app/src/features/user.ts");
  const fromCharts = imports(code).filter((i) => i.spec === "@/types/charts");
  assert.equal(fromCharts.length, 1, code);
  assert.deepEqual(fromCharts[0].names.sort(), ["A", "B"], code);
  assert.deepEqual(specOf(code, "C"), ["@/types"], code);
  assert.deepEqual(syntaxErrors(code, "user.ts"), [], code);
});

test("26. symbols back-import follows the source file's alias style", (t) => {
  const repo = makeRepo(t, {
    "app/src/lib/other.ts": "export const OTHER = 1;\n",
    "app/src/zz/src.ts": 'import { OTHER } from "@/lib/other";\n\nexport const KEEP = MOVED + OTHER;\n',
    "app/src/zz/dest.ts": "export const MOVED = 1;\n",
    "app/src/lib/user.ts": 'import { MOVED, KEEP } from "@/zz/src";\nexport const U = MOVED + KEEP;\n',
  });
  const r = repo.run([{ op: "symbols", from: "zz/src.ts", to: "zz/dest.ts", symbols: ["MOVED"] }], { apply: true });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(specOf(repo.read("app/src/zz/src.ts"), "MOVED"), ["@/zz/dest"]);
});

test("27. a mock factory of the destination that drops the real module is flagged; one that keeps it is not", (t) => {
  const repo = makeRepo(t, {
    "app/src/zz/m-from.ts": "export const X = 1;\n",
    "app/src/zz/m-to.ts": "export const X = 1;\nexport const Y = 2;\n",
    "app/src/lib/user.ts": 'import { X } from "@/zz/m-from";\nexport const U = X;\n',
    "app/src/__tests__/bare.test.ts": 'jest.mock("@/zz/m-to", () => ({ Y: 3 }));\ntest("y", () => {});\n',
    "app/src/__tests__/actual.test.ts":
      'jest.mock("@/zz/m-to", () => ({ ...jest.requireActual("@/zz/m-to"), Y: 3 }));\ntest("y", () => {});\n',
  });
  const r = repo.run([{ op: "merge", from: "zz/m-from.ts", to: "zz/m-to.ts" }]);
  assert.equal(r.status, 0, r.out);
  const manual = section(r.stdout, MANUAL);
  assert.ok(manual.some((l) => l.includes("__tests__/bare.test.ts") && l.includes("X")), JSON.stringify(manual));
  assert.ok(!manual.some((l) => l.includes("__tests__/actual.test.ts")), JSON.stringify(manual));
});

test("28. string literals that hard-code the moved file's path are flagged", (t) => {
  const repo = makeRepo(t, {
    "app/src/zz/old.ts": "export const OLD = 1;\n",
    "app/src/__tests__/guard.test.ts":
      'import path from "node:path";\nconst SRC = path.join(__dirname, "..");\nconst a = path.join(SRC, "zz", "old.ts");\nconst b = "src/zz/old";\ntest("g", () => [a, b]);\n',
  });
  const r = repo.run([{ op: "move", from: "zz/old.ts", to: "zz/n/old.ts" }]);
  assert.equal(r.status, 0, r.out);
  const manual = section(r.stdout, MANUAL);
  assert.ok(manual.some((l) => l.includes("guard.test.ts:3") && l.includes("old.ts")), JSON.stringify(manual));
  assert.ok(manual.some((l) => l.includes("guard.test.ts:4")), JSON.stringify(manual));
});

test("29. moving x.ts to x/index.ts leaves directory-style specifiers untouched", (t) => {
  const repo = makeRepo(t, {
    "app/src/zz/x.ts": "export const X = 1;\n",
    "app/src/lib/a.ts": 'import { X } from "@/zz/x";\nexport const A = X;\n',
    "app/src/zz/b.ts": 'import { X } from "./x";\nexport const B = X;\n',
  });
  const r = repo.run([{ op: "move", from: "zz/x.ts", to: "zz/x/index.ts" }], { apply: true });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(specOf(repo.read("app/src/lib/a.ts"), "X"), ["@/zz/x"]);
  assert.deepEqual(specOf(repo.read("app/src/zz/b.ts"), "X"), ["./x"]);
  assert.deepEqual(allSpecifiersResolve(repo), []);
});

test("30. ESM projects keep their .js extensions in rewritten specifiers", (t) => {
  const repo = makeRepo(
    t,
    {
      "src/util/old.ts": 'import { H } from "../helper.js";\nexport const OLD = H;\n',
      "src/helper.ts": "export const H = 1;\n",
      "src/main.ts": 'import { OLD } from "./util/old.js";\nexport const M = OLD;\n',
    },
    {
      config: { roots: [{ name: "lib", dir: ".", src: "src" }] },
      tsconfig: null,
    },
  );
  repo.write("tsconfig.json", JSON.stringify({ compilerOptions: { module: "nodenext", moduleResolution: "nodenext" } }));
  repo.git("add", "-A");
  repo.git("commit", "-qm", "tsconfig");
  const r = repo.run([{ op: "move", from: "util/old.ts", to: "util/deep/old.ts" }], { apply: true });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(specOf(repo.read("src/main.ts"), "OLD"), ["./util/deep/old.js"]);
  assert.deepEqual(specOf(repo.read("src/util/deep/old.ts"), "H"), ["../../helper.js"]);
});

test("31. importers keep the alias prefix they used, and tsconfig extends is honoured", (t) => {
  const repo = makeRepo(
    t,
    {
      "app/tsconfig.base.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "~lib/*": ["./src/lib/*"], "@/*": ["./src/*"] } } }),
      "app/tsconfig.json": JSON.stringify({ extends: "./tsconfig.base.json", compilerOptions: { jsx: "preserve" } }),
      "app/src/lib/old.ts": "export const OLD = 1;\n",
      "app/src/features/a.ts": 'import { OLD } from "~lib/old";\nexport const A = OLD;\n',
      "app/src/features/b.ts": 'import { OLD } from "@/lib/old";\nexport const B = OLD;\n',
    },
    { tsconfig: null },
  );
  const r = repo.run([{ op: "move", from: "lib/old.ts", to: "lib/deep/old.ts" }], { apply: true });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(specOf(repo.read("app/src/features/a.ts"), "OLD"), ["~lib/deep/old"]);
  assert.deepEqual(specOf(repo.read("app/src/features/b.ts"), "OLD"), ["@/lib/deep/old"]);
});

test("32. protected and neverMove files are refused as a source and nothing changes", (t) => {
  const repo = makeRepo(
    t,
    {
      "app/src/lib/billing/ledger.ts": "export const P = 1;\n",
      "app/src/app/page.tsx": "export default function Page() { return null; }\n",
      "app/src/lib/x.ts": "export const P = 1;\n",
    },
    { config: { ...DEFAULT_CONFIG, extends: ["next-app-router"] } },
  );
  const before = snapshot(repo.root);
  for (const map of [
    [{ op: "move", from: "lib/billing/ledger.ts", to: "lib/ledger.ts" }],
    [{ op: "move", from: "app/page.tsx", to: "app/home/page.tsx" }],
  ]) {
    const r = repo.run(map, { apply: true });
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /protected|neverMove/, r.out);
  }
  const ok = repo.run([{ op: "merge", from: "lib/x.ts", to: "lib/billing/ledger.ts" }]);
  assert.equal(ok.status, 0, ok.out);
  assert.deepEqual(snapshot(repo.root), before);
});

test("33. files in an included folder outside src are rewritten and can be moved", (t) => {
  const repo = makeRepo(t, {
    "app/src/lib/old.ts": "export const OLD = 1;\n",
    "app/scripts/seed.ts": 'import { OLD } from "../src/lib/old";\nexport const S = OLD;\n',
  });
  const r = repo.run([{ op: "move", from: "lib/old.ts", to: "lib/n/old.ts" }], { apply: true });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(specOf(repo.read("app/scripts/seed.ts"), "OLD"), ["../src/lib/n/old"]);
  const r2 = repo.run([{ op: "move", from: "../scripts/seed.ts", to: "../scripts/db/seed.ts" }], { apply: true });
  assert.equal(r2.status, 0, r2.out);
  assert.deepEqual(specOf(repo.read("app/scripts/db/seed.ts"), "OLD"), ["../../src/lib/n/old"]);
});

test("34. JSX inside .js files parses and its importers are rewritten", (t) => {
  const repo = makeRepo(
    t,
    {
      "web/src/components/Button.js": "export function Button() { return <button>ok</button>; }\n",
      "web/src/App.js": 'import { Button } from "./components/Button";\nexport default function App() { return <Button />; }\n',
    },
    { config: { roots: [{ name: "web", dir: "web", src: "src" }] }, tsconfig: null },
  );
  const r = repo.run([{ op: "move", from: "components/Button.js", to: "components/ui/Button.js" }], { apply: true });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(specOf(repo.read("web/src/App.js"), "Button"), ["./components/ui/Button"]);
});

test("35. without a config the scripts explain how to get one", (t) => {
  const repo = makeRepo(t, { "app/src/a.ts": "export const A = 1;\n" }, { config: null });
  const r = repo.run([{ op: "move", from: "a.ts", to: "b.ts" }]);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /discover\.mjs/, r.out);
});

test("36. a symbols dry run previews importer rewrites before the destination exists; --apply still refuses", (t) => {
  const repo = makeRepo(t, {
    "app/src/shared/utils.ts": "export const A = 1;\nexport const B = 2;\n",
    "app/src/lib/user.ts": 'import { A, B } from "@/shared/utils";\nexport const U = A + B;\n',
  });
  const map = [{ op: "symbols", from: "shared/utils.ts", to: "features/cart/cart.ts", symbols: ["A"] }];
  const dry = repo.run(map);
  assert.equal(dry.status, 0, dry.out);
  assert.match(dry.stdout, /app\/src\/lib\/user\.ts/);
  assert.match(dry.stdout, /preview only/);
  assert.equal(repo.status(), "");
  const applied = repo.run(map, { apply: true });
  assert.notEqual(applied.status, 0);
  assert.match(applied.stderr, /^error: /m);
  assert.doesNotMatch(applied.stderr, /at .*\.mjs:\d+/);
  assert.equal(repo.status(), "");
});
