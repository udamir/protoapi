// Performance benchmark (design §12, PB-9). Synthetic corpus generator from the research PoC
// (docs/research/grpc/poc/bench/bench.ts in api-smart-diff): comments, options, scalars, refs, maps, enums, services.
//   bun bench/bench.ts [--descriptor]

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { buildFromDescriptorSet, buildFromProto, parseProto, printProto } from "../src"
import { generate } from "./generate"

export { generate }

const min3 = (fn: () => unknown): number => {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    fn()
    best = Math.min(best, performance.now() - t0)
  }
  return best
}

if (import.meta.main) {
  const dir = join(import.meta.dir, "..", ".tmp", "bench")
  mkdirSync(dir, { recursive: true })
  const rows = [
    "| corpus | size | parse | buildFromProto | buildFromProto (no map) | printProto | buildFromDescriptorSet |",
    "|---|---|---|---|---|---|---|",
  ]
  for (const [name, messages] of [
    ["140KB", 170],
    ["1.4MB", 1700],
    ["8.6MB", 10200],
  ] as const) {
    const src = generate(messages, `bench.s${name.replace(".", "_").toLowerCase()}`)
    const sources = { [`${name}.proto`]: src }
    const parse = min3(() => parseProto(src))
    const build = min3(() => buildFromProto(sources))
    const buildNoMap = min3(() => buildFromProto(sources, { sourceMap: false }))
    const doc = buildFromProto(sources).document
    const print = min3(() => printProto(doc))
    let desc = "–"
    if (process.argv.includes("--descriptor")) {
      const work = join(dir, name)
      mkdirSync(join(work, "src"), { recursive: true })
      writeFileSync(join(work, "src", `${name}.proto`), src)
      const ts = readFileSync(
        join(import.meta.dir, "..", "bundle", "proto", "google", "protobuf", "timestamp.proto"),
        "utf8",
      )
      mkdirSync(join(work, "src", "google", "protobuf"), { recursive: true })
      writeFileSync(join(work, "src", "google", "protobuf", "timestamp.proto"), ts)
      writeFileSync(join(work, "buf.yaml"), "version: v2\nmodules:\n  - path: src\n")
      const image = join(work, "image.json")
      if (!existsSync(image))
        spawnSync(join(import.meta.dir, "..", "node_modules", ".bin", "buf"), ["build", "-o", image], { cwd: work })
      const set = JSON.parse(readFileSync(image, "utf8"))
      desc = `${min3(() => buildFromDescriptorSet(set)).toFixed(0)} ms`
    }
    rows.push(
      `| ${name} | ${(src.length / 1e6).toFixed(2)} MB | ${parse.toFixed(0)} ms | ${build.toFixed(0)} ms | ${buildNoMap.toFixed(0)} ms | ${print.toFixed(0)} ms | ${desc} |`,
    )
    console.log(rows[rows.length - 1])
  }
  console.log(rows.join("\n"))
}
