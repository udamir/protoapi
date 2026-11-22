// Records the buf oracle of the inline test cases (test/cases/*.ts): for each case, the buf image when buf accepts the
// input, or buf's error when it rejects it, in test/images/cases/<module>.json. Dev only (needs the buf CLI from
// devDependencies). Bundled files are removed from the images: the descriptor producer takes them from the bundle.
//
//   bun scripts/case-images.ts               # every case module
//   bun scripts/case-images.ts validation    # one module

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"
import { bundledFiles } from "../src"
import type { Case, CaseOracle } from "../test/cases/types"

const ROOT = join(import.meta.dir, "..")
const CASES = join(ROOT, "test", "cases")
const OUT = join(ROOT, "test", "images", "cases")
const SCRATCH = join(ROOT, ".tmp", "case-images")
const BUF = join(ROOT, "node_modules", ".bin", "buf")
const PARALLEL = 8

const only = process.argv[2]
const modules = readdirSync(CASES)
  .filter((f) => f.endsWith(".ts") && f !== "types.ts" && f !== "run.ts")
  .map((f) => f.slice(0, -3))
  .filter((m) => !only || m === only)

const runBuf = (work: string, args: string[]): Promise<{ status: number; stderr: string }> =>
  new Promise((resolve) => {
    const p = spawn(BUF, args, { cwd: work })
    let stderr = ""
    p.stderr.on("data", (d) => {
      stderr += d
    })
    p.on("close", (status) => resolve({ status: status ?? 1, stderr }))
  })

const oracle = async (module: string, c: Case): Promise<CaseOracle> => {
  const work = join(SCRATCH, module, c.id.replace(/[^\w.-]/g, "_"))
  rmSync(work, { recursive: true, force: true })
  mkdirSync(join(work, "src"), { recursive: true })
  // only the bundled files the case can import (WKTs are built into buf, but the copies make the images identical)
  cpSync(join(ROOT, "bundle", "proto"), join(work, "src"), { recursive: true })
  for (const [path, text] of Object.entries(c.sources)) {
    mkdirSync(dirname(join(work, "src", path)), { recursive: true })
    writeFileSync(join(work, "src", path), text)
  }
  writeFileSync(
    join(work, "buf.yaml"),
    "version: v2\nmodules:\n  - path: src\nlint:\n  use: []\nbreaking:\n  use: []\n",
  )
  const out = join(work, "out.json")
  const files = c.entry ?? Object.keys(c.sources)
  const res = await runBuf(work, ["build", ...files.flatMap((f) => ["--path", join("src", f)]), "-o", out])
  if (res.status !== 0) return { error: res.stderr.trim() }
  const image = JSON.parse(readFileSync(out, "utf8")) as { file: Record<string, unknown>[] }
  image.file = image.file.filter((f) => {
    const name = String(f.name)
    return !(name in bundledFiles) || name in c.sources
  })
  return { image }
}

mkdirSync(OUT, { recursive: true })
for (const module of modules) {
  const { cases } = (await import(join(CASES, `${module}.ts`))) as { cases: Case[] }
  const result: Record<string, CaseOracle> = {}
  for (let i = 0; i < cases.length; i += PARALLEL) {
    const batch = cases.slice(i, i + PARALLEL)
    const oracles = await Promise.all(batch.map((c) => oracle(module, c)))
    batch.forEach((c, k) => {
      result[c.id] = oracles[k]
    })
  }
  const path = join(OUT, `${module}.json`)
  // one case per line
  const lines = Object.entries(result).map(([id, o]) => `${JSON.stringify(id)}: ${JSON.stringify(o)}`)
  writeFileSync(path, `{\n${lines.join(",\n")}\n}\n`)
  const rejected = Object.values(result).filter((o) => o.error).length
  console.log(`${module}: ${cases.length} cases (${rejected} rejected by buf) -> test/images/cases/${module}.json`)
}
if (existsSync(SCRATCH)) rmSync(SCRATCH, { recursive: true, force: true })
