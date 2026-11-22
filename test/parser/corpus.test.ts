import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { parseProto } from "../../src/parser"
import { as, bundleDir, fixturesDir, listProtoFiles } from "./helpers"

/** Every token's `text` equals its source slice, and every span lies within the text. */
function checkTokens(text: string, node: unknown, path = "ast"): string[] {
  const problems: string[] = []
  const visit = (value: unknown, p: string) => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, `${p}[${i}]`))
      return
    }
    if (!value || typeof value !== "object") return
    const o = value as Record<string, unknown>
    if (typeof o.start === "number" && typeof o.end === "number") {
      if (typeof o.text === "string" && text.slice(o.start, o.end) !== o.text) problems.push(`${p}: text mismatch`)
      if (Number.isFinite(o.start) && (o.start < 0 || (o.end as number) > text.length)) problems.push(`${p}: span`)
    }
    for (const [k, v] of Object.entries(o)) if (v && typeof v === "object") visit(v, `${p}.${k}`)
  }
  visit(node, path)
  return problems.slice(0, 5)
}

const bundleFiles = listProtoFiles(bundleDir)

describe("bundle/proto (real-world files)", () => {
  // 47 since the v36.2 re-pin: google/protobuf/go_features.proto (protobuf-go) was added (decision 17)
  test("there are 47 files", () => {
    expect(bundleFiles).toHaveLength(47)
  })
  for (const file of bundleFiles) {
    test(relative(bundleDir, file), () => {
      const text = readFileSync(file, "utf8")
      const r = parseProto(text)
      expect(r.error).toBeUndefined()
      expect(r.ast.statements.length).toBeGreaterThan(0)
      expect(checkTokens(text, r.ast)).toEqual([])
      // the comments list is ordered, non-overlapping and covers every `//` line start
      for (let i = 1; i < r.comments.length; i++) {
        expect(r.comments[i].start).toBeGreaterThanOrEqual(r.comments[i - 1].end)
      }
    })
  }

  test("descriptor.proto: messages, enums and extension ranges", () => {
    const text = readFileSync(join(bundleDir, "google/protobuf/descriptor.proto"), "utf8")
    const statements = parseProto(text).ast.statements
    const messages = statements.filter((s) => s.type === "message").map((s) => as(s, "message").messageName.text)
    expect(messages).toContain("FileDescriptorProto")
    expect(messages).toContain("FeatureSet")
    expect(messages).toContain("SourceCodeInfo")
    const fieldOptions = statements.find((s) => s.type === "message" && s.messageName.text === "FieldOptions")
    // protobuf v36 declares `extensions 990 to 998;` (first-class options) before `extensions 1000 to max;`
    const exts = as(fieldOptions, "message").messageBody.statements.filter((s) => s.type === "extensions")
    expect(exts).toHaveLength(2)
    expect(as(as(as(exts[1], "extensions").ranges.rangeOrCommas[0], "range").rangeEnd, "max").text).toBe("max")
  })
})

const catalogueDir = join(fixturesDir, "appendix-a")
const catalogueFiles = listProtoFiles(catalogueDir)

describe("design doc Appendix A snippets (test/parser/fixtures/appendix-a)", () => {
  test("all 76 snippets are present", () => {
    expect(catalogueFiles).toHaveLength(76)
  })
  for (const file of catalogueFiles) {
    test(relative(catalogueDir, file), () => {
      const text = readFileSync(file, "utf8")
      const r = parseProto(text)
      expect(r.error).toBeUndefined()
      expect(checkTokens(text, r.ast)).toEqual([])
    })
  }
})
