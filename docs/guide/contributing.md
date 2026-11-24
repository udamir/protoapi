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
node bench/budgets.ts [--write]                                 # performance budgets on Node: min / median / max per row, bench/results/node.md
node bench/bench.ts --descriptor                                # timings per corpus size
```

## Project layout

| Path                                       | Contents                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`                                     | The entries `index.ts` and `core.ts` over the API in `api.ts`, the public types (`types.ts`, split in `types/`), the builders (`build.ts`, `binary.ts`), the symbol table and linking (`symbols.ts`, `resolve.ts`), editions feature resolution (`features.ts`), the annotation layer (`annotate.ts`, `comments.ts`) and source-map lookups (`locate.ts`). |
| `src/parser/`                              | The `.proto` and text-format parser, derived from pbkit (see its `NOTICE`).                                                                                                                                                                                                                                                                                |
| `src/frontend/`                            | The two front ends into the shared model of `src/model/`: `.proto` text (`text/`) and FileDescriptorSet JSON (`descriptor/`); binary sets are decoded in `src/binary/`.                                                                                                                                                                                    |
| `src/options/`                             | Option interpretation shared by both front ends: text-format and ProtoJSON values, well-known types, presence, key order and defaults.                                                                                                                                                                                                                     |
| `src/conventions/`                         | The annotation conventions (google.api, protovalidate and PGV rules, openapiv2, comment tags, AIP prefixes), each with its build and print direction.                                                                                                                                                                                                      |
| `src/lower/`, `src/validate/`              | The lowering of the model into the document and its source map; the definition checks of the text producer.                                                                                                                                                                                                                                                |
| `src/print/`                               | The printer: document to `.proto` text.                                                                                                                                                                                                                                                                                                                    |
| `src/build/`, `src/common/`, `src/values/` | Build steps (argument checks, bundle cache, import closure, pipeline) and shared helpers (limits, editions, names, canonical values, scalars, literals).                                                                                                                                                                                                   |
| `src/bundle/`                              | Generated: the bundled `.proto` sources and the edition defaults.                                                                                                                                                                                                                                                                                          |
| `bundle/`                                  | The pinned `.proto` sources, their versions and licences.                                                                                                                                                                                                                                                                                                  |
| `test/`                                    | Vitest suites by concern (front end, resolution, values, features, annotations, imports, validation, positions, round trip, conformance against buf images, robustness, performance), the fixtures and the buf images they are checked against.                                                                                                            |
| `docs/`                                    | This VitePress site, with the specification, the conversion examples and the online demo.                                                                                                                                                                                                                                                                  |

## The documentation site

The [conversion examples](/examples/) are defined in `docs/.vitepress/theme/cases.ts`. At build time every example is built with the current sources, printed back, built again, and compiled with buf; the badges of the examples page report the results. To add an example, add a case there and a section to `docs/examples/index.md`; the online demo offers it as a preset automatically.

## Pull requests

Please run the tests, the type check and `vp check` before submitting a pull request, and include tests that show your change. Changes to the document format also need an update to the [specification](/spec/v0.1) and to `CHANGELOG.md`.
