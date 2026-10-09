# tidy-tree.config.json

The config describes how one repository is organised. `discover.mjs` drafts it, and the user confirms it. The scripts look for `tidy-tree.config.json` or `.tidy-tree.json` at the repository root, or take `--config <file>`.

**Paths:**
- Globs inside a root (`layers`, `sharedRoots`, `areaRoots`, `entryPoints`, `neverMove`, `protected`, `scopes`, `exclude`, `tests`) are relative to that root's `src`. A plain folder (no `*`) also matches everything below it.
- Paths outside `src` start with `../` (`../scripts/**`).
- `docs` and `standards` are relative to the repository root.

**Where rules can go:** every per-root field can be set at the top level, which applies to all roots, or inside a root, which adds to the top level. Arrays concatenate, objects merge, and scalars from the root win.

```jsonc
{
  "extends": ["next-app-router"],          // built-in presets, or relative paths to JSON files
  "roots": [
    {
      "name": "web",                       // --workspace <name>; required when there are several roots
      "extends": ["next-app-router"],      // presets for this root only
      "dir": "apps/web",                   // package folder, relative to the repo
      "src": "src",                        // source folder, relative to dir ("." when there is none)
      "tsconfig": "tsconfig.json",         // relative to dir; found automatically when omitted
      "include": ["tests", "scripts"],     // extra folders under dir that import the code
      "rootFiles": true,                   // rewrite config files at the top of dir (next.config.ts, vite.config.ts)
      "verify": {
        "cwd": "apps/web",
        "typecheck": "pnpm exec tsc -p tsconfig.json --noEmit",
        "lint": "pnpm exec eslint {files}",
        "relatedTests": "pnpm exec vitest related --run --passWithNoTests {files}"
      }
    }
  ],
  "sharedRoots": ["shared", "lib/utils"],  // the "shared" scope, and the single-consumer signal
  "areaRoots": ["features/*"],             // folders whose children are separate areas
  "areaDepth": 2,                          // otherwise an area is the first N folders of the path
  "scopes": { "ui": ["components", "hooks"] },
  "layers": [
    {
      "from": "lib/**", "to": "components/**", // a glob or an array of globs
      "basis": "documented",               // enforced | documented | observed | heuristic
      "source": "docs/architecture.md#layers",
      "why": "lib is framework-free",
      "exceptFrom": [], "exceptTo": ["components/icons/**"],
      "allowTypeOnly": false               // true: type-only use across the boundary is fine (an `import type`, or names used only in type positions)
    }
  ],
  "entryPoints": ["main.tsx"],             // loaded by convention: never orphans, exports not "unused"
  "neverMove": ["main.tsx"],               // the scripts refuse to move or merge these
  "protected": ["lib/billing/ledger.ts"],// contents and location fixed; import lines may change
  "frameworkExports": ["loader"],          // export names the framework reads (ignored by same-name checks)
  "tests": ["**/*.test.ts"],               // added to the default test globs
  "exclude": ["generated/**"],             // never scanned
  "docs": ["docs", ":(glob)**/README.md"], // git pathspecs searched for the old path after a move
  "standards": ["CLAUDE.md", "docs/architecture.md"],
  "git": { "protectedBranches": ["main"], "commits": "user" },
  "thresholds": { "tiny": 6, "grabExports": 15, "grabLines": 300, "dupLines": 5, "nearLines": 10, "nearSim": 0.8 }
}
```

## Presets

| Preset | Adds |
|---|---|
| `next-app-router` | route files under `app/` and `middleware`/`instrumentation`/`proxy` as entry points that never move; route handler and metadata exports; `app/*` and `app/api/*` areas |
| `next-pages` | everything under `pages/`, data-fetching exports |
| `react-router` | `routes/**`, `root`, `entry.client`/`entry.server`, `routes.ts`; loader/action/meta exports (Remix v2 and React Router framework mode, with `src` set to `app`) |
| `vite` | `main.*` entry |
| `node` | `index`/`main`/`server`/`app`/`cli` entries and `bin/**` |

Route groups such as `app/(shop)/cart` are dropped when naming areas, so that file's area is `app/cart`.

## Default test globs

`**/__tests__/**`, `**/__mocks__/**`, `**/*.{test,spec}.*`, and the folders `test`, `tests`, `spec`, `e2e`, `cypress`, `playwright` and `__tests__` beside `src` (`../test/**` and so on). When a root's `src` is the root folder itself, `test/**`, `tests/**`, `spec/**`, `e2e/**` and `cypress/**` count as tests too. Test files never decide placement, and their importers don't count as consumers.

## Files the scripts see

Source files are listed with `git ls-files` (tracked plus untracked, minus gitignored), so build output and `node_modules` stay out while folders named `build`, `out` or `.server` inside `src` are still scanned. Outside a git repository the scripts walk the folder instead. Imports are resolved with TypeScript's module resolver using the root's tsconfig, following `references` when the tsconfig is a solution file. `discover` lists every sibling folder of `src` that holds sources in `include`.

## Default scope

`shared` reads `sharedRoots`. When the config has none, the inventory says so and scans the whole root instead.
