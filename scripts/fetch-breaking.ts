// Downloads buf's breaking-change test corpus (bufbuild/buf private/bufpkg/bufcheck/testdata/breaking, Apache-2.0)
// at the tag of the pinned buf CLI into test/fixtures/buf-breaking/<current|previous>/<module>/ (validation §8, design
// §13: "the buf breaking_test.go corpus"). Only the .proto inputs and the modules' buf.yaml are kept; every module
// gets a SOURCE.md (the fixture-set marker of test/helpers.ts) and the corpus root the licence.
// Then `node scripts/images.ts buf-breaking` builds their buf images.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const TAG = "v1.75.0"
const BASE = "private/bufpkg/bufcheck/testdata/breaking/"
const ROOT = join(import.meta.dirname, "..", "test", "fixtures", "buf-breaking")

/** Modules whose buf.yaml names one build root (`build.roots: [root]`): the root's files move up to the module, so
 *  that the fixture paths are the import paths. */
const flatten = () => {
  for (const side of readdirSync(ROOT).filter((d) => d === "current" || d === "previous"))
    for (const m of readdirSync(join(ROOT, side))) {
      const yaml = join(ROOT, side, m, "buf.yaml")
      if (!existsSync(yaml)) continue
      const roots = /roots:\s*\n((?:\s*-\s*\S+\s*\n?)+)/.exec(readFileSync(yaml, "utf8"))?.[1]
      const list = roots ? [...roots.matchAll(/-\s*(\S+)/g)].map((x) => x[1]) : []
      if (list.length !== 1) continue
      const dir = join(ROOT, side, m, list[0])
      cpSync(dir, join(ROOT, side, m), { recursive: true })
      rmSync(dir, { recursive: true, force: true })
    }
}
if (process.argv.includes("--flatten-only")) {
  flatten()
  process.exit(0)
}

const tree = (await (
  await fetch(`https://api.github.com/repos/bufbuild/buf/git/trees/${TAG}?recursive=1`, {
    headers: { accept: "application/vnd.github+json" },
  })
).json()) as { tree: { path: string; type: string }[]; truncated: boolean }
if (tree.truncated) throw new Error("tree listing truncated")
const raw = (path: string) => `https://raw.githubusercontent.com/bufbuild/buf/${TAG}/${path}`

rmSync(ROOT, { recursive: true, force: true })
const files = tree.tree.filter(
  (x) => x.type === "blob" && x.path.startsWith(BASE) && (x.path.endsWith(".proto") || x.path.endsWith("buf.yaml")),
)
const modules = new Set<string>()
for (const f of files) {
  const rel = f.path.slice(BASE.length)
  const res = await fetch(raw(f.path))
  if (!res.ok) throw new Error(`${res.status} ${f.path}`)
  const out = join(ROOT, rel)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, await res.text())
  modules.add(rel.split("/").slice(0, 2).join("/"))
}
flatten()
for (const m of modules)
  writeFileSync(join(ROOT, m, "SOURCE.md"), `From bufbuild/buf@${TAG} ${BASE}${m} (Apache-2.0, see ../../LICENSE).\n`)
const license = await fetch(raw("LICENSE"))
writeFileSync(join(ROOT, "LICENSE"), await license.text())
writeFileSync(
  join(ROOT, "README.md"),
  `buf's breaking-change test corpus: bufbuild/buf@${TAG} ${BASE} (Apache-2.0, LICENSE). Fetched by scripts/fetch-breaking.ts.\n`,
)
console.log(`${files.length} files, ${modules.size} modules`)
