/**
 * Builds a buf image (FileDescriptorSet, ProtoJSON) of every example at build time, with the buf CLI of the
 * devDependencies, as scripts/images.ts does for the test fixtures. Node only: used by the data loaders.
 */
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { FileDescriptorSetJson } from "../../../src/index.ts"
import type { ExampleCase } from "./cases.ts"

const ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const BUF = join(ROOT, "node_modules", ".bin", "buf")
const SCRATCH = join(ROOT, ".tmp", "docs-images")

export type ImageResult = { image: FileDescriptorSetJson } | { error: string }

const cache = new Map<string, ImageResult>()

/**
 * The image of an example: its own files only (the bundled definitions it imports are left out, as in a set built
 * with the bundle as a dependency), or the error buf reports for an invalid example.
 */
export const bufImage = (item: ExampleCase): ImageResult => {
  const key = JSON.stringify([item.files, item.options?.entry])
  const cached = cache.get(key)
  if (cached) return cached
  const result = run(item)
  cache.set(key, result)
  return result
}

const run = (item: ExampleCase): ImageResult => {
  if (!existsSync(BUF)) return { error: "the buf CLI is not installed" }
  const work = join(SCRATCH, item.id)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(join(work, "src"), { recursive: true })
  // the bundled definitions are part of the module, so buf resolves the same imports as protoapi
  cpSync(join(ROOT, "bundle", "proto"), join(work, "src"), { recursive: true })
  for (const [path, text] of Object.entries(item.files)) {
    mkdirSync(dirname(join(work, "src", path)), { recursive: true })
    writeFileSync(join(work, "src", path), text)
  }
  writeFileSync(
    join(work, "buf.yaml"),
    "version: v2\nmodules:\n  - path: src\nlint:\n  use: []\nbreaking:\n  use: []\n",
  )
  const entries = item.options?.entry ?? Object.keys(item.files)
  const out = join(work, "image.json")
  const result = spawnSync(BUF, ["build", ...entries.flatMap((path) => ["--path", join("src", path)]), "-o", out], {
    cwd: work,
    encoding: "utf8",
  })
  if (result.status !== 0) {
    return { error: (result.stderr || result.error?.message || "buf build failed").trim().replaceAll("src/", "") }
  }
  const image = JSON.parse(readFileSync(out, "utf8")) as FileDescriptorSetJson
  const own = new Set(Object.keys(item.files))
  return { image: { file: image.file.filter((file) => own.has(String(file.name))) } }
}

/** The image without `sourceCodeInfo` and buf's `bufExtension`, for display */
export const displayImage = (image: FileDescriptorSetJson): FileDescriptorSetJson => ({
  file: image.file.map(({ sourceCodeInfo, bufExtension, ...file }) => file),
})
