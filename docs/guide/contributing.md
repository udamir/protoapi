# Contributing

The project uses [Bun](https://bun.sh) for installing, testing and running scripts, [Biome](https://biomejs.dev) for formatting and linting, TypeScript and esbuild. The development tools need the buf CLI, which is a devDependency (`@bufbuild/buf`).

```sh
bun install
bun test                    # all tests
bun run typecheck           # tsc --noEmit
bun run check               # biome: format check and lint
bun run build               # dist/ (ESM, CommonJS, declarations) and browser/ (minified IIFEs)
bun run test:dist           # smoke tests of both entries (CommonJS and ESM) after the build
bun run docs:dev            # start this documentation site locally
bun run docs:build          # build the documentation site
```

Tools for the conformance corpus and the bundle:

```sh
bun scripts/images.ts       # regenerate buf images for the conformance fixtures and the bundle
bun scripts/case-images.ts  # record buf's verdict on the inline test cases (test/cases/*.ts)
bun scripts/print-check.ts  # check that the printed text of every round-trip input passes buf build
bun scripts/comment-fuzz.ts check 2000  # differential comment fuzz against buf
bun scripts/fetch-corpus.ts && bun scripts/fetch-breaking.ts  # googleapis samples, buf's breaking test corpus
bun scripts/fetch-bundle.ts && bun scripts/gen-bundle.ts      # update the bundled definitions
bun bench/bench.ts --descriptor                               # performance
```

## Project layout

| Path | Contents |
| --- | --- |
| `src/` | The library: the document types (`types.ts`), the `.proto` parser (`parser/`, derived from pbkit), the text front end (`text.ts`, `symbols.ts`, `resolve.ts`, `features.ts`, `values.ts`, `options.ts`, `validate.ts`), the descriptor front end (`descriptor.ts`, `binary.ts`), the shared model (`model.ts`) and its lowering into the document (`lower.ts`, `annotate.ts`, `comments.ts`), the printer (`print.ts`), source-map lookups (`locate.ts`), and the entries `index.ts` and `core.ts`. |
| `src/bundle/` | Generated: the bundled `.proto` sources and the edition defaults. |
| `bundle/` | The pinned `.proto` sources, their versions and licences. |
| `test/` | Bun test suites by concern (front end, resolution, values, features, annotations, imports, validation, positions, round trip, conformance against buf images, robustness, performance), the fixtures and the buf images they are checked against. |
| `docs/` | This VitePress site, with the specification, the conversion examples and the online demo. |

## The documentation site

The [conversion examples](/examples/) are defined in `docs/.vitepress/theme/cases.ts`. At build time every example is built with the current sources, printed back, built again, and compiled with buf; the badges of the examples page report the results. To add an example, add a case there and a section to `docs/examples/index.md`; the online demo offers it as a preset automatically.

## Pull requests

Please run the tests, the type check and Biome before submitting a pull request, and include tests that show your change. Changes to the document format also need an update to the [specification](/spec/v0.1) and to `CHANGELOG.md`.
