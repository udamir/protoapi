// PB-8: builders never throw on input problems; every problem is an issue (design §4.3, §13).

import { describe, expect, test } from "bun:test"
import {
  buildFromDescriptorSet,
  buildFromDescriptorSetBinary,
  buildFromProto,
  buildFromProtoAsync,
  bundledFiles,
  locateDiff,
  locatePointer,
  parseProto,
  printProto,
} from "../src"
import type { ProtoApiDocument } from "../src"
import { loadImage, loadSources } from "./helpers"

// deterministic PRNG
const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}

describe("PB-8 robustness", () => {
  test("PB-8.1: mutated real files never throw (text producer and printer)", () => {
    const rand = rng(42)
    const files = Object.entries(bundledFiles)
    for (let i = 0; i < 150; i++) {
      const [path, text] = files[Math.floor(rand() * files.length)]
      const chars = text.split("")
      for (let k = 0; k < 5; k++) {
        const at = Math.floor(rand() * chars.length)
        const op = rand()
        if (op < 0.4) chars.splice(at, 1)
        else if (op < 0.7) chars.splice(at, 0, "{};=\"'[]()<>,.-0aZ_"[Math.floor(rand() * 19)])
        else chars[at] = " "
      }
      const result = buildFromProto({ [path]: chars.join("") }, { includeImports: true })
      expect(result.document.protoapi).toBe("0.1")
      printProto(result.document)
    }
  })

  test("PB-8.2: syntax errors are issues with locations; other files still build", () => {
    const r = buildFromProto({
      "bad.proto": 'syntax = "proto3"; message Pet { string name = ; }',
      "good.proto": 'syntax = "proto3"; package g; message Ok { int32 a = 1; }',
    })
    expect(r.issues.map((i) => i.code)).toEqual(["syntax"])
    expect(r.issues[0].location?.start).toEqual({ line: 0, column: 47 })
    expect(r.document.components?.messages?.["g.Ok"]).toBeDefined()
  })

  test("PB-8.3: malformed descriptor sets never throw", () => {
    const image = loadImage("poc")
    const rand = rng(7)
    const mutate = (v: unknown, depth: number): unknown => {
      if (Array.isArray(v)) return v.filter(() => rand() > 0.1).map((x) => mutate(x, depth + 1))
      if (v && typeof v === "object") {
        const out: Record<string, unknown> = {}
        for (const [k, x] of Object.entries(v)) {
          const r = rand()
          if (r < 0.05) continue
          out[k] = r < 0.08 ? "garbage" : r < 0.1 ? 12345 : mutate(x, depth + 1)
        }
        return out
      }
      return v
    }
    for (let i = 0; i < 30; i++) {
      // decision 15 (phase D): the set itself must be an object with a `file` array (else a TypeError); its content is
      // mutated
      const set = { ...image, file: mutate(image.file, 1) } as typeof image
      const result = buildFromDescriptorSet(set)
      expect(result.document.protoapi).toBe("0.1")
    }
    expect(buildFromDescriptorSet({ file: [] }).document).toEqual({ protoapi: "0.1" })
  })

  test("PB-8.4: deeply nested messages", () => {
    let src = 'syntax = "proto3"; package d;'
    for (let i = 0; i < 300; i++) src += ` message M${i} { int32 f = 1;`
    src += " }".repeat(300)
    const r = buildFromProto({ "deep.proto": src })
    expect(r.issues).toEqual([])
    expect(Object.keys(r.document.components?.messages ?? {}).length).toBe(300)
  })

  test("PB-8.5: duplicate numbers, names and reserved conflicts are reported, the document keeps what was written", () => {
    const r = buildFromProto({
      "shop.proto":
        'syntax = "proto3"; package shop.v1; message Bad { reserved 3; reserved "old"; int32 a = 1; int32 b = 1; int32 c = 3; int32 old = 4; }',
    })
    expect(r.issues.map((i) => `${i.code} @ ${i.pointer}`).sort()).toEqual(
      [
        "duplicate-number @ #/components/messages/shop.v1.Bad/properties/b",
        "reserved-conflict @ #/components/messages/shop.v1.Bad/properties/c",
        "reserved-conflict @ #/components/messages/shop.v1.Bad/properties/old",
      ].sort(),
    )
    expect(Object.keys(r.document.components?.messages?.["shop.v1.Bad"].properties ?? {})).toEqual([
      "a",
      "b",
      "c",
      "old",
    ])
  })

  test("PB-8.6: wrong argument types are a TypeError for every builder, thrown synchronously (decision 15)", () => {
    const bad: [string, () => unknown][] = [
      ["buildFromProto(null)", () => buildFromProto(null as never)],
      ["buildFromProto(text)", () => buildFromProto('syntax = "proto3";' as never)],
      ["buildFromProto({ a: 5 })", () => buildFromProto({ "a.proto": 5 as never })],
      ["buildFromProto(options 5)", () => buildFromProto({}, 5 as never)],
      ["buildFromProto(entry string)", () => buildFromProto({}, { entry: "a.proto" as never })],
      ["buildFromProto(annotations)", () => buildFromProto({}, { annotations: "some" as never })],
      ["buildFromProto(tags)", () => buildFromProto({}, { tags: { default: 5 as never } })],
      ["buildFromProto(tabWidth)", () => buildFromProto({}, { tabWidth: 0 })],
      ["buildFromProto(loader)", () => buildFromProto({}, { loader: "x" as never })],
      ["buildFromProtoAsync(null)", () => buildFromProtoAsync(null as never)],
      ["buildFromDescriptorSet(null)", () => buildFromDescriptorSet(null as never)],
      ["buildFromDescriptorSet({})", () => buildFromDescriptorSet({} as never)],
      ["buildFromDescriptorSet({ file: x })", () => buildFromDescriptorSet({ file: "x" } as never)],
      ["buildFromDescriptorSetBinary(string)", () => buildFromDescriptorSetBinary("x" as never)],
      [
        "buildFromDescriptorSetBinary(decoder)",
        () => buildFromDescriptorSetBinary(new Uint8Array(), { decoder: 1 as never }),
      ],
      ["parseProto(5)", () => parseProto(5 as never)],
      ["printProto(null)", () => printProto(null as never)],
      ["locatePointer(5)", () => locatePointer(5 as never, {})],
    ]
    for (const [name, fn] of bad)
      expect({
        name,
        error: (() => {
          try {
            fn()
            return "no error"
          } catch (e) {
            return (e as Error).constructor.name
          }
        })(),
      }).toEqual({ name, error: "TypeError" })
  })

  test("PB-8.7: bad input content never throws: garbage text, junk descriptor entries, undecodable bytes", async () => {
    const r1 = buildFromProto({
      "a.proto": "\u0000\uffff message {{{ ",
      "b.proto": "",
      "c.proto": "syntax = 'proto3'; message A { B b = 1; }",
    })
    expect(r1.issues.map((i) => i.code)).toContain("syntax")
    expect(r1.issues.map((i) => i.code)).toContain("unresolved-type")
    const r2 = buildFromDescriptorSet({ file: [null, 5, { name: 5 }, { name: "a.proto", messageType: "x" }] } as never)
    expect(r2.document.protoapi).toBe("0.1")
    const r3 = await buildFromDescriptorSetBinary(new Uint8Array([255, 255, 255, 1, 2]))
    expect(r3.issues.map((i) => i.code)).toEqual(["unsupported"])
    const r4 = await buildFromDescriptorSetBinary(new Uint8Array([1]), { decoder: () => ({ nope: 1 }) as never })
    expect(r4.issues.map((i) => i.code)).toEqual(["unsupported"])
    const r5 = await buildFromProtoAsync(
      { "a.proto": 'syntax = "proto3"; import "b.proto";' },
      { loader: () => Promise.reject(new Error("net")) },
    )
    expect(r5.issues.map((i) => i.code)).toEqual(["missing-import"])
  })

  test("PB-8.8: parseProto(text, path) gives { ast, comments, issues }; a syntax error keeps a partial AST (decision 14)", () => {
    const ok = parseProto('syntax = "proto3";\n// c\nmessage A {}\n', "a.proto")
    expect(ok.issues).toEqual([])
    expect(ok.ast.statements.map((s) => s.type)).toEqual(["syntax", "message"])
    expect(ok.comments.length).toBe(1)
    const bad = parseProto('syntax = "proto3";\npackage p;\nmessage A { int32 a = ; }\n', "dir/bad.proto")
    expect(bad.ast.statements.map((s) => s.type)).toEqual(["syntax", "package"])
    expect(bad.issues).toEqual([
      {
        code: "syntax",
        message: 'expected integer literal, got ";"',
        file: "dir/bad.proto",
        location: { file: "dir/bad.proto", start: { line: 2, column: 22 }, end: { line: 2, column: 22 } },
      },
    ])
    // the builders report the same issue at the same place
    const built = buildFromProto({ "dir/bad.proto": 'syntax = "proto3";\npackage p;\nmessage A { int32 a = ; }\n' })
    expect(built.issues.map((i) => ({ code: i.code, location: i.location }))).toEqual(
      bad.issues.map((i) => ({ code: i.code, location: i.location })),
    )
  })

  test("PB-8.9: printProto never throws on documents with missing optional parts (API-2)", () => {
    const rand = rng(11)
    const docs = ["poc", "named/validate", "named/http", "named/values", "named/edition2024"].map(
      (s) => buildFromProto(loadSources(s), { includeImports: true }).document,
    )
    const drop = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.filter(() => rand() > 0.1).map(drop)
      if (v && typeof v === "object") {
        const out: Record<string, unknown> = {}
        for (const [k, x] of Object.entries(v)) if (k === "protoapi" || rand() > 0.12) out[k] = drop(x)
        return out
      }
      return v
    }
    for (let i = 0; i < 200; i++) {
      const doc = drop(docs[i % docs.length]) as ProtoApiDocument
      const out = printProto(doc)
      // files marked `bundled` are not printed (U3): a document whose remaining entries are all bundled prints nothing
      const files = doc.files && typeof doc.files === "object" ? Object.values(doc.files) : []
      const printable = !files.length || files.some((f) => !f || typeof f !== "object" || f.bundled !== true)
      expect(Object.keys(out).length > 0).toBe(printable)
    }
  })

  test("PB-8.10: parts of the wrong type in a document are a TypeError, never another error (decision 15)", () => {
    const rand = rng(5)
    const doc = buildFromProto(loadSources("poc"), { includeImports: true }).document
    const junk = [null, 5, "x", [], {}, true]
    const mutate = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(mutate)
      if (v && typeof v === "object") {
        const out: Record<string, unknown> = {}
        for (const [k, x] of Object.entries(v))
          out[k] = k !== "protoapi" && rand() < 0.03 ? junk[Math.floor(rand() * junk.length)] : mutate(x)
        return out
      }
      return v
    }
    const errors = new Set<string>()
    for (let i = 0; i < 200; i++) {
      try {
        printProto(mutate(doc) as ProtoApiDocument)
      } catch (e) {
        errors.add((e as Error).constructor.name)
      }
    }
    expect([...errors].filter((e) => e !== "TypeError")).toEqual([])
  })

  test("PB-8.11: an option set twice and an aggregate over a sub-path are issues; the last value wins (A-5)", () => {
    const r = buildFromProto({
      "a.proto": [
        'syntax = "proto3";',
        "package a;",
        'import "buf/validate/validate.proto";',
        'option java_package = "x";',
        'option java_package = "y";',
        "message M { string s = 1 [(buf.validate.field).string.min_len = 1, (buf.validate.field).string = { min_len: 2 }]; }",
      ].join("\n"),
    })
    expect(r.issues.map((i) => i.code).sort()).toEqual(["invalid-option", "invalid-option"])
    expect(r.document.components?.messages?.["a.M"].properties.s.minLength).toBe(2)
  })

  test("PB-8.12: a flat message of 18,000 fields builds and prints in linear time", () => {
    const fields = (n: number) =>
      `syntax = "proto3"; package big; message M { ${Array.from({ length: n }, (_, i) => `int32 f${i} = ${i + 1};`).join(" ")} }`
    const time = (n: number) => {
      const t0 = performance.now()
      const r = buildFromProto({ "big.proto": fields(n) })
      printProto(r.document)
      expect(r.issues).toEqual([])
      return performance.now() - t0
    }
    time(1800)
    const small = Math.min(time(1800), time(1800))
    const large = Math.min(time(18000), time(18000))
    // 10 times the input (field numbers stay below the reserved 19000 to 19999): well under 30 times the time
    // (quadratic behaviour would be 100 times)
    expect(large / small).toBeLessThan(30)
  }, 60000)

  test("PB-8.13: locateDiff never throws on paths the maps do not know", () => {
    const map = buildFromProto({ "a.proto": 'syntax = "proto3"; package a; message M { int32 x = 1; }' }).sourceMap
    for (const path of [
      [],
      [0],
      ["components"],
      ["components", "messages", "a.M", "required", "x"],
      ["x", 1, 2, "$ref"],
    ])
      for (const action of ["add", "remove", "replace", "rename", "other"])
        expect(() => locateDiff({ action, path, before: 1, after: {} }, map, map)).not.toThrow()
  })
})
