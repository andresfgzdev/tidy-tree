---
name: tidy-tree
description: >
  Use when someone asks to reorganize, tidy, consolidate or restructure files and folders in a
  JavaScript or TypeScript repository; says a folder is messy, has too many loose files or an
  index/constants/utils file has grown too big; wants duplicated or near-duplicate helpers and
  types found and merged; or asks where a file should live. Covers grab-bag files, fragment
  files, misplaced or "shared" files only one feature uses, layer-crossing imports, import
  cycles and dead exports. Not for reviewing a PR diff or scoring overall code quality.
license: MIT
compatibility: Node.js 20+, git, and a JS/TS repository with typescript in node_modules.
---

# tidy-tree

Put every file where **this project's own architecture** says it belongs, with no grab-bags and no copies. Measure how far the tree has drifted from the project's conventions, show the drift visually, and fix only what the user approves, one verified increment at a time.

**The project is the standard.** Never move a project toward a structure you prefer. A layer-first app stays layer-first, a feature-first app stays feature-first, kebab-case stays kebab-case. A candidate is an outlier from the project's own rules, never a migration to different ones. If you catch yourself proposing "the usual way" instead of "the way this repo already does it", drop the candidate.

Scripts live in `${CLAUDE_SKILL_DIR}/scripts/` (the folder holding this SKILL.md). Run them with `node`, from the repository you are changing.

If the user only asks where one thing should go, answer from the project's conventions (step 1 if there's no config yet, `references/architecture.md` otherwise) and stop. Don't run the inventory.

## Arguments

A scope and optional flags.

| Token | Scans |
|---|---|
| `shared` (default) | the config's `sharedRoots` (the whole root when there are none) |
| a name from the config's `scopes` | those folders |
| `full` | the whole root |
| a path | that folder, relative to the root's `src` or the repo |

Combine tokens with commas. Flags:
- `--workspace <name>`: which root to scan in a monorepo.
- `--report-only`: stop after the report.
- `--resume <decisions.json>`: skip to step 6 with an earlier report's decisions.
- `--candidates <n>`: how many candidates to rank (default 10).

## How to work

- **Leave git to the user.** Never commit, push, stash or `git checkout --` files unless they ask; each candidate ends as a reviewable uncommitted change. Stash and checkout can destroy someone else's in-flight work.
- **Keep intermediate files in a scratch directory**: the session scratchpad if your harness gives one, otherwise a fresh `mktemp -d`. Name them with the report id (`tt-inventory-<id>.json`, `tt-report-<id>.json`, `tt-<id>-C3.json`). Never write them into the repository.
- **If your harness loads path-scoped rules when a file is read** (Claude Code `.claude/rules/`, Cursor rules), read and edit repo files with the file tools rather than the shell, so those rules load.
- **Cite the basis for every destination**: an enforced rule, a documented convention, an observed convention with its share, or a heuristic. A heuristic alone never justifies a `strong` candidate.

## Step 1: Understand the architecture

