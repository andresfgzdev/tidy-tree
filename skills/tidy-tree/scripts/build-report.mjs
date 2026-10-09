#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/project.mjs";

const USAGE = `build-report.mjs: render report.json into the interactive HTML review.

  node build-report.mjs --data report.json [--out file.html] [--open]

Validates the data against the shape in references/html-report.md, then writes the HTML
(default: <os tmpdir>/tidy-tree-<id>.html) and prints its path.`;

process.on("uncaughtException", (e) => {
  console.error(`error: ${e?.message ?? e}`);
  if (process.env.TIDY_TREE_DEBUG) console.error(e?.stack);
  process.exit(1);
});

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.data) {
  console.log(USAGE);
  process.exit(args.help ? 0 : 1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const shell = fs.readFileSync(path.join(here, "../assets/report-shell.html"), "utf8");
const report = JSON.parse(fs.readFileSync(path.resolve(String(args.data)), "utf8"));

const errors = [];
const STRENGTH = ["strong", "worth", "optional"];
const TYPES = ["split", "fold", "merge-duplicates", "colocate", "move", "remove-barrel", "delete-dead", "standard-conflict", "rename"];
const MARKS = ["grab", "tiny", "dup", "leaves", "gone", "new", "dest", "keep"];
const BASIS = ["enforced", "documented", "observed", "heuristic"];
for (const k of ["id", "repo", "scope", "candidates"]) if (!report[k]) errors.push(`missing top-level "${k}"`);
if (report.id && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(report.id))) errors.push(`id "${report.id}" must be letters, digits, ".", "_" or "-" (it becomes a file name)`);
if (report.candidates && !Array.isArray(report.candidates)) errors.push(`"candidates" must be an array`);
if (report.deferred && !Array.isArray(report.deferred)) errors.push(`"deferred" must be an array`);
const RESERVED = new Set(["app", "counts", "toast", "copy", "download", "top", "report-data"]);
const ids = new Set();
(Array.isArray(report.candidates) ? report.candidates : []).forEach((c, i) => {
  const at = `candidates[${i}]${c.id ? ` (${c.id})` : ""}`;
  for (const k of ["id", "title", "type", "strength", "problem", "solution"]) if (!c[k]) errors.push(`${at}: missing "${k}"`);
  if (ids.has(c.id)) errors.push(`${at}: duplicate id`);
  if (c.id && (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(String(c.id)) || RESERVED.has(String(c.id)))) errors.push(`${at}: id must start with a letter, use letters, digits, "_" or "-", and not be one of ${[...RESERVED].join(", ")}`);
  ids.add(c.id);
  if (c.strength && !STRENGTH.includes(c.strength)) errors.push(`${at}: strength must be one of ${STRENGTH.join("|")}`);
  if (c.type && !TYPES.includes(c.type)) errors.push(`${at}: type must be one of ${TYPES.join("|")}`);
  if (!c.basis) errors.push(`${at}: missing "basis" (${BASIS.join("|")}): which kind of project rule backs this candidate`);
  else if (!BASIS.includes(c.basis)) errors.push(`${at}: basis must be one of ${BASIS.join("|")}`);
  for (const side of ["before", "after"])
    for (const e of c[side]?.tree ?? []) {
      const p = typeof e === "string" ? e : e?.path;
      if (typeof p !== "string" || !p) errors.push(`${at}.${side}: every tree entry needs a string path`);
      else if (typeof e !== "string" && e.mark && !MARKS.includes(e.mark)) errors.push(`${at}.${side}: unknown mark "${e.mark}"`);
    }
  if (!c.before && !c.code && !c.fanIn && !c.mermaid) errors.push(`${at}: needs at least one visual (before/after trees, code, fanIn or mermaid)`);
});
if (report.topRecommendation && !ids.has(report.topRecommendation.candidateId)) errors.push("topRecommendation.candidateId does not match a candidate");
if (errors.length) {
  console.error("report.json is invalid:\n- " + errors.join("\n- "));
  process.exit(1);
}

const json = JSON.stringify(report).replace(/</g, "\\u003c");
const html = shell.replace("__REPORT_JSON__", () => json);
const out = path.resolve(String(args.out ?? path.join(os.tmpdir(), `tidy-tree-${report.id}.html`)));
fs.writeFileSync(out, html);
console.log(out);
if (args.open) {
  const [cmd, ...pre] = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
  try {
    execFileSync(cmd, [...pre, out], { stdio: "ignore" });
  } catch {
    console.error(`could not open a browser; open ${out} yourself`);
  }
}
