// Mapping catalogue (design Appendix A): every EX example is a fixture set under test/fixtures/catalogue/<set>/ with
// a meta.yaml holding the build options and the fragment assertions transcribed from the design.
//
//   "<EX-ID>: <title>"     PB-1/PB-3/PB-5: buildFromProto output matches the design fragments, issues and absences
//   "<EX-ID>: conformance" PB-2: buildFromDescriptorSet(buf image) gives the same document text and source map
//
// Images are generated with `node scripts/images.ts catalogue`; sets marked `textOnly` do not compile with buf.

import { describe, expect, test } from "vite-plus/test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import yaml from "js-yaml"
import { buildFromDescriptorSet, buildFromProto } from "../../src/index.ts"
import type { BuildOptions, BuildResult } from "../../src/index.ts"
import { FIXTURES, IMAGES, fixtureSets, jsonDiff, loadImage, loadSources } from "../helpers.ts"
import { formatSpan, matchFragment, matchIssues, parsePointer, resolvePointer } from "./match.ts"

interface Expectation {
  pointer: string
  value?: unknown
  /** keys allowed in the actual subtree without being expected (e.g. bundled-file descriptions "omitted here") */
  ignoreKeys?: string[]
  /** exact key order of the object at `pointer` (declaration-order claims) */
  keyOrder?: string[]
}

interface Meta {
  title: string
  options?: BuildOptions
  textOnly?: boolean
  /** fixture path -> source key passed to buildFromProto (EX-FILE-5 path normalisation) */
  sources?: Record<string, string>
  /** order of the source keys passed to buildFromProto (default: sorted paths) */
  sourceOrder?: string[]
  expect?: Expectation[]
  /** exact issue set, order-insensitive; default: no issues */
  issues?: string[]
  absent?: string[]
  /** pointer -> "line:column-line:column" */
  sourceMap?: Record<string, string>
}

// Known failures, keyed by set id (fragment test) or `<set id> conformance`. Each stays a visible test.failing.
const FAILING: Record<string, string> = {
  // CAT-1 … CAT-8 were fixed in src/ (protoapi 0.1.0, design §18); none are known to fail now.
}

const ROOT = join(FIXTURES, "catalogue")
const SETS = fixtureSets(ROOT).map((s) => s.slice("catalogue/".length))

const readMeta = (id: string): Meta => yaml.load(readFileSync(join(ROOT, id, "meta.yaml"), "utf8")) as Meta

const textSources = (id: string, meta: Meta): Record<string, string> => {
  const files = loadSources(`catalogue/${id}`)
  const order = meta.sourceOrder ?? Object.keys(files)
  const missing = Object.keys(files).filter((f) => !order.includes(f))
  const out: Record<string, string> = {}
  for (const f of [...order, ...missing]) out[meta.sources?.[f] ?? f] = files[f]
  return out
}

/** Every mismatch between a text build and the set's meta assertions. */
const checkFragments = (result: BuildResult, meta: Meta): string[] => {
  const problems: string[] = []
  const doc = result.document
  for (const e of meta.expect ?? []) {
    const actual = resolvePointer(doc, e.pointer)
    if (actual === undefined) {
      problems.push(`${e.pointer}: missing`)
      continue
    }
    if (e.value !== undefined) {
      matchFragment(actual, e.value, parsePointer(e.pointer), { ignoreKeys: e.ignoreKeys }, problems)
    }
    if (e.keyOrder) {
      const keys = actual && typeof actual === "object" ? Object.keys(actual) : []
      if (keys.join() !== e.keyOrder.join())
        problems.push(`${e.pointer}: key order ${keys.join(",")} !== ${e.keyOrder.join(",")}`)
    }
  }
  for (const p of meta.absent ?? []) {
    const actual = resolvePointer(doc, p)
    if (actual !== undefined) problems.push(`${p}: expected absent, got ${JSON.stringify(actual)?.slice(0, 160)}`)
  }
  problems.push(...matchIssues(result.issues, meta.issues ?? []))
  for (const [p, span] of Object.entries(meta.sourceMap ?? {})) {
    const actual = formatSpan(result.sourceMap[p])
    if (actual !== span) problems.push(`sourceMap ${p}: expected ${span}, got ${actual}`)
  }
  return problems
}

const run = (key: string) => (FAILING[key] ? test.fails : test)

describe("mapping catalogue", () => {
  for (const id of SETS) {
    const meta = readMeta(id)
    const options = meta.options ?? {}

    run(id)(`${id}: ${meta.title}`, () => {
      const result = buildFromProto(textSources(id, meta), options)
      expect(checkFragments(result, meta)).toEqual([])
    })

    if (meta.textOnly) continue
    run(`${id} conformance`)(`${id}: conformance`, () => {
      const imagePath = join(IMAGES, "catalogue", `${id}.json`)
      expect(existsSync(imagePath) ? imagePath : "image missing: run `node scripts/images.ts catalogue`").toBe(
        imagePath,
      )
      const text = buildFromProto(textSources(id, meta), options)
      const descriptor = buildFromDescriptorSet(loadImage(`catalogue/${id}`), options)
      expect(jsonDiff(descriptor.document, text.document)).toEqual([])
      expect(JSON.stringify(descriptor.document)).toBe(JSON.stringify(text.document))
      expect(jsonDiff(descriptor.sourceMap, text.sourceMap).filter((l) => !l.includes(": key order "))).toEqual([])
      expect(descriptor.sourceMap).toEqual(text.sourceMap)
    })
  }
})

test("catalogue covers every Appendix A example", () => {
  const ids = new Set(SETS.map((s) => s.split(".")[0]))
  expect(ids.size).toBe(85)
})
