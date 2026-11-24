// Phase timings for one corpus size: node bench/phases.ts [messages]

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { generate } from "./bench.ts"
import { textToModel } from "../src/text.ts"
import { convertFile } from "../src/descriptor.ts"
import { SymbolTable } from "../src/symbols.ts"
import { linkAll } from "../src/resolve.ts"
import { Lowering } from "../src/lower/index.ts"
import { bundledSources } from "../src/bundle/sources.ts"
import { parseProto } from "../src/parser/index.ts"
import type { MFile } from "../src/model.ts"

const messages = Number(process.argv[2] ?? 1700)
const src = generate(messages, "bench.p")
const t = (label: string, fn: () => unknown) => {
  const t0 = performance.now()
  const r = fn()
  console.log(`${label}: ${(performance.now() - t0).toFixed(0)} ms`)
  return r
}
console.log(`${(src.length / 1e6).toFixed(2)} MB`)
t("parse", () => parseProto(src))
const extra = ["google/protobuf/timestamp.proto", "google/protobuf/descriptor.proto"].map((p) =>
  textToModel(p, bundledSources[p], [], true),
)
const file = t("textToModel", () => textToModel("x.proto", src, [])) as MFile
const files = [file, ...extra]
const symbols = t("symbols", () => new SymbolTable(files)) as SymbolTable
t("link", () => linkAll(files, symbols))
const sources = new Map([
  ["x.proto", src],
  ...["google/protobuf/timestamp.proto", "google/protobuf/descriptor.proto"].map((p): [string, string] => [
    p,
    bundledSources[p],
  ]),
])
t("lower", () =>
  new Lowering({
    files,
    entry: ["x.proto"],
    symbols,
    options: {},
    imports: "user",
    sources,
    issues: [],
  }).run(),
)

// descriptor
const work = join(import.meta.dirname, "..", ".tmp", "phases")
mkdirSync(join(work, "src", "google", "protobuf"), { recursive: true })
writeFileSync(join(work, "src", "x.proto"), src)
writeFileSync(
  join(work, "src", "google", "protobuf", "timestamp.proto"),
  bundledSources["google/protobuf/timestamp.proto"],
)
writeFileSync(join(work, "buf.yaml"), "version: v2\nmodules:\n  - path: src\n")
const image = join(work, `image-${messages}.json`)
if (!existsSync(image))
  spawnSync(join(import.meta.dirname, "..", "node_modules", ".bin", "buf"), ["build", "-o", image], { cwd: work })
const set = t("JSON.parse", () => JSON.parse(readFileSync(image, "utf8"))) as { file: Record<string, unknown>[] }
const dfiles = t("convertFile", () => set.file.map((f) => convertFile(f, []))) as MFile[]
const dsym = t("symbols", () => new SymbolTable(dfiles)) as SymbolTable
t("link", () => linkAll(dfiles, dsym))
t("lower", () =>
  new Lowering({
    files: dfiles,
    entry: ["x.proto"],
    symbols: dsym,
    options: {},
    imports: "user",
    sources,
    issues: [],
  }).run(),
)
