// Runs the inline cases of a case module against their recorded buf oracle (see types.ts).
//
//   buf accepts: buildFromProto(sources) ≡ buildFromDescriptorSet(buf image) (document text and source map), and the
//                text build has exactly `issues` (default: none)
//   buf rejects: the recorded error contains `buf`, and the text build reports exactly `issues`

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { buildFromDescriptorSet, buildFromProto } from "../../src"
import type { BuildResult } from "../../src"
import { IMAGES, jsonDiff } from "../helpers"
import { matchIssues } from "../catalogue/match"
import type { Case, CaseOracle } from "./types"

export const loadOracles = (module: string): Record<string, CaseOracle> => {
  const path = join(IMAGES, "cases", `${module}.json`)
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}
}

/** The text build of a case (entry: the case's files). */
export const buildCase = (c: Case): BuildResult =>
  buildFromProto(c.sources, { ...c.options, entry: c.entry ?? Object.keys(c.sources) })

export const describeCases = (name: string, module: string, cases: Case[]) => {
  const oracles = loadOracles(module)
  describe(name, () => {
    for (const c of cases) {
      test(`${c.id}: ${c.title}`, () => {
        const oracle = oracles[c.id]
        expect(oracle ? "recorded" : `no buf oracle: run \`bun scripts/case-images.ts ${module}\``).toBe("recorded")
        const text = buildCase(c)
        expect(matchIssues(text.issues, c.issues ?? [])).toEqual([])
        if (c.buf !== undefined) {
          // buf rejects the input (the oracle error is the evidence)
          expect(oracle.error ?? "buf accepted the input").toContain(c.buf)
        } else {
          expect(oracle.error).toBeUndefined()
          const options = { ...c.options, entry: c.entry ?? Object.keys(c.sources) }
          const descriptor = buildFromDescriptorSet(oracle.image as never, options)
          if (!c.noConformance) {
            expect(matchIssues(descriptor.issues, c.descriptorIssues ?? [])).toEqual([])
            expect(jsonDiff(text.document, descriptor.document)).toEqual([])
            expect(JSON.stringify(text.document)).toBe(JSON.stringify(descriptor.document))
            if (c.options?.tabWidth === undefined || c.options.tabWidth === 4)
              expect(jsonDiff(text.sourceMap, descriptor.sourceMap)).toEqual([])
          }
          c.descriptorCheck?.(descriptor, expect)
        }
        c.check?.(text, expect)
      })
    }
  })
}
