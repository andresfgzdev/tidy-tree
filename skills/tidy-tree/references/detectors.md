# Detectors: what each inventory signal means

`scripts/inventory.mjs` reports signals, not verdicts. Each section below says what a signal measures, when it is a real problem, when it is noise, and which candidate type it usually becomes. Open the files before deciding. Drop any signal you can't justify after reading the code; don't report it.

Judge every signal against the project's own conventions (`references/architecture.md`). "Noise" includes anything the project does on purpose.

## Contents

- Grab-bag files
- Tiny files
- Shared files with a single consumer area
- Loose files matching a sibling folder
- Duplicate function bodies
- Near-duplicate functions
- Layer violations
- Import cycles
- Re-implemented helpers (manual sweep)
- Same exported name in several files
- Pass-through barrels
- Orphan files and unused exports
- Standard conflicts
- Areas

## Grab-bag files

**Measures:** a non-barrel file flagged for one of two reasons:
- `size`: at least 15 exports, or 300 non-blank, non-comment lines with at least 4 exports (`thresholds.grabExports`, `thresholds.grabLines`). A long file with one or two exports is a single component or service, not a grab-bag;
- `mixed-consumers`: a file under `sharedRoots` with at least 4 exports (`thresholds.mixedExports`), where exports used by only one area serve two or more different areas. A small `shared/utils.ts` mixing cart-only and checkout-only code is the typical case.

For each export the inventory lists which areas import it (`perExport[].areas`), and it groups exports by their dominant consumer area (`proposedGroups`). An `unused` group can include exports used only inside the file itself, so check before calling them dead.

**Real when:** the groups are distinct domains imported by different parts of the app. `types/index.ts`, `utils.ts` and `constants.ts` are the usual cases. One file every feature imports means every change to one domain touches a file all the others depend on, and nobody can tell which declarations belong together.

**Noise when:**
- the file is one cohesive domain that is simply large, such as a data model, one feature's column config or a generated client. Size alone is a different conversation.
- the exports are a deliberate family, such as UI primitives or a component with its variants.
- the project deliberately keeps one types or constants file (documented, or the observed convention across many packages).

**Becomes:** `split`. Propose target files from `proposedGroups`, named by domain noun and placed where the project keeps that domain's code: next to the feature in a feature-first app, under a domain subfolder of the kind folder in a layer-first one. Groups of 1 or 2 usually join a neighbouring group. The `unused` group goes to `delete-dead` after the checks below. One candidate per destination file is fine; a 60-export file is rarely one safe step.

## Tiny files

**Measures:** a file with at most 6 non-comment, non-blank lines that isn't a barrel or an entry point.

Small is not a problem on its own. Many projects keep one concept per file on purpose. A one-line file that owns one concept is fine.

**Real when:** the file is a fragment of a concept that already has a home, for example:
- a values array in one folder and the type derived from it re-declared by hand somewhere else;
- a label map split off from the enum it labels;
- a default that only makes sense next to the list it filters.

**Noise when:**
- it is the single home of one concept;
- it exists to break an import cycle, or to keep a server-only or client-only boundary (`"use client"`, `server-only`);
- it must stay dependency-free because a config file, a worker or a guard test imports it;
- it is a public entry point named in a doc or `package.json`.

**Becomes:** `fold` into the file that owns the concept. Batch fragments from the same folder that go to the same destination into one candidate. Don't create a new file to fold fragments into unless the owning file genuinely doesn't exist.

## Shared files with a single consumer area

**Measures:** a file under one of the config's `sharedRoots` whose production importers all sit in one area that isn't the file's own.

**Real when:** the code is genuinely specific to that area, such as a login-only message map in a shared constants folder.

**Noise when:**
- the code is generic and only has one consumer so far, such as a formatter or a design-system component. Shared folders are for things meant for reuse, and moving them would hide them from the next person who searches there.
- the project's convention puts that kind of file in the shared folder whatever its consumer count.

**In layer-first repos this signal is mostly noise:** when the docs place a file by kind ("non-React helpers go in `lib/utils/`") rather than by consumer count, a helper with one consumer is still in the right place. Skim the list for domain-specific names only.

