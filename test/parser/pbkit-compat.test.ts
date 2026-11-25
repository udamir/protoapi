/**
 * Regression check of the port against the unmodified compiled pbkit 0.0.72 parser, unpacked under
 * `.tmp/package` (not committed; the suite is skipped when it is absent).
 *
 * The ASTs must be equal modulo the documented changes: comment groups are compared separately (the attachment
 * algorithm was rewritten after protoc; on these files it gives the same groups), statement spans are ignored
 * (they include the comment groups), and `undefined`-valued keys are ignored.
 */
import { describe, expect, test } from "vite-plus/test"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, relative } from "node:path"
import { parseProto } from "../../src/parser/index.ts"
import { bundleDir, listProtoFiles, packageRoot } from "./helpers.ts"
import { generateSyntheticProto } from "./synthetic.ts"

const pbkitParser = join(packageRoot, ".tmp", "package", "core", "parser", "proto.js")
const available = existsSync(pbkitParser)

interface PbkitParse {
  parse(text: string): { ast: { statements: unknown[] } }
}

const commentKeys = new Set(["leadingComments", "trailingComments", "leadingDetachedComments"])

/** Strips comment groups and statement spans, drops undefined keys. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (!value || typeof value !== "object") return value
  const o = value as Record<string, unknown>
  const isStatement = "leadingComments" in o
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || commentKeys.has(k)) continue
    if (isStatement && (k === "start" || k === "end")) continue
    out[k] = normalize(v)
  }
  return out
}

/** Comment groups (raw texts) of every statement, in document order. */
function commentGroups(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) commentGroups(v, out)
    return out
  }
  if (!value || typeof value !== "object") return out
  const o = value as Record<string, unknown>
  if ("leadingComments" in o) {
    const texts = (key: string) =>
      (o[key] as { comments: { text: string }[] }[]).map((g) => g.comments.map((c) => c.text))
    out.push(
      JSON.stringify({
        L: texts("leadingComments"),
        T: texts("trailingComments"),
        D: texts("leadingDetachedComments"),
      }),
    )
  }
  for (const [k, v] of Object.entries(o)) if (!commentKeys.has(k) && v && typeof v === "object") commentGroups(v, out)
  return out
}

describe.skipIf(!available)("pbkit 0.0.72 (compiled original) vs port", () => {
  const pbkit = available ? (createRequire(import.meta.url)(pbkitParser) as PbkitParse) : undefined
  const files = listProtoFiles(bundleDir)

  for (const file of files) {
    test(`same AST: ${relative(bundleDir, file)}`, () => {
      const text = readFileSync(file, "utf8")
      const mine = parseProto(text)
      const original = pbkit?.parse(text)
      expect(mine.error).toBeUndefined()
      expect(normalize(mine.ast)).toEqual(normalize(original?.ast))
      expect(commentGroups(mine.ast)).toEqual(commentGroups(original?.ast))
    })
  }

  test("speed on the bundle and on a ~1.5 MB synthetic file", () => {
    const texts = files.map((f) => readFileSync(f, "utf8"))
    const synthetic = generateSyntheticProto(1_500_000)
    const time = (fn: () => void, runs: number) => {
      fn() // warm-up
      const t0 = performance.now()
      for (let i = 0; i < runs; i++) fn()
      return (performance.now() - t0) / runs
    }
    const bundleBytes = texts.reduce((n, t) => n + t.length, 0)
    const mineBundle = time(() => texts.forEach((t) => parseProto(t)), 5)
    const pbkitBundle = time(() => texts.forEach((t) => pbkit?.parse(t)), 5)
    const mineSynthetic = time(() => parseProto(synthetic), 3)
    const pbkitSynthetic = time(() => pbkit?.parse(synthetic), 3)
    const rate = (bytes: number, ms: number) => `${(bytes / 1e6 / (ms / 1000)).toFixed(1)} MB/s`
    console.log(
      [
        `bundle (${(bundleBytes / 1e6).toFixed(2)} MB): port ${mineBundle.toFixed(1)} ms (${rate(bundleBytes, mineBundle)}),` +
          ` pbkit ${pbkitBundle.toFixed(1)} ms (${rate(bundleBytes, pbkitBundle)})`,
        `synthetic (${(synthetic.length / 1e6).toFixed(2)} MB): port ${mineSynthetic.toFixed(1)} ms` +
          ` (${rate(synthetic.length, mineSynthetic)}), pbkit ${pbkitSynthetic.toFixed(1)} ms` +
          ` (${rate(synthetic.length, pbkitSynthetic)})`,
      ].join("\n"),
    )
    const mine = parseProto(synthetic)
    expect(normalize(mine.ast)).toEqual(normalize(pbkit?.parse(synthetic).ast))
  })
})
