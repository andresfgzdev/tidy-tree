import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD, run, snapshot, tempDir } from "./helpers.mjs";

function reportSandbox(t) {
  const dir = tempDir(t, "tt-test-report-");
  return {
    dir,
    build(data, { out = join(dir, "out.html"), useOut = true } = {}) {
      const dataFile = join(dir, `data-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(dataFile, JSON.stringify(data, null, 2));
      const args = ["--data", dataFile];
      if (useOut) args.push("--out", out);
      const r = run(BUILD, args, { env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir } });
      return { status: r.status, out: r.out, file: out };
    },
  };
}

function baseReport(candidateOverrides = {}, reportOverrides = {}) {
  return {
    id: "tt-test-20261007",
    repo: "example-app",
    scope: "types",
    generatedAt: "2026-10-07T14:12:00Z",
    headline: "Split `types/index.ts`",
    summary: "Scanned types.",
    stats: [{ label: "files scanned", value: 3 }],
    candidates: [
      {
        id: "C1",
        title: "Split chart types",
        type: "split",
        strength: "strong",
        risk: "low",
        basis: "documented",
        problem: "Too big.",
        solution: "Split it.",
        before: { tree: [{ path: "types/index.ts", mark: "grab" }] },
        after: { tree: [{ path: "types/charts/a.ts", mark: "new" }] },
        ...candidateOverrides,
      },
    ],
    deferred: [],
    ...reportOverrides,
  };
}

function embeddedData(html) {
  const m = html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(m, "no embedded report-data script");
  return JSON.parse(m[1]);
}

test("20. valid report renders and hostile strings round-trip through the embedded JSON", (t) => {
  const sb = reportSandbox(t);
  const nasty = "close </script><script>alert(1)</script> and $& and $' and $` and $1";
  const data = baseReport({ title: nasty, problem: nasty, mermaid: "flowchart LR\n  A[</script>] --> B[$&]" });
  const r = sb.build(data);
  assert.equal(r.status, 0, r.out);
  assert.ok(existsSync(r.file), r.out);
  const html = readFileSync(r.file, "utf8");
  assert.match(html, /<html/i);
  const parsed = embeddedData(html);
  assert.equal(parsed.candidates[0].title, nasty);
  assert.equal(parsed.candidates[0].problem, nasty);
  assert.equal(parsed.candidates[0].mermaid, data.candidates[0].mermaid);
  assert.deepEqual(parsed, data);
});

test("21. invalid report exits non-zero and lists each error", (t) => {
  const sb = reportSandbox(t);
  const data = baseReport({ type: "bogus", title: undefined, before: undefined, after: undefined });
  const r = sb.build(JSON.parse(JSON.stringify(data)));
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /type/i, r.out);
  assert.match(r.out, /title/i, r.out);
  assert.match(r.out, /visual/i, r.out);
  assert.ok(!existsSync(r.file), "html written despite invalid data");
});

test("22. a report id with path characters is rejected", (t) => {
  const sb = reportSandbox(t);
  const nested = join(sb.dir, "a", "b");
  mkdirSync(nested, { recursive: true });
  const before = snapshot(sb.dir);
  const r = sb.build(baseReport({}, { id: "../../x" }), { useOut: false });
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /\bid\b/i, r.out);
  const after = snapshot(sb.dir);
  const added = Object.keys(after).filter((k) => !(k in before) && !k.startsWith("data-"));
  assert.deepEqual(added, []);
  assert.ok(!existsSync(join(sb.dir, "..", "x.html")));
  assert.ok(!existsSync(join(sb.dir, "x.html")));
});

test("23. candidate ids that collide with page element ids are rejected or namespaced", async (t) => {
  for (const id of ["counts", "toast", "copy", "download", "app", "top"]) {
    await t.test(id, (st) => {
      const sb = reportSandbox(st);
      const r = sb.build(baseReport({ id }, { topRecommendation: { candidateId: id, title: "x", why: "y" } }));
      if (r.status !== 0) {
        assert.match(r.out, new RegExp(id), r.out);
        return;
      }
      const html = readFileSync(r.file, "utf8");
      const count = html.split(`id="${id}"`).length - 1;
      assert.ok(count <= 1, `id="${id}" appears ${count} times in rendered HTML`);
    });
  }
});

test("24. a tree entry without a string path is rejected", (t) => {
  const sb = reportSandbox(t);
  for (const entry of [{ mark: "grab" }, { path: 42, mark: "grab" }]) {
    const r = sb.build(baseReport({ before: { tree: [entry] } }));
    assert.notEqual(r.status, 0, `${JSON.stringify(entry)}\n${r.out}`);
    assert.match(r.out, /path/i, r.out);
  }
});
