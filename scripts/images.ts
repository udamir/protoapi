// Regenerates test/images/<set>.json (buf images, ProtoJSON) for every fixture set under test/fixtures/<set>/.
// Dev only: needs the buf CLI from devDependencies. Each set is built in a scratch module that also contains the
// bundled definitions (bundle/proto), so both producers see the same imported files.
//
//   pnpm images               # all sets
//   pnpm images catalogue     # one set
//   pnpm images bundle        # test/images/bundle.json: every bundled file (PB-2.2)

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { spawnSync } from "node:child_process"

const ROOT = join(import.meta.dirname, "..")
const FIXTURES = join(ROOT, "test", "fixtures")
const IMAGES = join(ROOT, "test", "images")
const SCRATCH = join(ROOT, ".tmp", "images")
const BUF = join(ROOT, "node_modules", ".bin", "buf")

const walk = (dir: string): string[] =>
  readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const p = join(dir, name)
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".proto") ? [p] : []
    })

const only = process.argv[2]
/** sets that also get a binary image (buildFromDescriptorSetBinary tests) */
const BINARY = new Set(["poc", "binary", "catalogue/EX-FILE-4.2026", "catalogue/EX-OPT-6.go"])

/** A set is a directory with .proto files directly inside; other directories are searched for sets. */
const findSets = (dir: string): string[] => {
  const entries = readdirSync(dir).sort()
  if (entries.some((e) => e.endsWith(".proto") || e === "SOURCE.md")) return [dir]
  return entries.filter((e) => statSync(join(dir, e)).isDirectory()).flatMap((e) => findSets(join(dir, e)))
}

for (const dir of findSets(FIXTURES)) {
  const set = relative(FIXTURES, dir).split("\\").join("/")
  if (only && !set.startsWith(only)) continue
  const files = walk(dir).map((f) => relative(dir, f))
  const work = join(SCRATCH, set)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(join(work, "src"), { recursive: true })
  cpSync(join(ROOT, "bundle", "proto"), join(work, "src"), { recursive: true })
  cpSync(dir, join(work, "src"), { recursive: true })
  writeFileSync(
    join(work, "buf.yaml"),
    "version: v2\nmodules:\n  - path: src\nlint:\n  use: []\nbreaking:\n  use: []\n",
  )
  const out = join(IMAGES, `${set}.json`)
  mkdirSync(join(out, ".."), { recursive: true })
  const args = ["build", ...files.flatMap((f) => ["--path", join("src", f)]), "-o", out]
  const res = spawnSync(BUF, args, { cwd: work, encoding: "utf8" })
  if (res.status !== 0) {
    console.error(`${set}: buf failed\n${res.stderr}`)
    if (existsSync(out)) rmSync(out)
    continue
  }
  if (BINARY.has(set))
    spawnSync(BUF, [...args.slice(0, -1), out.replace(/\.json$/, ".binpb")], { cwd: work, encoding: "utf8" })
  console.log(`${set}: ${files.length} files -> ${relative(ROOT, out)}`)
}

// every bundled file as one module (PB-2.2, scripts/conform-bundle.ts)
if (!only || only === "bundle") {
  const work = join(SCRATCH, "bundle")
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  cpSync(join(ROOT, "bundle", "proto"), join(work, "src"), { recursive: true })
  writeFileSync(join(work, "buf.yaml"), "version: v2\nmodules:\n  - path: src\n")
  const out = join(IMAGES, "bundle.json")
  const res = spawnSync(BUF, ["build", "-o", out], { cwd: work, encoding: "utf8" })
  if (res.status !== 0) console.error(`bundle: buf failed\n${res.stderr}`)
  else console.log(`bundle: ${walk(join(work, "src")).length} files -> ${relative(ROOT, out)}`)
}
