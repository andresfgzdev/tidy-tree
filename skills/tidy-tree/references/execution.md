# Execution: carrying out one approved candidate

Execute approved candidates one at a time, in report order unless the user's comments say otherwise. Each candidate ends in a verified, uncommitted working tree that the user reviews and commits. A failed verification stops the run and never rolls into the next candidate.

## Contents

- Before the first candidate
- 1. Check the tree, take the baseline, re-check the size
- 2. Prepare the code
- 3. Rewire with the script
- 4. Fix what the script flags
- 5. Update docs
- 6. Verify
- 7. Hand off
- Recovering from a failed candidate

## Before the first candidate

- **Branch:** if the current branch is in the config's `git.protectedBranches`, ask the user to create a working branch named the way this project names branches (`discover` reports the prefixes and ticket ids it saw), and stop until they have.
- **Git:** never commit, push, stash or `git checkout --` files unless the user asks. The user commits each increment.
- **Comments:** read the user's comment on each approved candidate. A comment can change the destination, keep a re-export, or narrow the scope. If it changes the plan, re-run the destination checklist in `architecture.md` and confirm the new plan before step 2.
- **Worktrees:** in a git worktree with a symlinked `node_modules`, add `node_modules` to `.git/info/exclude` so the symlink doesn't show as untracked.

## 1. Check the tree, take the baseline, re-check the size

- **Tree:** run `git status`. The tree must be clean before the first candidate. Before each later one, it may hold only the previous candidate's files, and only if the user said to continue without committing. Anything else means someone else is editing; stop and ask.
- **Baseline:** run the type check and the related tests from step 6 on the files this candidate will touch. Save the failing test names to `<scratch>/tt-<id>-<candidate>-baseline.txt`. Afterwards compare test names, not counts.
- **Size:**
  - For a `move`, dry-run it now and compare the number of files it would rewrite with the report's evidence.
  - For other types, use the inventory's importer counts.
  - If the change is more than half again bigger than the report said, or touches a protected file the candidate's `risks` don't list, re-confirm with the user before preparing anything.

## 2. Prepare the code

| Type | By hand, before the script |
|---|---|
| `move`, `colocate` | Nothing. The script moves the file. |
| `fold` (whole file into another) | Copy the exports into the destination file and leave the source in place; the script deletes it. |
| `merge-duplicates`, whole file | Same as `fold`: keep one implementation in the destination, preserving every caller's behaviour. |
| `merge-duplicates`, one function inside a larger file | No script operation fits. Edit each caller to import the kept function (renaming at the call site if the names differ), then delete the copy by hand. Use a `symbols` operation only when the name is unchanged. |
| `split` | Create the destination file(s) and move the declarations into them, then delete them from the source. Carry over any imports the moved declarations need. |
| `remove-barrel` | Nothing. Treat it as a `merge` whose destination is the file the barrel re-exports. |
| `delete-dead` | First run `git grep -n '<name>'` across the repo (code, docs, scripts, configs, CI), and stop if anything references it. Then delete the code. |
| `rename` | Rename the declaration and its references, scoped by `git grep -nw '<name>'`. |
| `standard-conflict` | Edit the doc the user picked. No code moves. |

**When a merge changes behaviour:** this covers a new parameter, a different output format, or a different negative-number style. Before merging, get characterization tests that pin each caller's current output. Ideally a subagent that hasn't seen the merged implementation writes them, which avoids confirmation bias. The merge must keep them passing, or change them only where the user approved the new behaviour.

## 3. Rewire with the script

