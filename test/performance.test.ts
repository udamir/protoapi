// PB-9: performance budgets, one test per row of design §12 (every timing row: min of at least 3 runs after warm-up). Set PROTOAPI_SKIP_PERF=1 to skip the timing rows on slow CI machines; the size rows (PB-9.8, PB-9.9) always run.

import { describe, expect, test } from "vite-plus/test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { gzipSync } from "node:zlib"
import { build } from "vite-plus"
import { buildFromDescriptorSet, buildFromProto, bundledFiles, printProto } from "../src/index.ts"
import type { FileDescriptorSetJson } from "../src/index.ts"
import { parseTextprotoMessage } from "../src/parser/index.ts"
import { generate } from "../bench/generate.ts"
import { ROOT } from "./helpers.ts"

const skip = !!process.env.PROTOAPI_SKIP_PERF
/** Min of `runs` timed runs after three warm-up runs (the JIT tiers up over several runs of a large build) and a
 *  full collection of the earlier tests' garbage. */
const best = (fn: () => unknown, runs = 3, warm = 3) => {
  for (let i = 0; i < warm; i++) fn()
  ;(globalThis as { gc?: () => void }).gc?.()
  let min = Number.POSITIVE_INFINITY
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    min = Math.min(min, performance.now() - t0)
  }
  return min
}

const MB = (s: string) => s.length / 1e6

/**
 * The same min-of-3 measurement in a fresh process, for rows whose time depends on the garbage collector: the heap of
 * the test process holds the data of every earlier test file. `body` sees `src` (the protoapi entry) and `best`.
 */
const bestInChild = (body: string): number => {
  const script = [
    `const src = require(${JSON.stringify(join(ROOT, "src", "index.ts"))})`,
    `const best = ${best.toString()}`,
    body,
  ].join("\n")
  const res = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" })
  if (res.status !== 0) throw new Error(res.stderr)
  return Number(res.stdout.trim().split("\n").pop())
}
const corpus = (messages: number, pkg: string) => ({ [`${pkg}.proto`]: generate(messages, pkg) })

/** The buf image (ProtoJSON) of the 1.4 MB corpus, built once with the buf CLI and cached under .tmp/bench. */
const image14 = (): string => {
  const work = join(ROOT, ".tmp", "bench", "pb-9.4")
  const out = join(work, "image.json")
  if (existsSync(out)) return readFileSync(out, "utf8")
  mkdirSync(join(work, "src", "google", "protobuf"), { recursive: true })
  writeFileSync(join(work, "src", "bench.b.proto"), generate(1700, "bench.b"))
  writeFileSync(
    join(work, "src", "google", "protobuf", "timestamp.proto"),
    bundledFiles["google/protobuf/timestamp.proto"] as string,
  )
  writeFileSync(join(work, "buf.yaml"), "version: v2\nmodules:\n  - path: src\nlint:\n  use: []\n")
  const res = spawnSync(join(ROOT, "node_modules", ".bin", "buf"), ["build", "-o", out], {
    cwd: work,
    encoding: "utf8",
  })
  if (res.status !== 0) throw new Error(`buf build failed: ${res.stderr}`)
  return readFileSync(out, "utf8")
}

