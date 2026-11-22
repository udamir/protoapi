# Contributing

The project uses [pnpm](https://pnpm.io), [Vite+](https://viteplus.dev) (`vp`: Vitest, Oxlint, Oxfmt and tsdown in one toolchain) and TypeScript 7. Node.js 22.18 or later is required for development: the scripts in `scripts/` and `bench/` are TypeScript that Node runs directly. The development tools need the buf CLI, which is a devDependency (`@bufbuild/buf`).

```sh
pnpm install
pnpm test                   # all tests, one file at a time (vp test run)
pnpm typecheck              # type-check with the TypeScript 7 compiler
pnpm check                  # format check, lint and type-aware checks (vp check)
pnpm build                  # dist/ (ESM, CommonJS, declarations) and browser/ (minified IIFEs) with vp pack
pnpm test:dist              # smoke tests of both entries (CommonJS and ESM) after the build
pnpm docs:dev               # start this documentation site locally
pnpm docs:build             # build the documentation site
```

Run `pnpm exec vp check --fix` to format the code and apply safe lint fixes before committing. Relative imports carry their `.ts` extension and type-only imports are marked `import type`, so that Node can run the sources without a build step.

Tools for the conformance corpus and the bundle:

```sh
pnpm images                             # regenerate buf images for the conformance fixtures and the bundle
node scripts/case-images.ts             # record buf's verdict on the inline test cases (test/cases/*.ts)
node scripts/print-check.ts             # check that the printed text of every round-trip input passes buf build
node scripts/comment-fuzz.ts check 2000 # differential comment fuzz against buf
node scripts/fetch-corpus.ts && node scripts/fetch-breaking.ts  # googleapis samples, buf's breaking test corpus
pnpm bundle:fetch && pnpm bundle:gen                            # update the bundled definitions
node bench/bench.ts --descriptor                                # performance
```

## Project layout

| Path          | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`        | The library: the document types (`types.ts`), the `.proto` parser (`parser/`, derived from pbkit), the text front end (`text.ts`, `symbols.ts`, `resolve.ts`, `features.ts`, `values.ts`, `options.ts`, `validate.ts`), the descriptor front end (`descriptor.ts`, `binary.ts`), the shared model (`model.ts`) and its lowering into the document (`lower.ts`, `annotate.ts`, `comments.ts`), the printer (`print.ts`), source-map lookups (`locate.ts`), and the entries `index.ts` and `core.ts`. |
| `src/bundle/` | Generated: the bundled `.proto` sources and the edition defaults.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `bundle/`     | The pinned `.proto` sources, their versions and licences.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `test/`       | Vitest suites by concern (front end, resolution, values, features, annotations, imports, validation, positions, round trip, conformance against buf images, robustness, performance), the fixtures and the buf images they are checked against.                                                                                                                                                                                                                                                     |
| `docs/`       | This VitePress site, with the specification, the conversion examples and the online demo.                                                                                                                                                                                                                                                                                                                                                                                                           |

## The documentation site

The [conversion examples](/examples/) are defined in `docs/.vitepress/theme/cases.ts`. At build time every example is built with the current sources, printed back, built again, and compiled with buf; the badges of the examples page report the results. To add an example, add a case there and a section to `docs/examples/index.md`; the online demo offers it as a preset automatically.

## Pull requests

Please run the tests, the type check and `vp check` before submitting a pull request, and include tests that show your change. Changes to the document format also need an update to the [specification](/spec/v0.1) and to `CHANGELOG.md`.