Write the operations to `<scratch>/tt-<id>-<candidate>.json`, then dry-run before applying:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/rewrite-imports.mjs --map <scratch>/tt-<id>-<candidate>.json [--workspace <root>] [--config <path>]
node ${CLAUDE_SKILL_DIR}/scripts/rewrite-imports.mjs --map <scratch>/tt-<id>-<candidate>.json [--workspace <root>] [--config <path>] --apply
```

| Candidate | Operation |
|---|---|
| `move`, `colocate` | `{"op":"move","from":"types/billing-invoice.ts","to":"types/billing/invoice.ts"}` |
| `fold`, whole-file `merge-duplicates`, `remove-barrel` | `{"op":"merge","from":"lib/constants/order-status-labels.ts","to":"lib/constants/order-status.ts"}` |
| `split` | `{"op":"symbols","from":"types/index.ts","to":"types/catalog/product-card.ts","symbols":["ProductCardProps"]}` |

Paths are relative to the root's `src` and must stay inside the root's folder; a file in an included folder outside `src` is written `../scripts/seed.ts`.

**How a map with several operations runs:**
- `--apply` runs the operations in order, re-reading the tree after each one, so later operations see earlier results.
- A dry run previews only the operations that don't depend on an earlier one in the same map, and lists the rest as not previewed.
- So for chained work (move a file, then merge into it), apply the first map, dry-run the next, then apply it.
- If an operation fails during `--apply`, the earlier ones have already been written. Report which, and stop.

**Moving tests and stories:** these travel with the code, following the project's test placement. Add a `move` for a mirrored test (under `__tests__` or a separate test tree) and for any co-located test, story or variants file, in the same map. Leave tests where they are when they're named by behaviour rather than by file.

**What the script does:**
- keeps each importer's style: the same alias prefix, relative stays relative, a `.js` extension stays;
- rewrites jest/vitest mock, `requireActual`/`importActual` and `import()` strings, export-from statements, and config files at the top of the root's folder;
- resolves imports with TypeScript's own module resolver, so `paths`, `baseUrl`, tsconfig `extends` and `references`, `package.json` `#imports` and `.js`-to-`.ts` mapping all count;
- checks that every rewritten specifier resolves to the intended file after the change, tries an explicit `/index` or a relative form if not, and refuses the operation if no form does;
- refuses any operation whose source is `protected`, and moves or merges of a `neverMove` file;
- refuses a `move` or `merge` whose source isn't tracked by git, before writing anything;
- warns about local-looking imports that don't resolve at all, which usually means the tsconfig or config is missing something;
- refuses a `merge` when an importer uses a name the destination doesn't export, or when the source has uncommitted edits;
- refuses a `symbols` op when the source still declares a moved symbol (a compatibility re-export from the destination is allowed);
- merges moved names into an existing import from the destination instead of adding a second import line;
- adds an import back into the source when its remaining code still uses a moved symbol, placed after any `"use client"` directive and in the source file's own alias style;
- uses `git mv` and `git rm`, so history follows the file, and fails loudly rather than falling back to plain file operations.

Read the dry run. If it rewrites far more files than step 1 predicted, stop and re-check the candidate before applying.

## 4. Fix what the script flags

**Needs a manual look:**
- namespace imports (`import * as T from "…"`);
- `export *` barrels that re-exported the moved symbols;
- mock factories: after a merge, a factory replaces the whole destination module, so keep the real exports with `requireActual`/`importActual`. A factory of the destination that drops the real module now stubs out the moved names too;
- a destination that imported its own merge source;
- back-imports that a local of the same name might shadow;
- string literals that look like a hard-coded path to the moved file. These are often guard tests or `fs` reads that `--findRelatedTests` can't see. Paths assembled from split segments (`path.join(SRC, "hooks", "x.ts")`) are only caught by their file name, so also grep the old folder name.

**Moved code's own imports:** a `move` re-bases relative imports automatically. For `split` and `merge`, check the destination compiles on its own.

**Import order:** if lint complains about import order, fix it in the touched files only.

## 5. Update docs

Docs are part of done.

- Fix every doc line the script printed under "docs and agent files citing the old path". The script never edits docs, because a path in prose often needs a sentence rewritten, not just a substitution.
- A convention doc that uses the moved file as its example gets its example updated in the same increment.
- A doc named after a moved file moves with it if the project mirrors code in docs, and any index that lists it changes in the same increment.
- Leave historical records (changelogs, ADRs, dated plans) alone.
- A move that changes a convention updates the doc that owns that convention.

## 6. Verify

Run the config's `verify` commands from `verify.cwd`, replacing `{files}` with the files this candidate touched, relative to that folder. Include the destination and every file the script rewrote, never a deleted source. Then check that nothing still points at the old path:

```bash
git grep -n -F '<old path without extension>' -- . ':(exclude)CHANGELOG.md'
```

Skip that grep for `symbols`, whose source still exists.

- **Baseline comparison:** compare the failing test names with the step 1 baseline. A test failing in both is pre-existing and doesn't block. A new failure blocks.
- **No related tests:** if the runner finds none, say so in the hand-off, since the candidate is then verified by the type check alone.
- **Path-pinning tests:** if `discover` listed guard or structure tests, or the script flagged string paths, run those suites too, whether or not they import the touched files.
- **No verify commands in the config:** ask the user how they type-check and test, and add the answer to the config.

## 7. Hand off

Report the candidate, then stop and wait:

1. What moved, merged or split, and how many files the script rewrote.
2. Protected files whose import lines changed (the script lists them).
3. The verification results, with any failure quoted, and whether related tests existed.
4. The doc files you updated.
5. Git state: `git mv` and `git rm` changes are already staged and the importer edits are not, so the user should review `git status` and stage everything before committing.
6. Suggested commit messages in the project's style (`discover` reports whether it uses conventional commits), keeping code and docs separate if the project does. Include a ticket id only if the user gave one.

Go on to the next approved candidate only after the user says so. Keep each candidate's changes separate, so a reviewer can read one candidate per commit.

## Recovering from a failed candidate

If verification fails and the fix isn't obvious within the candidate's scope, report the failure and every file touched, and ask the user how to proceed. Don't revert anything yourself; list the files so the user can decide. Failures that also fail on the baseline are reported but don't block.
