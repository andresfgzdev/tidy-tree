# Architecture: learning where things belong in this project

tidy-tree never brings its own idea of a good folder layout. It learns the project's layout, writes it down as a config the user confirms, and then flags only what deviates from it.

## Contents

- Where the rules come from, in order of authority
- Reading discover's output
- Reconciling the draft config
- What never moves
- Out of scope for every run
- Destination checklist

## Where the rules come from, in order of authority

| Basis | What it is | Examples | How to cite it |
|---|---|---|---|
| `enforced` | A rule a tool fails the build on | eslint `no-restricted-imports` / `import/no-restricted-paths` / `boundaries`, dependency-cruiser, Nx module boundaries, a guard test | file and rule name |
| `documented` | A convention written down for humans or agents | CLAUDE.md, AGENTS.md, CONTRIBUTING, ARCHITECTURE, ADRs, a standards folder, Cursor/Copilot rules | file and section |
| `observed` | What the code overwhelmingly does today | "`lib/` imports `components/` 4 times, the reverse 212 times"; "92% of hook files are kebab-case" | the numbers |
| `heuristic` | General good practice with nothing in the project behind it | "a types file shouldn't import a React component" | say "no project rule" |

A higher basis wins. When a documented rule and the tree disagree, that's a `standard-conflict` candidate. Surface it and don't pick a side silently. A rule broken by a large share of the files is not a rule the project follows, so don't treat its violations as a queue of moves.

`heuristic` candidates are at most `worth`, never `strong`, and never restructure a folder.

## Reading discover's output

| Field | Use it for |
|---|---|
| `style` (layer-first / feature-first / hybrid) | The shape every destination must keep. In a hybrid, look at where similar files already live. |
| `topFolders`, `featureSubfolders` | The vocabulary of destinations. Prefer an existing folder. |
| `naming` | The case a new or moved file takes in that folder. Entries show a subfolder only when it differs from its parent. |
| `testPlacement` | Whether tests travel next to the code, live in `__tests__`, or sit in a separate tree. |
| `barrels` | Whether folders here expose an `index` file. Don't add or remove barrels against the grain. |
| `imports` | Alias vs relative, which alias prefixes, whether specifiers carry `.js`. The rewrite script keeps each importer's style on its own. |
| `dependencyDirection`, `proposedLayers` | Which folders depend on which. Proposed rules are evidence, not law. |
| `conventions.docs`, `conventions.enforced` | What to read before judging anything. |
| `conventions.guardTests` | Tests that probably pin file paths. Run them after any move. |
| `git` | Protected branches, branch naming, commit style for the hand-off. |
| `outOfReach` | Workspaces in other languages. Say they weren't analysed. |

## Reconciling the draft config

`discover.mjs --config-out` writes a draft. Before using it:

1. **Presets** (`extends`): check the framework guess. Two presets are fine (a Next app with both `app/` and `pages/`). With no preset, fill `entryPoints` and `neverMove` by hand for anything the framework loads by file location.
2. **Layers:** keep the observed rules a doc confirms, mark them `documented` with a `source`, and drop the ones a doc contradicts. Add enforced rules with `basis: "enforced"`. Use `exceptFrom`/`exceptTo` for exceptions the docs grant.
3. **sharedRoots:** the folders that hold code meant for reuse across the project. They feed the default `shared` scope and the single-consumer signal. Leave empty if the project has none.
4. **areaRoots:** folders whose children are separate features or domains (`features/*`, `modules/*`, `app/api/*`). Areas drive the "who imports this" bars.
5. **protected / neverMove:** ask the user. `protected` files keep their contents and location, but their import lines may still be rewritten. `neverMove` files may change but stay where they are.
6. **verify:** check the commands run from `verify.cwd`. `{files}` is replaced with the touched files, relative to that folder.

See `references/config.md` for every field.

## What never moves

- Files the framework finds by location (`neverMove`, mostly from presets): Next.js route files, React Router route modules, entry files.
- `protected` files the user named.
- Vendored or generated code (shadcn primitives, codegen output, `*.generated.*`), unless the user says otherwise.
- Public package entry points (`package.json` `main`, `exports`, `bin`). `discover` adds them to `entryPoints`, and their exports are public API, not dead code.
- Legacy names are not a reason to move a file. Rename only as part of a move that has another reason.

## Out of scope for every run

- `node_modules`, build output, generated files, other languages' workspaces.
- Test files as subjects. Tests and stories move with the code they belong to (`execution.md` step 3), but a test's own location is never a candidate.
- Crossing a workspace boundary. One run works inside one root.

## Destination checklist

For each proposed destination, confirm:

1. **Shape:** it keeps the project's organisation style. No new feature folder in a layer-first app, and no new kind folder inside a feature-first app's feature, unless that feature already has them.
2. **Folder:** it already exists, or a documented convention prescribes it. Prefer an existing subfolder over a new one, and a new subfolder over a new top-level folder.
3. **No convention covers it:** when the docs name some folders but not the kind of code you're placing (pure domain logic in a feature that only documents `components/` and `hooks/`), follow the nearest precedent in the tree and cite it. If there's no precedent, say so in the candidate's `risks` and let the user choose.
4. **Name:** the file name follows its new siblings (case, `index.ts` vs named files, suffixes like `.service.ts` or `.hooks.ts`).
5. **Layers:** the destination's layer may import everything the moved code imports, under the config's `layers`.
6. **Cycles:** the move doesn't create an import cycle. If source and destination would import each other, choose a third place or don't move.
7. **Docs:** every doc citing the old path is listed for update (`rewrite-imports.mjs` prints them).
