import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DISCOVER, makeRepo, MANUAL, run, section, tempDir, TS_PATH } from "./helpers.mjs";

const cfg = (extra = {}) => ({ roots: [{ name: "app", dir: "app", src: "src", ...extra }] });

test("names imported without `type` but used only as types are type-only; class extends stays a value use", (t) => {
  const repo = makeRepo(
    t,
    {
      "app/src/hooks/use-toast.ts": "export function useToast() { return 1; }\nexport class Base {}\n",
      "app/src/lib/types-only.ts": 'import { useToast } from "@/hooks/use-toast";\nexport type T = typeof useToast;\n',
      "app/src/lib/runtime.ts": 'import { Base } from "@/hooks/use-toast";\nexport class Sub extends Base {}\n',
    },
    { config: cfg({ layers: [{ from: ["lib/**"], to: ["hooks/**"], allowTypeOnly: true, basis: "observed" }] }) },
  );
  const { json, out } = repo.inventory("full");
  assert.deepEqual(json.layerViolations.map((v) => v.file), ["lib/runtime.ts"], out);
});

test("a long file with one export is not a grab-bag; CSS and asset imports are not reported unresolved", (t) => {
  const body = Array.from({ length: 320 }, (_, i) => `  const v${i} = ${i};`).join("\n");
  const repo = makeRepo(
    t,
    { "app/src/components/Big.tsx": `import "./big.css";\nexport function Big() {\n${body}\n  return null;\n}\n`, "app/src/components/big.css": ".a{}\n" },
    { config: cfg() },
  );
  const { json, out } = repo.inventory("full");
  assert.deepEqual(json.grabBags, [], out);
  assert.deepEqual(json.unresolved, [], out);
});

test("a dry run previews an operation that shares importers with an earlier one instead of skipping it", (t) => {
  const repo = makeRepo(t, {
    "app/src/zz/a.ts": "export const A = 1;\n",
    "app/src/zz/b.ts": "export const B = 1;\n",
    "app/src/lib/user.ts": 'import { A } from "@/zz/a";\nimport { B } from "@/zz/b";\nexport const U = A + B;\n',
  });
  const r = repo.run([
    { op: "move", from: "zz/a.ts", to: "zz/n/a.ts" },
    { op: "move", from: "zz/b.ts", to: "zz/n/b.ts" },
  ]);
  assert.equal(r.status, 0, r.out);
  const op2 = r.stdout.split(/^## /m).find((s) => s.startsWith("op 2"));
  assert.doesNotMatch(op2, /not previewed/);
  assert.match(op2, /app\/src\/lib\/user\.ts/);
  assert.ok(section(op2, MANUAL).some((l) => l.includes("earlier operation")), op2);
});

test("docs named after a moved file are listed so they can move with it", (t) => {
  const repo = makeRepo(t, {
    "app/src/hooks/use-cart.ts": "export const useCart = () => 1;\n",
    "docs/hooks/use-cart.md": "# useCart\n",
  });
  const r = repo.run([{ op: "move", from: "hooks/use-cart.ts", to: "hooks/cart/use-cart.ts" }]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /docs\/hooks\/use-cart\.md: doc named after the moved file/);
});

test("discover ranks agent docs first, finds placement skills and structure tests, and reuses the repo's jest script", (t) => {
  const repo = makeRepo(
    t,
    {
      "package.json": JSON.stringify({
        name: "web",
        scripts: { test: "jest --watch", "test:jest": "NODE_OPTIONS=--experimental-vm-modules jest" },
        devDependencies: { jest: "30.0.0", typescript: "5.9.0" },
      }),
      "tsconfig.json": "{}",
      "CLAUDE.md": "# rules\n",
      "docs/standards/naming.md": "# naming\n",
      "docs/templates/architecture-template.md": "# template\n",
      ".claude/skills/placement/SKILL.md": "---\nname: placement\ndescription: Decide where files belong and fix folder placement\n---\n",
      ".claude/skills/other/SKILL.md": "---\nname: other\ndescription: Write release notes\n---\n",
      "src/a.ts": "export const A = 1;\n",
      "src/b.ts": 'import { A } from "./a";\nexport const B = A;\n',
      "src/c.ts": 'import { B } from "./b";\nexport const C = B;\n',
      "src/__tests__/structure.test.ts": 'import fs from "node:fs";\nconst files = fs.readdirSync(__dirname + "/..");\ntest("x", () => files);\n',
      "src/__tests__/plain.test.ts": 'test("y", () => 1);\n',
    },
    { config: null, tsconfig: null },
  );
  const side = tempDir(t, "tt-disc-");
  const out = join(side, "arch.json");
  const r = run(DISCOVER, ["--root", repo.root, "--ts", TS_PATH, "--out", out]);
  assert.equal(r.status, 0, r.out);
  const arch = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(arch.conventions.docs[0], "CLAUDE.md");
  assert.ok(!arch.conventions.docs.some((d) => d.includes("template")), JSON.stringify(arch.conventions.docs));
  assert.deepEqual(arch.conventions.projectSkills, [".claude/skills/placement/SKILL.md"]);
  assert.deepEqual(arch.conventions.guardTests, ["src/__tests__/structure.test.ts"]);
  assert.equal(arch.roots[0].verify.relatedTests, "npm run test:jest -- --findRelatedTests --passWithNoTests {files}");
});

test("re-exports and imports of names that are only types in the target count as type-only", (t) => {
  const repo = makeRepo(
    t,
    {
      "app/src/lib/db/shapes.ts": "export interface Row { id: string }\nexport type Id = string;\n",
      "app/src/types/index.ts": 'export { Row, Id } from "@/lib/db/shapes";\n',
      "app/src/types/other.ts": 'import { Row } from "@/lib/db/shapes";\nexport const make = (r: Row) => r;\n',
    },
    { config: cfg({ layers: [{ from: "types/**", to: "lib/**", allowTypeOnly: true }] }) },
  );
  const { json, out } = repo.inventory("full");
  assert.deepEqual(json.layerViolations, [], out);
});
