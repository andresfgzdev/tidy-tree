import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo } from "./helpers.mjs";

const CONFIG = {
  extends: ["next-app-router"],
  roots: [
    {
      name: "app",
      dir: "app",
      src: "src",
      sharedRoots: ["shared"],
      areaRoots: ["features/*"],
      scopes: { ui: ["features/cart", "shared"] },
      layers: [
        { from: "shared/**", to: "features/**", basis: "observed", why: "shared code never reaches into features" },
        { from: "features/**", to: "server/**", exceptTo: ["server/types/**"], source: "docs/architecture.md", why: "UI does not import server code" },
      ],
    },
  ],
};

function repoWithApp(t) {
  return makeRepo(
    t,
    {
      "app/src/app/(shop)/cart/page.tsx": 'import { Cart } from "@/features/cart/cart";\nexport default function Page() { return Cart(); }\n',
      "app/src/app/api/orders/route.ts": "export async function GET() { return new Response(); }\n",
      "app/src/features/cart/cart.tsx": 'import { money } from "@/shared/money";\nimport type { Order } from "@/server/types/order";\nimport { db } from "@/server/db";\nexport function Cart(o?: Order) { return money(db.total) + String(o); }\n',
      "app/src/features/catalog/list.tsx": 'import { money } from "@/shared/money";\nexport const List = () => money(1);\n',
      "app/src/shared/money.ts": 'import { CART_LABEL } from "@/features/cart/labels";\nexport const money = (n: number) => `${CART_LABEL}${n}`;\n',
      "app/src/features/cart/labels.ts": 'export const CART_LABEL = "$";\n',
      "app/src/shared/cart-only.ts": "export const ONLY = 1;\n",
      "app/src/features/cart/uses-only.ts": 'import { ONLY } from "@/shared/cart-only";\nexport const U = ONLY;\n',
      "app/src/server/db.ts": "export const db = { total: 1 };\n",
      "app/src/server/types/order.ts": "export type Order = { id: string };\n",
    },
    { config: CONFIG },
  );
}

test("inventory: config layers with basis, exceptions and areas from areaRoots and route groups", (t) => {
  const repo = repoWithApp(t);
  const { status, out, json } = repo.inventory("full");
  assert.equal(status, 0, out);
  const v = json.layerViolations.map((x) => `${x.file}->${x.imports}:${x.basis}`).sort();
  assert.deepEqual(v, ["features/cart/cart.tsx->server/db.ts:documented", "shared/money.ts->features/cart/labels.ts:observed"]);
  const page = json.files.find((f) => f.file === "app/(shop)/cart/page.tsx");
  assert.equal(page.area, "app/cart");
  const money = json.files.find((f) => f.file === "shared/money.ts");
  assert.deepEqual(Object.keys(money.consumerAreas).sort(), ["features/cart", "features/catalog"]);
});

test("inventory: framework entry points are never orphans and shared scope reads sharedRoots", (t) => {
  const repo = repoWithApp(t);
  const full = repo.inventory("full").json;
  assert.ok(!full.orphans.some((o) => o.file.endsWith("route.ts") || o.file.endsWith("page.tsx")), JSON.stringify(full.orphans));
  const shared = repo.inventory("shared").json;
  assert.deepEqual(shared.scope, ["shared"]);
  assert.ok(shared.singleConsumer.some((s) => s.file === "shared/cart-only.ts" && s.onlyConsumerArea === "features/cart"), JSON.stringify(shared.singleConsumer));
  const named = repo.inventory("ui").json;
  assert.deepEqual(named.scope.sort(), ["features/cart", "shared"]);
});

test("inventory: a scope that matches nothing fails clearly", (t) => {
  const repo = repoWithApp(t);
  const r = repo.inventory("nope");
  assert.notEqual(r.status, 0);
  assert.match(r.out, /no source files matched/);
});

test("inventory: a small shared file serving different areas export by export is a mixed-consumers grab-bag", (t) => {
  const repo = makeRepo(
    t,
    {
      "app/src/shared/utils.ts": "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n",
      "app/src/features/cart/x.ts": 'import { a, d } from "@/shared/utils";\nexport const X = a + d;\n',
      "app/src/features/checkout/y.ts": 'import { b, d } from "@/shared/utils";\nexport const Y = b + d;\n',
      "app/src/features/catalog/z.ts": 'import { c } from "@/shared/utils";\nexport const Z = c;\n',
    },
    { config: { roots: [{ name: "app", dir: "app", src: "src", sharedRoots: ["shared"], areaRoots: ["features/*"] }] } },
  );
  const { status, out, json } = repo.inventory("shared");
  assert.equal(status, 0, out);
  const g = json.grabBags.find((x) => x.file === "shared/utils.ts");
  assert.ok(g, out);
  assert.equal(g.reason, "mixed-consumers");
  assert.deepEqual(g.proposedGroups.map((p) => p.area).sort(), ["features/cart", "features/catalog", "features/checkout"]);
});
