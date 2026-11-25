// Records whether the printer's output passes `buf build` (validation phase D: "printed text must pass buf build wherever the input did"). For every round-trip input that buf accepts (test/roundtrip-sets.ts) and each emission mode (`imports`), the printed files the second build reads are built with buf 1.75 (the original sources the printer did not replace are added); the result is written to test/images/printed.json keyed by the printed text's hash, which test/roundtrip.test.ts checks against the current printer output. Dev only (needs the buf CLI).
//
//   node scripts/print-check.ts [filter]

import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { normalizePath } from "../src/paths.ts"
import { IMPORT_MODES, inMode, roundTrip } from "../test/helpers.ts"
import { PRINT_CHECK, type PrintCheck, printedHash, roundTripSets } from "../test/roundtrip-sets.ts"

const ROOT = join(import.meta.dirname, "..")
const BUF = join(ROOT, "node_modules", ".bin", "buf")
const filter = process.argv[2]

const bufBuild = (files: Record<string, string>, extra: Record<string, string>): string => {
  const work = join(ROOT, ".tmp", "print-check")
  rmSync(work, { recursive: true, force: true })
  mkdirSync(join(work, "src"), { recursive: true })
  cpSync(join(ROOT, "bundle", "proto"), join(work, "src"), { recursive: true })
  for (const [p, t] of Object.entries({ ...extra, ...files })) {
    mkdirSync(dirname(join(work, "src", p)), { recursive: true })
    writeFileSync(join(work, "src", p), t)
  }
  writeFileSync(
    join(work, "buf.yaml"),
    "version: v2\nmodules:\n  - path: src\nlint:\n  use: []\nbreaking:\n  use: []\n",
  )
  const args = ["build", ...Object.keys(files).flatMap((f) => ["--path", join("src", f)]), "-o", "/dev/null"]
  const res = spawnSync(BUF, args, { cwd: work, encoding: "utf8" })
  return res.status === 0 ? "ok" : res.stderr.trim()
}

const recorded: PrintCheck = existsSync(PRINT_CHECK) && filter ? JSON.parse(readFileSync(PRINT_CHECK, "utf8")) : {}
let failed = 0
for (const set of await roundTripSets()) {
  if (!set.bufValid || (filter && !set.id.startsWith(filter))) continue
  for (const imports of IMPORT_MODES) {
    const r = roundTrip(set.sources, inMode(set.options, imports))
    const extra: Record<string, string> = {}
    if (set.options.files !== false)
      for (const [k, v] of Object.entries(set.sources)) {
        const path = normalizePath(k)
        if (!(path in r.used)) extra[path] = v
      }
    const buf = bufBuild(r.used, extra)
    recorded[`${set.id}|${imports}`] = { hash: printedHash(r.used), buf }
    if (buf !== "ok") {
      failed++
      console.log(`${set.id} imports=${imports}: ${buf.slice(0, 300)}`)
    }
  }
}
const sorted = Object.fromEntries(Object.entries(recorded).sort(([a], [b]) => (a < b ? -1 : 1)))
writeFileSync(PRINT_CHECK, `${JSON.stringify(sorted, null, 1)}\n`)
console.log(`${Object.keys(sorted).length} printed sets recorded, ${failed} rejected by buf`)
