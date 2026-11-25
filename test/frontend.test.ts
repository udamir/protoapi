// Text front end fixes of phase B: keyword type names (text#13), syntax-error files (text#14), long string literals
// (text#15), the async loader (C-16) and missing imports per importer (C-17). Oracle cases in test/cases/frontend.ts.

import { describe, expect, test } from "vite-plus/test"
import { buildFromProto, buildFromProtoAsync, parseProto } from "../src/index.ts"
import { cases } from "./cases/frontend.ts"
import { describeCases } from "./cases/run.ts"
import { matchIssues } from "./catalogue/match.ts"

describeCases("text front end", "frontend", cases)

const LIB = 'syntax = "proto3";\npackage lib;\nmessage Money { int64 units = 1; }\n'
const ENTRY = (imports: string) =>
  `syntax = "proto3"; package shop; ${imports}\nmessage Price { lib.Money amount = 1; }\n`

describe("C-16: async loader", () => {
  const loader = (calls: string[]) => async (path: string) => {
    calls.push(path)
    return path === "lib/money.proto" ? LIB : undefined
  }

  for (const [label, imports] of [
    ["an import on the line of other statements", 'import "lib/money.proto";'],
    ["an import after a block comment", '/* c */ import "lib/money.proto";'],
    ["the path on the next line", 'import\n  "lib/money.proto";'],
    ["a modifier and a comment between the tokens", 'import public /* c */ "lib/money.proto";'],
    ["single quotes", "import 'lib/money.proto';"],
  ] as const) {
    test(`imports are found by parsing: ${label}`, async () => {
      const calls: string[] = []
      const r = await buildFromProtoAsync({ "shop.proto": ENTRY(imports) }, { loader: loader(calls) })
      expect(calls).toEqual(["lib/money.proto"])
      expect(r.issues).toEqual([])
      expect(r.document.components?.messages?.["shop.Price"]?.properties.amount.$ref).toBe(
        "#/components/messages/lib.Money",
      )
    })
  }

  test("an import inside a comment or a string is not loaded", async () => {
    const calls: string[] = []
    const text = `syntax = "proto3";\n// import "lib/money.proto";\n/* import "x.proto"; */\npackage shop;\noption java_package = "import \\"y.proto\\";";\n`
    const r = await buildFromProtoAsync({ "shop.proto": text }, { loader: loader(calls) })
    expect(calls).toEqual([])
    expect(r.issues).toEqual([])
  })

  test("a loader that rejects or throws gives a missing-import issue; the build resolves", async () => {
    const rejecting = async (path: string) => {
      if (path === "lib/money.proto") throw new Error("network down")
      return undefined
    }
    const r = await buildFromProtoAsync({ "shop.proto": ENTRY('import "lib/money.proto";') }, { loader: rejecting })
    expect(
      matchIssues(r.issues, [
        "missing-import @ #/files/shop.proto/imports/0",
        "unresolved-type @ #/components/messages/shop.Price/properties/amount",
      ]),
    ).toEqual([])
    expect(r.issues[0].message).toContain("the loader failed: network down")
    const throwing = (path: string): string => {
      throw new Error(`no ${path}`)
    }
    const t = await buildFromProtoAsync({ "shop.proto": ENTRY('import "lib/money.proto";') }, { loader: throwing })
    expect(t.issues[0].code).toBe("missing-import")
    expect(t.issues[0].message).toContain("no lib/money.proto")
  })

  test("a loader result that is not a string is an issue; each file is parsed once", async () => {
    const r = await buildFromProtoAsync(
      { "shop.proto": ENTRY('import "lib/money.proto";') },
      { loader: async () => 42 as unknown as string },
    )
    expect(r.issues[0].message).toContain("the loader returned number")
    // the async build gives the same result as the sync build with the loaded files as sources
    const calls: string[] = []
    const a = await buildFromProtoAsync({ "shop.proto": ENTRY('import "lib/money.proto";') }, { loader: loader(calls) })
    const s = buildFromProto({ "shop.proto": ENTRY('import "lib/money.proto";') }, { loader: () => LIB })
    expect(JSON.stringify(a.document)).toBe(JSON.stringify(s.document))
    expect(a.sourceMap).toEqual(s.sourceMap)
  })

  test("transitive imports and missing transitive imports (C-17 per importer)", async () => {
    const files: Record<string, string> = {
      "a.proto": 'syntax = "proto3";\npackage a;\nimport "b.proto";\nimport "x.proto";\n',
      "b.proto": 'syntax = "proto3";\npackage b;\nimport "x.proto";\nmessage B {}\n',
    }
    const r = await buildFromProtoAsync({ "a.proto": files["a.proto"] }, { loader: async (p) => files[p] })
    expect(
      matchIssues(r.issues, [
        "missing-import @ #/files/a.proto/imports/1",
        "missing-import @ #/files/b.proto/imports/0",
      ]),
    ).toEqual([])
  })
})

describe("text#15: long string literals", () => {
  test("a 1.2M-character string option parses (no regex engine limit)", () => {
    const big = "x".repeat(1_200_000)
    const text = `syntax = "proto3";\npackage p;\noption java_package = "${big}";\nmessage M { string s = 1; }\n`
    const r = buildFromProto({ "a.proto": text })
    expect(r.issues).toEqual([])
    expect((r.document.files?.["a.proto"]?.options?.java_package as string).length).toBe(1_200_000)
    expect(parseProto(`syntax = "proto3"; option java_package = '${big}\\n\\x41';`).error).toBeUndefined()
  })

  test("escapes in long literals and adjacent literals", () => {
    const part = "ab\\n\\x41\\101\\u00e9".repeat(50_000)
    const r = buildFromProto({
      "a.proto": `syntax = "proto3";\npackage p;\noption java_package = "${part}" '${part}';\n`,
    })
    expect(r.issues).toEqual([])
    expect((r.document.files?.["a.proto"]?.options?.java_package as string).length).toBe(2 * 50_000 * 6)
  })
})
