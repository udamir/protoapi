// The JSON Schema of the format (schemas/v0.1/schema.json, spec §3) accepts every document the tests build: every
// round-trip input in all three emission modes and without `files`, and every inline case, buf-rejected ones included
// (a producer emits the most complete document invalid input allows, spec §4.2).

import { describe, expect, test } from "vite-plus/test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Ajv2020 } from "ajv/dist/2020.js"
import { buildFromProto } from "../src/index.ts"
import type { BuildOptions, ProtoSources } from "../src/index.ts"
import { IMPORT_MODES, ROOT, inMode } from "./helpers.ts"
import { roundTripSets } from "./roundtrip-sets.ts"
import type { Case } from "./cases/types.ts"

const schema = JSON.parse(readFileSync(join(ROOT, "schemas", "v0.1", "schema.json"), "utf8"))
const validate = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true }).compile(
  schema,
)

const errors = (sources: ProtoSources, options: BuildOptions) => {
  const { document } = buildFromProto(sources, options)
  return validate(document)
    ? []
    : (validate.errors ?? [])
        .slice(0, 10)
        .map((e) => `${e.instancePath || "/"} ${e.message} ${JSON.stringify(e.params)}`)
}

/**
 * Documents outside the schema, with the reason. PB-4.27 is invalid on purpose: an rpc takes and returns an enum (an
 * `unresolved-type`), and the producer keeps the reference to the enum it found, which the schema does not allow for a
 * method (spec §3.2: a request or response is a message).
 */
const EXCEPTIONS: Record<string, string> = {
  "resolution/PB-4.27": "/services/p.S/methods/A/request/schema/$ref, /services/p.S/methods/B/response/schema/$ref",
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

describe("JSON Schema of ProtoApi 0.1", () => {
  test("the schema compiles in strict mode", () => {
    expect(validate.errors ?? null).toBeNull()
  })

  test("rejects documents outside the format", () => {
    expect(validate({})).toBe(false)
    expect(validate({ protoapi: "0.2" })).toBe(false)
    expect(validate({ protoapi: "0.1", extra: 1 })).toBe(false)
    const doc = (field: object) => ({
      protoapi: "0.1",
      components: { messages: { "a.M": { type: "object", properties: { f: { number: 1, ...field } } } } },
    })
    expect(validate(doc({ type: "int64" }))).toBe(true)
    expect(validate(doc({ type: "integer" }))).toBe(false)
    expect(validate(doc({}))).toBe(false)
    expect(validate(doc({ type: "int64", $ref: "#/components/messages/a.M" }))).toBe(false)
    expect(validate(doc({ type: "array" }))).toBe(false)
    expect(validate(doc({ type: "object", propertyNames: { type: "string" } }))).toBe(false)
    expect(validate(doc({ type: "string", options: { x: null } }))).toBe(false)
  })

  test("accepts every round-trip input in every emission mode and without files", async () => {
    const failed: Record<string, string[]> = {}
    for (const s of await roundTripSets(false)) {
      for (const imports of IMPORT_MODES) {
        const e = errors(s.sources, inMode(s.options, imports))
        if (e.length) failed[`${s.id} (${imports})`] = e
      }
      const e = errors(s.sources, { ...s.options, files: false })
      if (e.length) failed[`${s.id} (files: false)`] = e
    }
    expect(failed).toEqual({})
  })

  test("accepts the document of every inline case, buf-rejected ones included", async () => {
    const failed: Record<string, string[]> = {}
    for (const module of CASE_MODULES) {
      const { cases } = (await import(`./cases/${module}.ts`)) as { cases: Case[] }
      for (const c of cases) {
        const e = errors(c.sources, { ...c.options, entry: c.entry ?? Object.keys(c.sources) })
        const id = `${module}/${c.id}`
        if (id in EXCEPTIONS) expect(e.length, `${id} is valid now: remove it from EXCEPTIONS`).toBeGreaterThan(0)
        else if (e.length) failed[id] = e
      }
    }
    expect(failed).toEqual({})
  })
})
