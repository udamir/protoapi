// The timing rows of the performance budgets (design §12, PB-9): one definition shared by the tests
// (test/performance.test.ts, test/parser/perf.test.ts) and the Node benchmark (bench/budgets.ts). Every row is measured
// in a fresh `node --expose-gc` process, so its time does not depend on the heap of a test runner.

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildFromDescriptorSet, buildFromProto, bundledFiles, printProto } from "../src/index.ts"
import type { FileDescriptorSetJson } from "../src/index.ts"
import { createLineIndex, parseProto, parseTextprotoMessage } from "../src/parser/index.ts"
import { generateSyntheticProto } from "../test/parser/synthetic.ts"
import { generate } from "./generate.ts"

const ROOT = join(import.meta.dirname, "..")

export interface Metric {
  id: string
  title: string
  /** the value must stay below it */
  budget: number
  unit: "ms" | "x"
}

export interface Row {
  id: string
  title: string
  metrics: Metric[]
  /** a generous upper bound of one measurement, for test timeouts */
  timeout: number
  /** measures every metric of the row, in the calling process */
  measure(): Record<string, number>
}

/** Min of `runs` timed runs after `warm` warm-up runs (the JIT tiers up over several runs of a large build) and a full
 *  collection of the warm-up garbage (with --expose-gc). */
const best = (fn: () => unknown, runs = 3, warm = 3): number => {
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
const corpus = (messages: number, pkg: string) => ({ [`${pkg}.proto`]: generate(messages, pkg) })

/** The buf image (ProtoJSON) of the 1.4 MB corpus, built once with the buf CLI and cached under .tmp/bench. */
export const image14 = (): string => {
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

const ms = (id: string, title: string, budget: number): Metric => ({ id, title, budget, unit: "ms" })

export const ROWS: Row[] = [
  {
    id: "PB-9.1",
    title: "buildFromProto, 140 KB",
    metrics: [ms("PB-9.1", "buildFromProto, 140 KB", 150)],
    timeout: 20000,
    measure: () => {
      const src = corpus(170, "bench.a")
      return { "PB-9.1": best(() => buildFromProto(src)) }
    },
  },
  {
    id: "PB-9.2",
    title: "buildFromProto, 1.4 MB, with source map",
    metrics: [ms("PB-9.2", "buildFromProto, 1.4 MB, with source map", 1000)],
    timeout: 60000,
    measure: () => {
      const src = corpus(1700, "bench.b")
      if (MB(src["bench.b.proto"]) < 1.3) throw new Error("the 1.4 MB corpus is too small")
      return { "PB-9.2": best(() => buildFromProto(src)) }
    },
  },
  {
    id: "PB-9.3",
    title: "buildFromProto, 8.6 MB, and time per MB against the 1.4 MB case",
    metrics: [
      ms("PB-9.3", "buildFromProto, 8.6 MB", 7000),
      { id: "PB-9.3 ratio", title: "time per MB, 8.6 MB / 1.4 MB", budget: 1.3, unit: "x" },
    ],
    timeout: 240000,
    measure: () => {
      const small = corpus(1700, "bench.c")
      const large = corpus(10200, "bench.d")
      if (MB(large["bench.d.proto"]) < 8) throw new Error("the 8.6 MB corpus is too small")
      const ts = best(() => buildFromProto(small))
      const tl = best(() => buildFromProto(large), 3, 1)
      const perMB = (t: number, s: Record<string, string>) => t / MB(Object.values(s)[0])
      return { "PB-9.3": tl, "PB-9.3 ratio": perMB(tl, large) / perMB(ts, small) }
    },
  },
  {
    id: "PB-9.4",
    title: "buildFromDescriptorSet, 11 MB ProtoJSON of the 1.4 MB corpus, excluding JSON.parse",
    metrics: [ms("PB-9.4", "buildFromDescriptorSet, 11 MB ProtoJSON", 500)],
    timeout: 90000,
    measure: () => {
      const text = image14()
      if (text.length / 1e6 < 9) throw new Error("the image of the 1.4 MB corpus is too small")
      const set = JSON.parse(text) as FileDescriptorSetJson
      const messages = Object.keys(buildFromDescriptorSet(set).document.components?.messages ?? {}).length
      if (messages < 1700) throw new Error(`the image holds ${messages} messages`)
      return { "PB-9.4": best(() => buildFromDescriptorSet(set)) }
    },
  },
  {
    id: "PB-9.5",
    title: "printProto, 1.4 MB corpus",
    metrics: [ms("PB-9.5", "printProto, 1.4 MB corpus", 500)],
    timeout: 60000,
    measure: () => {
      const doc = buildFromProto(corpus(1700, "bench.e")).document
      return { "PB-9.5": best(() => printProto(doc)) }
    },
  },
  {
    id: "PB-9.6",
    title: "text-format parsing, 10,000 aggregate option values",
    metrics: [ms("PB-9.6", "text-format parsing, 10,000 aggregate values", 100)],
    timeout: 20000,
    measure: () => {
      const texts = Array.from(
        { length: 10000 },
        (_, i) => `get: "/v1/{name=shelves/*/books/${i}}" additional_bindings { post: "/v1/books:get${i}" body: "*" }`,
      )
      if (texts.some((t) => parseTextprotoMessage(t).error)) throw new Error("a text-format value does not parse")
      return { "PB-9.6": best(() => texts.forEach((t) => parseTextprotoMessage(t))) }
    },
  },
  {
    id: "PARSE-1",
    title: "parseProto, 1.5 MB synthetic file, and 1-based line lookups of every comment",
    metrics: [
      ms("PARSE-1", "parseProto, 1.5 MB synthetic file", 1000),
      ms("PARSE-1 index", "line index + lookups", 200),
    ],
    timeout: 30000,
    measure: () => {
      const text = generateSyntheticProto(1_500_000)
      const r = parseProto(text)
      if (r.error) throw new Error(`the synthetic file does not parse: ${r.error.message}`)
      const parse = best(() => parseProto(text))
      const index = best(() => {
        const lines = createLineIndex(text)
        let sum = 0
        for (const c of r.comments) sum += lines.toPosition(c.start).line
        return sum
      })
      return { "PARSE-1": parse, "PARSE-1 index": index }
    },
  },
]

/** Measures a row in a fresh `node --expose-gc` process (bench/budgets.ts --row <id>). */
export const measureInChild = (id: string): Record<string, number> => {
  const res = spawnSync(process.execPath, ["--expose-gc", join(ROOT, "bench", "budgets.ts"), "--row", id], {
    encoding: "utf8",
  })
  if (res.status !== 0) throw new Error(`${id}: ${res.stderr}`)
  return JSON.parse(res.stdout.trim().split("\n").pop() as string) as Record<string, number>
}
