// The inputs of the printer round trip (PB-7) and of its buf check (scripts/print-check.ts): every fixture set (the
// catalogue with its meta.yaml build options, the PoC, the named fixtures, googleapis, the buf breaking corpus), every
// bundled file and every inline case that buf accepts.

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import yaml from "js-yaml"
import { bundledFiles } from "../src"
import type { BuildOptions } from "../src"
import { FIXTURES, IMAGES, fixtureSets, loadSources } from "./helpers"
import type { Case, CaseOracle } from "./cases/types"

export interface RoundTripSet {
  /** fixture set path, `bundle`, or `cases/<module>/<case id>` */
  id: string
  sources: Record<string, string>
  options: BuildOptions
  /** buf accepts the input (an image or oracle exists): the printed text must pass `buf build` too */
  bufValid: boolean
}

const CASE_MODULES = [
  "frontend",
  "resolution",
  "features",
  "annotations",
  "values",
  "positions",
  "validation",
  "sourcemap",
]

const catalogueSet = (set: string): RoundTripSet => {
  const id = set.slice("catalogue/".length)
  const meta = yaml.load(readFileSync(join(FIXTURES, set, "meta.yaml"), "utf8")) as {
    options?: BuildOptions
    textOnly?: boolean
    sources?: Record<string, string>
    sourceOrder?: string[]
  }
  const files = loadSources(set)
  const order = meta.sourceOrder ?? Object.keys(files)
  const sources: Record<string, string> = {}
  for (const f of [...order, ...Object.keys(files).filter((f) => !order.includes(f))])
    sources[meta.sources?.[f] ?? f] = files[f]
  return {
    id: set,
    sources,
    options: meta.options ?? {},
    bufValid: !meta.textOnly && existsSync(join(IMAGES, "catalogue", `${id}.json`)),
  }
}

/** Every round-trip input; `cases` adds the inline cases of test/cases (their modules are loaded lazily). */
export const roundTripSets = async (cases = true): Promise<RoundTripSet[]> => {
  const out: RoundTripSet[] = []
  for (const set of fixtureSets()) {
    if (set.startsWith("catalogue/")) out.push(catalogueSet(set))
    else
      out.push({ id: set, sources: loadSources(set), options: {}, bufValid: existsSync(join(IMAGES, `${set}.json`)) })
  }
  out.push({ id: "bundle", sources: { ...bundledFiles }, options: {}, bufValid: true })
  if (cases)
    for (const module of CASE_MODULES) {
      const { cases: list } = (await import(`./cases/${module}.ts`)) as { cases: Case[] }
      const path = join(IMAGES, "cases", `${module}.json`)
      const oracles: Record<string, CaseOracle> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}
      for (const c of list) {
        const oracle = oracles[c.id]
        // buf rejects the input: invalid on purpose, outside the round-trip guarantee
        if (!oracle || oracle.error !== undefined) continue
        out.push({
          id: `cases/${module}/${c.id}`,
          sources: c.sources,
          options: { ...c.options, entry: c.entry ?? Object.keys(c.sources) },
          bufValid: true,
        })
      }
    }
  return out
}

/** Stable hash of printed files (the buf check of scripts/print-check.ts is recorded per hash). */
export const printedHash = (files: Record<string, string>): string =>
  createHash("sha256")
    .update(JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))))
    .digest("hex")
    .slice(0, 16)

/** The recorded buf check of printed text: `<set id>|<imports mode>` -> { hash, buf: "ok" or buf's error }. */
export const PRINT_CHECK = join(IMAGES, "printed.json")
export type PrintCheck = Record<string, { hash: string; buf: string }>