describe.skipIf(skip)("PB-9 performance (timing rows)", () => {
  test("PB-9.1: buildFromProto 140 KB < 150 ms", () => {
    const src = corpus(170, "bench.a")
    expect(best(() => buildFromProto(src))).toBeLessThan(150)
  })

  test("PB-9.2: buildFromProto 1.4 MB with source map < 1,000 ms", () => {
    const src = corpus(1700, "bench.b")
    expect(MB(src["bench.b.proto"])).toBeGreaterThan(1.3)
    expect(best(() => buildFromProto(src))).toBeLessThan(1000)
  }, 20000)

  test("PB-9.3: buildFromProto 8.6 MB < 7,000 ms; time per MB within 1.3x of the 1.4 MB case", () => {
    const small = corpus(1700, "bench.c")
    const large = corpus(10200, "bench.d")
    expect(MB(large["bench.d.proto"])).toBeGreaterThan(8)
    const ts = best(() => buildFromProto(small))
    const tl = best(() => buildFromProto(large), 3, 1)
    expect(tl).toBeLessThan(7000)
    const perMB = (t: number, s: Record<string, string>) => t / MB(Object.values(s)[0])
    expect(perMB(tl, large) / perMB(ts, small)).toBeLessThan(1.3)
  }, 120000)

  test("PB-9.4: buildFromDescriptorSet, 11 MB ProtoJSON of the 1.4 MB corpus, < 500 ms excluding JSON.parse", () => {
    const text = image14()
    expect(text.length / 1e6).toBeGreaterThan(9)
    const set = JSON.parse(text) as FileDescriptorSetJson
    const r = buildFromDescriptorSet(set)
    expect(Object.keys(r.document.components?.messages ?? {}).length).toBeGreaterThan(1700)
    const image = JSON.stringify(join(ROOT, ".tmp", "bench", "pb-9.4", "image.json"))
    const ms = bestInChild(
      `const set = JSON.parse(require("node:fs").readFileSync(${image}, "utf8"))\nconsole.log(best(() => src.buildFromDescriptorSet(set)))`,
    )
    expect(ms).toBeLessThan(500)
  }, 60000)

  test("PB-9.5: printProto, 1.4 MB corpus, < 500 ms", () => {
    const doc = buildFromProto(corpus(1700, "bench.e")).document
    expect(best(() => printProto(doc))).toBeLessThan(500)
  }, 20000)

  test("PB-9.6: text-format parsing, 10,000 aggregate option values, < 100 ms", () => {
    const texts = Array.from(
      { length: 10000 },
      (_, i) => `get: "/v1/{name=shelves/*/books/${i}}" additional_bindings { post: "/v1/books:get${i}" body: "*" }`,
    )
    expect(texts.every((t) => !parseTextprotoMessage(t).error)).toBe(true)
    expect(best(() => texts.forEach((t) => parseTextprotoMessage(t)))).toBeLessThan(100)
  })

  test("PB-9.7: peak heap of the 8.6 MB build < 1 GB (it completes in node with the V8 heap capped at 1 GB)", async () => {
    // a fresh node process with --max-old-space-size=1024 runs the build from the TypeScript sources (node strips the
    // types): completing proves the peak heap stays below the cap (an out-of-memory abort otherwise)
    const script = [
      `import { buildFromProto } from ${JSON.stringify(pathToFileURL(join(ROOT, "src", "index.ts")).href)}`,
      `import { generate } from ${JSON.stringify(pathToFileURL(join(ROOT, "bench", "generate.ts")).href)}`,
      'const r = buildFromProto({ "big.proto": generate(10200, "bench.f") })',
      "console.log(Object.keys(r.document.components.messages).length)",
    ].join("\n")
    const res = spawnSync("node", ["--max-old-space-size=1024", "--input-type=module", "--eval", script], {
      encoding: "utf8",
    })
    expect(res.stderr).not.toContain("heap out of memory")
    expect(res.status).toBe(0)
    expect(Number(res.stdout.trim())).toBeGreaterThan(10000)
  }, 120000)
})

describe("PB-9 performance (size rows)", () => {
  test("PB-9.8: browser code without the bundled sources, minified + gzip, < 60 KB", async () => {
    // the core entry as the browser build bundles it (IIFE, es2020, minified), its bundled .proto strings left out
    const res = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        {
          name: "without-bundled-sources",
          enforce: "pre",
          load: (id) =>
            /src[\\/]bundle[\\/](core-sources|sources)\.ts$/.test(id)
              ? "export const coreSources = {}; export const bundledSources = {}"
              : undefined,
        },
      ],
      build: {
        write: false,
        minify: true,
        target: "es2020",
        lib: { entry: join(ROOT, "src", "core.ts"), formats: ["iife"], name: "protoapiCore" },
        rolldownOptions: { external: [/^@bufbuild\/protobuf/] },
      },
    })) as { output: { code: string }[] }[]
    const size = gzipSync(res[0].output[0].code).length
    expect(size).toBeLessThan(60 * 1024)
  })

  test("PB-9.9: bundled .proto sources, gzip, < 120 KB", () => {
    const size = gzipSync(Object.values(bundledFiles).join("")).length
    expect(size).toBeLessThan(120 * 1024)
  })
})
