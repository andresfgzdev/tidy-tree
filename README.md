# tidy-tree

An agent skill that finds and fixes **where code lives** in JavaScript and TypeScript repositories, by **your project's own architecture**, not someone else's.

It looks for:
- grab-bag files (`types/index.ts`, `utils.ts`, `constants.ts`) that every feature imports;
- fragment files that split one concept in two;
- "shared" files only one feature uses;
- loose files that belong in a sibling folder;
- exact and near-duplicate functions and types;
- imports that cross your layers;
- import cycles and dead exports.

It shows what it found in an interactive HTML review with before/after folder trees. You approve, defer or skip each candidate. Then it carries out only what you approved, one reviewable increment at a time, with every import rewired and the result type-checked, linted and tested.

## Your architecture is the standard

tidy-tree brings no folder layout of its own. Before proposing anything, it learns how the repository is already organised and writes that down as a config you confirm:

- **shape:** layer-first (`components/`, `hooks/`, `lib/`), feature-first (`features/cart/…`) or hybrid;
- **naming:** the file-name case per folder;
- **tests:** co-located, in `__tests__`, or in a separate tree;
- **barrels and imports:** whether folders expose `index` files, aliases vs relative paths, `.js` extensions;
- **dependency direction:** which folders import which, so rules nobody wrote down still show up ("`lib/` imports `components/` 4 times, the reverse 212 times");
- **written and enforced rules:** CLAUDE.md, AGENTS.md, CONTRIBUTING, ARCHITECTURE, ADRs, Cursor/Copilot rules, eslint boundary rules, dependency-cruiser;
- **git habits:** protected branches, branch naming, commit style.

Every candidate says what backs it: an **enforced** rule, a **documented** convention, an **observed** convention (with the numbers), or a mere **heuristic**. A candidate fixes an outlier from your conventions. It never migrates you to different ones.

## Install

**Claude Code (plugin):**

```text
/plugin marketplace add andresfgzdev/tidy-tree
/plugin install tidy-tree@tidy-tree
```

**Any agent that reads Agent Skills** (Claude Code, Codex, Cursor, Copilot and others) via the [`skills`](https://github.com/vercel-labs/skills) CLI:

```bash
npx skills add andresfgzdev/tidy-tree
```

**By hand:** copy `skills/tidy-tree/` into your agent's skills folder (for Claude Code, `~/.claude/skills/tidy-tree/` or `.claude/skills/tidy-tree/` in a repo).

## Use

Ask in plain words, for example "our `utils` folder is a mess, tidy it", "find duplicated helpers", or "where should this hook live?". In Claude Code you can also run it directly:

```text
/tidy-tree:tidy-tree                 # the shared folders from your config
/tidy-tree:tidy-tree full            # everything
/tidy-tree:tidy-tree src/features/cart --report-only
/tidy-tree:tidy-tree types --workspace web
```

A run goes:

1. **Understand the architecture.** `discover` drafts `tidy-tree.config.json` from what it observes and from your docs. You confirm or correct it, and choose whether to keep it in the repo.
2. **Inventory.** It parses the whole import graph and reports signals for the scope.
3. **Judge.** The agent reads the code behind each signal and keeps only real, justified candidates.
4. **Review.** It renders an HTML report with before/after trees, who-imports-what bars, side-by-side duplicates and approve/later/skip buttons.
5. **Execute.** It applies each approved candidate: dry run, apply, fix what was flagged, update docs, verify, hand off. It never commits; you review and commit each increment.

## Requirements and limits

- Node.js 20 or later, git, and `typescript` installed in the repository being analysed. The scripts load it from there, so tidy-tree itself has no runtime dependencies.
- Imports are resolved with TypeScript's own module resolver, so `paths`, `baseUrl`, tsconfig `extends` and `references`, `package.json` `#imports` and NodeNext `.js` specifiers all work. Every rewritten import is checked to point at the intended file before anything is written.
- **JS and TS only.** `.vue`, `.svelte` and `.astro` files are invisible to the import graph, and other languages' workspaces are listed as out of reach.
- One root (workspace) per run. Monorepos are supported, but moves never cross a package boundary.
- Tested on macOS and Linux. Windows paths should work but are untested.

## Known limitations

- **Noisy signals in layer-first repos.** "Shared file with a single consumer" and "unused exports" (vendored UI kits export whole families) produce many signals the agent then drops. The report only carries what survives, but expect the judging step to take most of the run's time.
- **Framework boilerplate looks duplicated.** Data-fetching hooks built on the same library can match as duplicates; the detector guidance tells the agent to drop them.
- **Type-only cycles are ignored.** A cycle that exists only through types is harmless at runtime, so it isn't reported, even when it hints at a misplaced type.

## The scripts

All live in `skills/tidy-tree/scripts/`, run with plain `node`, and print `--help`.

| Script | Does |
|---|---|
| `discover.mjs` | Describes the current architecture and drafts the config. Read-only. |
| `inventory.mjs` | Placement, fan-in, duplication, layer, cycle and dead-code signals. Read-only. |
| `build-report.mjs` | Validates report JSON and renders the interactive review. |
| `rewrite-imports.mjs` | `move`, `merge` and `symbols` operations with every importer rewired. Dry run unless `--apply`. |

`skills/tidy-tree/references/config.md` documents every config field and preset.

## Develop

```bash
npm install
npm test
```

The tests build throwaway git repositories in your temp folder and never touch this checkout.

## License

[MIT](LICENSE)
