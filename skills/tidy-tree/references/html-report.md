# The HTML report

You write one JSON file describing the candidates. `scripts/build-report.mjs` validates it and renders `assets/report-shell.html`, which draws the trees, bars, code pairs and Mermaid graphs and adds the approve/later/skip controls. Don't hand-write HTML; the shell keeps every run consistent and keeps the decisions export working.

```bash
node ${CLAUDE_SKILL_DIR}/scripts/build-report.mjs --data <scratch>/tt-report-<id>.json --out <scratch>/tidy-tree-<id>.html --open
```

The command prints the HTML path. Tell the user the path and how to send decisions back (SKILL.md step 5).

## report.json

```json
{
  "id": "types-20261007-1412",
  "repo": "acme-web",
  "scope": "types, lib/constants",
  "generatedAt": "2026-10-07T14:12:00Z",
  "headline": "`types/index.ts` serves 21 areas; split it by domain",
  "summary": "One or two plain sentences: what you scanned and the shape of the problem.",
  "stats": [
    { "label": "files scanned", "value": 53 },
    { "label": "candidates", "value": 7 },
    { "label": "files a full run would rewrite", "value": "~260" }
  ],
  "candidates": [ "…see below…" ],
  "deferred": [
    { "title": "`PaymentType` declared identically in `models/order.ts` and `types/orders/order-detail.ts`", "reason": "outside the top 10; small" }
  ],
  "topRecommendation": { "candidateId": "C1", "title": "Split catalog types out of `types/index.ts`", "why": "One sentence." }
}
```

`id` must be unique per run and use only letters, digits, `.`, `_` and `-`; the decisions file, the browser's saved state and the output file name are keyed on it. Candidate ids start with a letter (`C1`, `C2`, …).

`deferred` lists real findings that didn't make the ranked list, each with a one-line reason. Put every verified finding either in `candidates` or in `deferred`; nothing you confirmed should disappear between the inventory and the report.

## A candidate

```json
{
  "id": "C1",
  "title": "Split catalog types out of `types/index.ts`",
  "type": "split",
  "strength": "strong",
  "risk": "medium",
  "basis": "documented",
  "files": ["src/types/index.ts", "src/types/catalog/"],
  "evidence": [
    { "label": "importers", "value": 148 },
    { "label": "consumer areas", "value": 37 },
    { "label": "exports moving", "value": 13 }
  ],
  "before": {
    "tree": [
      { "path": "types/index.ts", "mark": "grab", "note": "61 exports, 510 lines" },
      { "path": "types/catalog/index.ts" }
    ]
  },
  "after": {
    "tree": [
      { "path": "types/index.ts", "mark": "keep", "note": "48 exports" },
      { "path": "types/catalog/index.ts" },
      { "path": "types/catalog/product-card.ts", "mark": "new", "note": "ProductCardProps, PriceBadge, …" }
    ]
  },
  "fanIn": [ { "area": "features/catalog", "count": 13 }, { "area": "app/api/products", "count": 11 } ],
  "fanInLabel": "Who imports the moving exports",
  "code": {
    "left":  { "title": "hooks/use-export-csv.ts#downloadFile", "code": "…" },
    "right": { "title": "lib/files.ts#saveBlob", "code": "…" }
  },
  "mermaid": "flowchart LR\n  A[types/index.ts] --> B[features/catalog]",
  "problem": "One or two sentences on what hurts, with numbers.",
  "solution": "One or two sentences on what changes.",
  "standard": "`docs/architecture.md` § Types: shared types live in a domain folder under `types/` (14 of 16 domains already do).",
  "wins": ["Catalog edits stop touching checkout", "Smaller review diffs"],
  "risks": ["`jest.mock(\"@/types\")` in 2 tests needs a manual look"],
  "plan": [ { "op": "symbols", "from": "types/index.ts", "to": "types/catalog/product-card.ts", "symbols": ["ProductCardProps"] } ],
  "verify": ["type check", "lint touched files", "related tests", "git grep for the old path"]
}
```

### Field rules

- **Required:** `id`, `title`, `type`, `strength`, `basis`, `problem`, `solution`, and at least one visual (`before`/`after`, `code`, `fanIn` or `mermaid`).
- **`basis`:** `enforced`, `documented`, `observed` or `heuristic` (`architecture.md`). It shows as a badge. `standard` says the rule itself and its source, or the numbers for an observed convention. A `heuristic` candidate is never `strong`.
- **`type`:** `split`, `fold`, `merge-duplicates`, `colocate`, `move`, `remove-barrel`, `delete-dead`, `standard-conflict` or `rename`.
- **`strength`:** `strong` (clear win, low regret), `worth` (real win, needs judgment or more steps), `optional` (tidy-up).
- **`risk`:** `low`, `medium` or `high`, based on blast radius and the hidden references you found.
- **Tree marks:** `grab`, `tiny`, `dup`, `leaves` (moves out), `gone` (deleted), `new`, `dest` (existing file that receives code) and `keep`. A tree is a list of paths; folders are drawn from the paths, so list only the files that matter plus one or two unchanged siblings for orientation.
- **Backticks** in any prose field render as inline code. No other markup.
- **`verify`** names the checks in plain words; the exact commands live in the config's `verify`, so don't copy them here.
- **`plan`** holds the exact operations you would pass to `rewrite-imports.mjs`. The user sees it under "Execution plan", and you reuse it in step 6. Leave it out for candidates the script doesn't perform: `delete-dead`, `standard-conflict`, `rename`, and function-level merges done by hand.
- **`files`** is optional but recommended: the files the candidate touches, repo-relative.

## Picking the visual

| Candidate | Visual that carries it |
|---|---|
| `split` | before/after trees, plus `fanIn` of the consumer areas for the exports that move |
| `fold`, `move`, `colocate`, `remove-barrel` | before/after trees |
| `merge-duplicates` | `code` side by side (trim each to the lines that match, 25 lines at most), plus trees |
| `delete-dead` | trees with `gone` marks; put the "no references found" proof in `evidence` |
| `standard-conflict` | `code` with the two contradicting standard lines as left and right |
| an import tangle or cycle | `mermaid` flowchart |

## Writing style

Prose is sparse. If a candidate needs a paragraph, its visual is wrong. Name things with the repo's own domain nouns and folder names. Each `wins` chip is six words or fewer.