Skip this step when `tidy-tree.config.json` (or `.tidy-tree.json`) exists at the repo root and the user doesn't say the project changed. Otherwise:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/discover.mjs --out <scratch>/tt-arch.json --config-out <scratch>/tidy-tree.config.json
```

It reads manifests, tsconfig, the folder tree, the import graph, convention docs, lint boundary rules and git history, prints what it observed, and drafts a config. It changes nothing in the repo. Then follow `references/architecture.md`:

1. Read the convention docs and enforced rules it lists (CLAUDE.md, AGENTS.md, a constitution, ARCHITECTURE, ADRs, lint boundaries), highest-ranked first. If it lists a **project skill about file placement**, read that skill and its references first: it usually encodes the repo's placement rules better than any single doc.
2. Reconcile the draft with them. Written and enforced rules outrank observed ones. Drop observed layer rules that a doc contradicts, and add the documented exceptions. Fill `sharedRoots` (the folders the docs say hold reusable code) and `areaRoots` (folders whose children are separate features or domains) when the draft left them empty; in a layer-first repo that usually means domain subfolders such as `components/features/*` or `hooks/*`. Check `verify` against how the docs say to run tests.
3. Show the user a short architecture summary and the draft config, then ask:
   - Is this how the project is meant to be organised?
   - Which files must never move or change?
   - Should the config be saved at the repo root for future runs, or stay in scratch?
4. Use the confirmed config (`--config <path>` if it stays in scratch) for every later step.

If nobody can answer (a headless or scheduled run), continue in `--report-only` mode with your reconciled config, keep it in scratch, and list every assumption at the top of the report's `summary`. Never execute candidates on an unconfirmed config.

## Step 2: Inventory

Pick a report id: scope plus timestamp, letters, digits, `.`, `_` and `-` only (`shared-20261009-1412`).

```bash
node ${CLAUDE_SKILL_DIR}/scripts/inventory.mjs --scope <scope> [--workspace <root>] [--config <path>] --out <scratch>/tt-inventory-<id>.json
```

It parses the whole root's import graph and prints signals for the scope: grab-bags, tiny files, pass-through barrels, shared files with one consumer, loose files that match a sibling folder, exact and near-duplicate functions, layer violations (with their basis), import cycles, names declared in several files, orphans and unused exports. Run it once and query the JSON afterwards.

## Step 3: Judge each signal

1. Re-read the convention sources from step 1 that cover the scope. They change; don't rely on memory.
2. Read `references/detectors.md` for what each signal means and when it's noise.
3. Open the files behind each signal. A signal becomes a candidate only when you can say what hurts, where the code should go **by this project's conventions**, what backs that, and what the move would touch. Drop the rest.
4. Do the re-implemented-helpers sweep in `references/detectors.md`.
5. Check each candidate for hidden references: mock strings, dynamic imports, docs citing the path, tests that read files by path, `"use client"`/`server-only` boundaries, and the tests and stories that travel with the code. A dry run of `rewrite-imports.mjs` is a fair blast-radius estimate; write those maps as `tt-<id>-draft-<n>.json`, since candidate ids are only fixed after ranking. A `symbols` dry run works before the destination exists and shows the importer rewrites; a `merge` dry run needs the destination prepared first, so use importer counts instead.
6. Shape the list:
   - Batch trivial items with the same destination.
   - Split huge changes, one candidate per destination.
   - Rank by leverage against risk.
   - Keep the best `--candidates`; every other verified finding goes in `deferred` with a one-line reason.
   - List every protected file a candidate touches, even if only an import line changes.

For `full` or several large scopes you may split the reading across parallel read-only subagents, one per area. Give each the inventory path, the config, `references/detectors.md`, `references/architecture.md` and the "How to work" rules, since subagents don't inherit them. Have each return candidates in the report.json shape; you make the final ranking.

## Step 4: Build the report

Write the candidates to `<scratch>/tt-report-<id>.json` in the shape `references/html-report.md` defines, then render and open it:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/build-report.mjs --data <scratch>/tt-report-<id>.json --out <scratch>/tidy-tree-<id>.html --open
```

Fix any validation error it prints and rerun.

## Step 5: Get the decisions

Give the user the report path. They can click **Copy decisions** and paste the JSON into the chat, click **Download decisions.json**, or simply say which candidates to do. For a download, read the newest `tidy-tree-decisions-<id>*.json` in their downloads folder; if you can't find it, ask them to paste it instead.

- `approve` runs in step 6, `later` is reported as deferred, `skip` and `undecided` are dropped.
- Read every comment. A comment that changes a destination or the scope re-runs the destination checklist in `references/architecture.md`; confirm the changed plan before acting.
- With `--resume`, load `<scratch>/tt-report-<reportId>.json` for the plans. If it's gone, rebuild the candidates from a fresh inventory and confirm them first.

With `--report-only`, stop here and summarise. For a candidate big enough to be its own ticket (hundreds of files), suggest the project's planning process instead of executing it here.

## Step 6: Execute the approved candidates

Before the first candidate, check the branch. On a branch the config lists in `git.protectedBranches`, ask the user to create a working branch named the way the project names them, and stop until they do. Then follow `references/execution.md` for each approved candidate, in report order:

1. Check `git status`, take a baseline, re-check the blast radius.
2. Prepare the code by hand where the type needs it.
3. Dry-run, then apply, `scripts/rewrite-imports.mjs`; move tests and stories with the code.
4. Fix everything the script flags for a manual look.
5. Update every doc that cites the old path.
6. Verify with the config's `verify` commands and a final grep for the old path.
7. Hand off and wait for the user before the next candidate.

Stop and report on a verification failure you can't fix within the candidate's scope.

## Step 7: Close

Report a short table of each candidate and its outcome (done, skipped, deferred, failed). If a convention emerged that the project hasn't written down, propose the one-line addition and where it would go (its CLAUDE.md, AGENTS.md or architecture doc), but don't write it unless asked.

## Common mistakes

| Mistake | Instead |
|---|---|
| Proposing feature folders in a layer-first repo, or the reverse | Candidates fix outliers within the existing style |
| Renaming files to your preferred case | Follow the dominant case `discover` measured for that folder |
| Treating an observed layer rule as law | Observed rules are evidence; docs and enforced rules win, and the user confirms |
| Moving framework files (routes, pages, entry points) | They're in `neverMove`; the framework finds them by location |
| Calling a protected file "untouched" when its imports change | List it under `risks` and in the hand-off |
| Batching all candidates into one change | One candidate per reviewable increment |
