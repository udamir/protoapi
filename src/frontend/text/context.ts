// Conversion state of the .proto text front end (the file being converted) and the helpers that read nodes in its
// source text: locations, names, numbers, type references and issues.

import type { BuildIssue, BuildIssueCode, Location, ProtoSyntax } from "../../types.ts"
import type { Locs, MFile, MTypeRef } from "../../model/index.ts"
import type { Span, Type } from "../../parser/index.ts"
import { isScalar } from "../../values/scalars.ts"
import { parseIntText } from "../../values/literals.ts"
import { TRIVIA, tokenRange, tokensText } from "./nodes.ts"

export interface Ctx {
  path: string
  text: string
  loc: (start: number, end: number) => Location
  syntax: ProtoSyntax
  pkg: string
  file: MFile
  issues: BuildIssue[]
  /** files are checked only when they are not bundled (bundled definitions are valid) */
  check: boolean
}

export const span = (ctx: Ctx, n: Span | undefined): Location | undefined => {
  const r = tokenRange(n)
  return r ? ctx.loc(r[0], r[1]) : undefined
}

export const src = (ctx: Ctx, n: Span): string => ctx.text.slice(n.start, n.end)

/** A dotted name as written, without the whitespace and comments between its tokens. */
export const identText = (ctx: Ctx, n: Span): string => tokensText(n, (x) => src(ctx, x))

export const intOf = (ctx: Ctx, n: Span | undefined): number => {
  if (!n) return 0
  const v = parseIntText(src(ctx, n).replace(TRIVIA, ""))
  return v === undefined ? 0 : Number(v)
}

export const typeRefOf = (ctx: Ctx, n: Type): MTypeRef => {
  const name = identText(ctx, n)
  return isScalar(name) ? { kind: "scalar", scalar: name } : { kind: "named", name }
}

/** Locations of an element (key "") and of its parts. */
export const locsOf = (ctx: Ctx, n: Span, parts: Record<string, Span | undefined>): Locs => {
  const out: Locs = {}
  const self = span(ctx, n)
  if (self) out[""] = self
  for (const [k, p] of Object.entries(parts)) {
    const l = span(ctx, p)
    if (l) out[k] = l
  }
  return out
}

// ---- issues ---------------------------------------------------------------------------------------------------------

/** A definition issue of a checked (non-bundled) file. */
export const report = (
  ctx: Ctx,
  code: BuildIssueCode,
  message: string,
  at: Span | Location | undefined,
  pointer: string | undefined,
) => {
  if (!ctx.check) return
  const location = at && "file" in at ? at : span(ctx, at)
  ctx.issues.push({ code, message, file: ctx.path, location, pointer })
}
