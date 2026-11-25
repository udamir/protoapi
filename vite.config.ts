import { defineConfig } from "vite-plus"

// generated files and test data: their exact text is compared with build and print results
const GENERATED = [
  "dist/**",
  "browser/**",
  "coverage/**",
  ".tmp/**",
  "src/bundle/sources.ts",
  "src/bundle/core-sources.ts",
  "src/bundle/features.ts",
  "test/fixtures/**",
  "test/images/**",
  "docs/.vitepress/cache/**",
  "docs/.vitepress/dist/**",
]

const external = { neverBundle: [/^@bufbuild\/protobuf/] }

// the configurations build in parallel, so none of them cleans: `pnpm build` removes dist/ and browser/ first
const library = (entry: string) => ({
  entry: [entry],
  format: ["esm" as const, "cjs" as const],
  platform: "neutral" as const,
  target: "es2020",
  fixedExtension: true,
  dts: true,
  deps: external,
  clean: false,
})

const browser = (globalName: string, entry: string, file = globalName) => ({
  entry: { [file]: entry },
  format: "iife" as const,
  globalName,
  platform: "browser" as const,
  target: "es2020",
  minify: true,
  outDir: "browser",
  outputOptions: { entryFileNames: "[name].min.js" },
  deps: external,
  clean: false,
})

export default defineConfig({
  pack: [
    // `protoapi` (with the bundled sources) and `protoapi/core` (without them): two self-contained bundles, ESM + CJS
    // with bundled declarations; `@bufbuild/protobuf` stays external (optional peer, loaded on demand)
    library("src/index.ts"),
    library("src/core.ts"),
    // self-contained browser builds for <script> tags and CDNs (minified IIFEs)
    browser("protoapi", "src/index.ts"),
    browser("protoapiCore", "src/core.ts", "protoapi-core"),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
    // one file at a time, as the timing rows of the performance tests (PB-9) need the machine to themselves
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/bundle/**"],
    },
  },
  lint: {
    ignorePatterns: GENERATED,
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    ignorePatterns: [...GENERATED, "pnpm-lock.yaml", "bundle/**"],
    semi: false,
    printWidth: 120,
  },
})
