# Changelog

## 0.1.1

- Fix alias specifiers on Windows: moving `x.ts` to `x/index.ts` rewrote `@/x` to `@/x/index` because the index suffix was only stripped from POSIX paths.
- Run the test suite on Windows in CI, and add a screenshot of the review to the README.

## 0.1.0

First public release.

- `discover.mjs` reads a repository's existing architecture (organisation style, naming, test placement, barrels, import style, dependency direction, convention docs, lint boundaries, git conventions) and drafts `tidy-tree.config.json`.
- `inventory.mjs` reports grab-bags, tiny fragments, single-consumer shared files, loose files, exact and near-duplicate functions, layer violations with their basis, import cycles, duplicate names, orphans and unused exports.
- `build-report.mjs` renders an interactive HTML review with before/after trees and approve/later/skip decisions.
- `rewrite-imports.mjs` moves, merges and splits modules and rewires every importer, keeping alias prefixes and `.js` extensions, and flags mock factories, hard-coded path strings and docs that need a manual look.
- Presets for Next.js (app and pages routers), React Router / Remix, Vite and Node, per root or for the whole repo.
- Imports are resolved with TypeScript's own module resolver (`paths`, `baseUrl`, `extends`, solution-style `references`, `package.json` `#imports`, NodeNext `.js`), and every rewritten specifier is checked to resolve to the intended file before anything is written.
- Type-only detection by usage: names imported without `type` but used only in type positions don't count as runtime layer crossings or cycles.
- Files are listed with `git ls-files`, so gitignored output stays out while source folders named `build`, `out` or `.server` are still scanned.
