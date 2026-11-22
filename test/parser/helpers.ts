import { expect } from "bun:test"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { type ParseProtoResult, parseProto } from "../../src/parser"
import type * as ast from "../../src/parser"

export const packageRoot = join(import.meta.dir, "..", "..")
export const bundleDir = join(packageRoot, "bundle", "proto")
export const fixturesDir = join(import.meta.dir, "fixtures")

/** A backslash, so that escapes reach the proto source verbatim. */
export const bs = "\\"

export function listProtoFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) listProtoFiles(path, out)
    else if (path.endsWith(".proto")) out.push(path)
  }
  return out
}

/** Parses and asserts there is no error. */
export function parseOk(text: string): ParseProtoResult {
  const result = parseProto(text)
  if (result.error) throw new Error(`unexpected parse error: ${JSON.stringify(result.error)}`)
  return result
}

/** Narrows a node to the given `type`, failing the test otherwise. */
export function as<TType extends ast.Node["type"]>(
  node: { type: string } | undefined,
  type: TType,
): Extract<ast.Node, { type: TType }> {
  expect(node?.type).toBe(type)
  return node as Extract<ast.Node, { type: TType }>
}

export function topLevel(text: string): ast.TopLevelStatement[] {
  return parseOk(text).ast.statements
}

/** Statements of the first message in `text` (ignoring syntax / edition / package / import / option). */
export function messageBody(text: string): ast.MessageBodyStatement[] {
  const message = topLevel(text).find((s) => s.type === "message")
  return as(message, "message").messageBody.statements
}

export function enumBody(text: string): ast.EnumBodyStatement[] {
  const enm = topLevel(text).find((s) => s.type === "enum")
  return as(enm, "enum").enumBody.statements
}

export function typeText(type: ast.Type | ast.FullIdent): string {
  return type.identOrDots.map((x) => x.text).join("")
}

export function optionNameText(name: ast.OptionName): string {
  return name.optionNameSegmentOrDots
    .map((x) => (x.type === "dot" ? "." : `${x.bracketOpen ? "(" : ""}${typeText(x.name)}${x.bracketClose ? ")" : ""}`))
    .join("")
}

/** Comment groups as arrays of raw comment texts (trimmed). */
export function groups(gs: ast.CommentGroup[]): string[][] {
  return gs.map((g) => g.comments.map((c) => c.text.trim()))
}

export function comments(s: ast.StatementBase): { L: string[][]; T: string[][]; D: string[][] } {
  return { L: groups(s.leadingComments), T: groups(s.trailingComments), D: groups(s.leadingDetachedComments) }
}