**A documented rule beats this noise list.** If the docs say the shared folder is only for code used by two or more areas, a single-consumer file there is a real finding, even a generic one. If applying that rule literally would scatter many small generic helpers, raise one `standard-conflict` candidate that asks which way the project wants it, rather than many `colocate` candidates.

**Becomes:** `colocate`: next to the consumer, or into the consumer's area, following how that area already organises its files.

## Loose files matching a sibling folder

**Measures:** a file in a folder that has subfolders, where the file name matches a subfolder name (`types/billing-invoice.ts` beside `types/billing/`).

**Real when:** the subfolder already holds the same domain's code, and the loose file splits that domain in two.

**Noise when:**
- the match is lexical only (`navigation.ts` next to a `nav-*` folder for a different concept);
- the project's convention allows a top-level domain file beside domain folders.

**Becomes:** `move`. Keep the file name unless the destination's siblings follow a different pattern (`index.ts` vs named files). If a doc uses the file as its example, the candidate updates that example too.

## Duplicate function bodies

**Measures:** two or more functions of at least 5 lines in different files whose bodies match token for token, ignoring whitespace and comments (`exact`). A `renamed` match is identical once every identifier is anonymised, including callee and property names, so it is noisier: two bodies that call different functions in the same shape also match.

**Real when:**
- `exact` matches. Two copies will drift: one fix lands and the other keeps the bug.
- `renamed` matches that do the same job under different names.

**Noise when:** the shape is framework boilerplate. Two data-fetching hooks that call different endpoints share a shape because the hook API has one shape, and so do route handlers built from shared helpers. Merge only when the bodies differ by values that could be parameters, and the merged function would still read clearly.

**Becomes:** `merge-duplicates`. Keep the copy in the more canonical location (the project's shared or utility folder over a feature file), and make the other call sites import it. If the bodies differ by one branch, the merged version takes a parameter. A function-level merge inside a larger file is done by hand, not by the script's `merge` operation (see `execution.md` step 2).

## Near-duplicate functions

**Measures:** functions of at least 10 lines in different files whose token shingles overlap by 80% or more once identifiers are anonymised. Groups are transitive, so five files with the same helper show up as one group.

**Real when:** the copies differ by a sort key, a field, one query stage or one column, which means a function was copied to change one detail.

**Noise when:** the shared part is framework shape. Open two members and diff them; if the difference is the domain logic, leave them.

**Becomes:** `merge-duplicates` with one parameterised function in the family's shared location. Put the two most different members side by side in `code` so the reviewer sees what the parameters must cover.

## Layer violations

**Measures:** imports that break one of the config's `layers` rules. Each violation carries the rule's `basis` (enforced, documented, observed, heuristic), its `source` and its `why`. An import counts as type-only when it says `import type`, or when every name it brings in is used only in type positions (`typeof x`, annotations, `implements`); those disappear at runtime, and import cycles ignore them too.

**Real when:** a runtime import pulls one layer's code into another that must not depend on it, such as UI code imported into a server module, or a types module importing a route.

**Noise when:**
- the import is `import type` of a shape that genuinely belongs to the imported layer. It's still worth a lower-strength `move` of the type to where both sides may import it.
- the docs grant an exception that the config doesn't list yet. Add it to `exceptFrom`/`exceptTo` and drop the signal.

**Many violations of one rule are a standard conflict.** When a rule is broken by many files, the project doesn't actually follow it. Raise a `standard-conflict` candidate that names the options (a scoped exception, or moving the shared module), and don't queue a dozen moves.

**Becomes:** `move` or `split`. Move the shared piece down to a layer both sides may import, or move the misplaced file up to where its consumers live.

## Import cycles

**Measures:** strongly connected groups in the runtime import graph that include a scoped file. Test files, mock strings and type-only imports are excluded, because they don't create load-order problems.

**Real when:** a barrel re-exports a folder whose files import the barrel back, or two domains import each other. Cycles make load order fragile, defeat tree-shaking, and are often why someone kept a duplicate "to avoid the loop".

**Becomes:** usually part of a `split` or `move`: name the cycle in `risks` and make sure the destination breaks it. A very large cycle (dozens of files through one config module) is its own candidate. Find the one edge that closes it, often a config file that imports UI components, and propose moving that edge.

## Re-implemented helpers (manual sweep)

The inventory can't see code that re-implements an existing helper in a different shape. After reading the conventions, sweep for it on purpose; it is the duplication reviewers miss most.

- **Helper catalogs:** if the docs list shared helpers, `git grep` for each helper's behaviour, not its name. Typical finds: hand-rolled request-body parsing beside a parser helper, `Intl.NumberFormat` currency formatting beside a formatter module, `toISOString().slice(0, 10)` beside date helpers, ad-hoc retry loops beside a retry utility.
- **Lists that belong in one place:** permission or role lists, feature-flag names, route paths, status enums written out again in several files. Check the docs first: some copies are deliberate.
- **Magic values defined several times:** constants such as `MS_PER_DAY`, page sizes or cache times written inline in several files.

Note: `git grep -E` has no `\b`. Use `-P` or `-w` for word boundaries, or a "no results" check proves nothing.

Each hit becomes `merge-duplicates` pointing callers at the existing helper. If the copies behave differently (one prints `$-5`, another `-$5`), say so in `risks`, because unifying them changes visible output.

## Same exported name in several files

**Measures:** the same exported identifier declared in two or more files. `identical` ("same text" in the summary) means the declarations match textually apart from the name; they can still differ in meaning when they refer to different types of the same name, so open both. Framework export names (`frameworkExports`) in entry-point files are ignored.

**Real when:**
- `identical` type or interface pairs, often one copy next to a data model and one in a types folder. Pick the owner, and have the other import or re-export it.
- two different shapes under the same name, both imported in one area: a bug waiting to happen.

**Noise when:** a component and its props type share a stem. That's a naming smell worth a `rename` only if both are imported together somewhere.

**Becomes:** `merge-duplicates` (identical) or `rename` (different shapes, same name).

## Pass-through barrels

**Measures:** an `index` file that only re-exports, flagged `passThrough` when it re-exports at most 2 names.

**Real when:** the barrel adds an import path without grouping anything, and the project doesn't otherwise use barrels there.

**Noise when:** the project uses barrels as public entries (check `discover`'s barrel share and the docs), or the folder is a component-as-folder pattern.

**Becomes:** `remove-barrel`, only when no convention calls for it.

## Orphan files and unused exports

**Measures:** files nothing imports, and exports no importer names. Entry points from the config and presets are skipped.

**Real when:** you have checked that:
- `git grep` finds no string reference: dynamic imports with computed paths, config files, Storybook or test globs, scripts run by `package.json`, CI workflows;
- it isn't loaded by convention: framework files the presets don't cover, test setup files, workers, service workers, CLI entries;
- for an unused export, the file doesn't use it internally. An export used only in its own file means dropping the `export` keyword, not deleting the declaration;
- for a library, it isn't public API reachable from `package.json` `exports`.

**Becomes:** `delete-dead`. Keep these candidates small and evidence-heavy, because deletion is the change reviewers trust least.

## Standard conflicts

**Measures:** nothing automatic. You find these while reading the conventions against the tree: one doc says one thing while the tree, or another doc, says another.

**Becomes:** `standard-conflict`. The candidate proposes which side wins and the exact doc edit. Never "fix" the tree to match a doc that the rest of the repo contradicts without surfacing it first.

## Areas

The inventory names areas so you can tell at a glance who uses a file:

- **`areaRoots` match:** a file under a folder matching one of the config's `areaRoots` belongs to that folder (`features/cart`, `app/api/orders`).
- **Otherwise:** its first `areaDepth` folders (default 2), such as `components/ui` or `lib/db`.
- **Route groups:** parenthesised segments such as `(shop)` are dropped.
- **Tests and other folders:** test files are `tests`, and files outside `src` are named by their folder (`../scripts`). Test importers never decide placement.
