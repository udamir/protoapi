// Definition checks of the text producer: what buf rejects in a well-formed file (`invalid-definition` and the other issues of spec §4.2). Runs after the lowering on the files the build validates (non-bundled `.proto` sources), reusing the lowering's typed options and edition defaults. Never throws and never changes the document: every finding is a `BuildIssue`.
// The syntactic rules (labels, groups, statement order, keywords per edition) are checked in text.ts.

import type { MEnum, MField, MFile, MMessage, MService, OptionTree } from "../model/index.ts"
import { OPTIONS_MESSAGES } from "../options/kinds.ts"
import type { ResolvedFeatures } from "../features.ts"
import { defaultJsonName } from "../values/json-name.ts"
import { ptr } from "../paths.ts"
import { isEditions } from "../common/editions.ts"
import { FIELD_NUMBER_MAX, INT32_MAX, INT32_MIN } from "../common/limits.ts"
import {
  enumPointer,
  extensionFqn,
  extensionPointer,
  filePointer,
  messagePointer,
  parentScope,
  servicePointer,
} from "../common/names.ts"
import { ValidateContext, type ValidateInput } from "./context.ts"
import { OptionChecks } from "./options.ts"
import { checkName, enumValueKey, isStyled } from "./naming.ts"
import {
  checkEnumReserved,
  checkExtensionNumbers,
  checkFieldInExtensionRange,
  checkMessageNumbers,
  extensionRangesOf,
  fmtRange,
  reservedRangesOf,
} from "./numbers.ts"
import { EnumValueScopes, checkFieldScope, checkOneofScope, memberScope } from "./scopes.ts"
import { checkImports } from "./imports.ts"

export type { ValidateInput } from "./context.ts"

export const validateFiles = (input: ValidateInput) => new Validator(input).run()

/** The walk over the validated files: each element's options, names, numbers and scopes, in declaration order. */
class Validator {
  private readonly cx: ValidateContext
  private readonly options: OptionChecks
  private readonly valueScopes: EnumValueScopes
  private readonly closedCache = new Map<string, boolean>()
  private readonly files: MFile[]

  constructor(input: ValidateInput) {
    this.cx = new ValidateContext(input)
    this.options = new OptionChecks(this.cx)
    this.valueScopes = new EnumValueScopes(this.cx)
    this.files = input.files
  }

  run() {
    const files = this.files.filter((f) => f.validate && f.parsed)
    if (!files.length) return
    checkImports(this.cx, files)
    for (const f of files) this.file(f)
    checkExtensionNumbers(this.cx, files)
  }

  /** Is the enum `fqn` closed (proto2, or editions enum_type CLOSED resolved along its scopes)? */
  private isClosed(fqn: string): boolean {
    const cached = this.closedCache.get(fqn)
    if (cached !== undefined) return cached
    const cx = this.cx
    const e = cx.symbols.enum(fqn)
    let closed = false
    if (e) {
      const file = e.file
      if (file.syntax === "proto2") closed = true
      else if (isEditions(file.syntax)) {
        const chain: OptionTree[] = []
        for (let scope = parentScope(fqn); scope; scope = parentScope(scope)) {
          const m = cx.symbols.message(scope)
          if (!m || m.file !== file) break
          chain.unshift(cx.opts(m, "message", file, parentScope(m.fqn)))
        }
        chain.unshift(cx.opts(file, "file", file, file.package))
        chain.push(cx.opts(e, "enum", file, parentScope(fqn)))
        closed = cx.features(file, chain).enum_type === "CLOSED"
      }
    }
    this.closedCache.set(fqn, closed)
    return closed
  }

  // ---- files -------------------------------------------------------------------------------------------------------

  private file(f: MFile) {
    const cx = this.cx
    const fp = filePointer(f.path)
    const fileOpts = cx.opts(f, "file", f, f.package)
    this.options.check(f, "file", f, f.package, fp)
    const features = cx.features(f, [fileOpts])
    if (isStyled(features) && f.package) checkName(cx, "package", f.package, f, `${fp}/package`, f.locs.package)
    const strict = isEditions(f.syntax) && cx.symbols.defaultVisibility(f) === "STRICT"
    for (const m of f.messages) this.message(m, f, [fileOpts], strict, false)
    for (const e of f.enums) this.enumeration(e, f, [fileOpts], strict, undefined)
    for (const x of f.extensions) this.extension(x, f, [fileOpts], f.package)
    for (const s of f.services) this.service(s, f, [fileOpts])
    this.valueScopes.check(f.enums, f.package, f)
  }

  // ---- messages ----------------------------------------------------------------------------------------------------

  private message(m: MMessage, file: MFile, chain: OptionTree[], strict: boolean, nested: boolean) {
    const cx = this.cx
    const mp = messagePointer(m.fqn)
    const mo = cx.opts(m, "message", file, parentScope(m.fqn))
    this.options.check(m, "message", file, parentScope(m.fqn), mp)
    const inner = [...chain, mo]
    const features = cx.features(file, inner)
    if (isStyled(features)) checkName(cx, "message", m.name, file, mp, m.locs.name)
    if (strict && nested && m.visibility === "export")
      cx.issue(
        "invalid-definition",
        `nested message ${m.fqn} cannot be exported (default_symbol_visibility STRICT)`,
        file,
        `${mp}/options/visibility`,
        m.locs.name ?? m.locs[""],
      )
    const messageSet = mo.message_set_wire_format === true
    const editions = isEditions(file.syntax)
    const scoped = memberScope(m)
    // fields
    const extRanges = extensionRangesOf(m)
    for (const f of m.fields) {
      const fp = `${mp}/properties/${ptr(f.name)}`
      const fo = cx.opts(f, "field", file, m.fqn)
      this.options.check(f, "field", file, m.fqn, fp)
      let ff = features
      if (editions) {
        const oneof = f.oneof ? m.oneofs.find((o) => o.name === f.oneof) : undefined
        const oo = oneof ? cx.opts(oneof, "oneof", file, parentScope(m.fqn)) : undefined
        ff = cx.features(file, oo ? [...inner, oo, fo] : [...inner, fo])
        if (isStyled(ff)) checkName(cx, "field", f.name, file, fp, f.locs.name)
      }
      this.closedEnum(f, file, ff, fp, false)
      checkFieldInExtensionRange(cx, f, file, fp, extRanges)
      checkFieldScope(cx, scoped, f, file, fp)
    }
    for (const o of m.oneofs) {
      const op = `${mp}/oneofs/${ptr(o.name)}`
      this.options.check(o, "oneof", file, parentScope(m.fqn), op)
      const oo = cx.opts(o, "oneof", file, parentScope(m.fqn))
      if (editions && isStyled(cx.features(file, [...inner, oo]))) checkName(cx, "oneof", o.name, file, op, o.locs.name)
      checkOneofScope(cx, scoped, m, o, file, op)
    }
    this.jsonNames(m, file, features, mp)
    checkMessageNumbers(cx, m, file, mp, messageSet, extRanges)
    for (const r of m.extensionRanges)
      this.options.check(r, "extensionRange", file, parentScope(m.fqn), `${mp}/extensions`)
    for (const n of m.nested) this.message(n, file, inner, strict, true)
    for (const e of m.enums) this.enumeration(e, file, inner, strict, m)
    for (const x of m.extensions) this.extension(x, file, inner, m.fqn)
    this.valueScopes.check(m.enums, m.fqn, file, m)
  }

  /** JSON name clashes (buf: "message fields have the same JSON name"); two default names may clash only under
   *  json_format LEGACY_BEST_EFFORT (proto2). */
  private jsonNames(m: MMessage, file: MFile, features: ResolvedFeatures, mp: string) {
    const legacy = features.json_format === "LEGACY_BEST_EFFORT"
    const seen = new Map<string, { field: MField; custom: boolean }>()
    for (const f of m.fields) {
      const custom = f.jsonName !== undefined
      const json = custom ? (f.jsonName as string) : defaultJsonName(f.name)
      const prev = seen.get(json)
      if (!prev) {
        seen.set(json, { field: f, custom })
        continue
      }
      if (prev.field.name === f.name || (legacy && !custom && !prev.custom)) continue
      this.cx.issue(
        "duplicate-name",
        `the JSON name "${json}" of field ${f.name} is also the JSON name of field ${prev.field.name}`,
        file,
        `${mp}/properties/${ptr(f.name)}`,
        f.locs.jsonName ?? f.locs.name ?? f.locs[""],
      )
    }
  }

  /** A closed enum cannot be the type of a proto3 field, nor of an editions field with implicit presence. */
  private closedEnum(f: MField, file: MFile, features: ResolvedFeatures, fp: string, extension: boolean) {
    const t = f.map ? f.map.value : f.type
    if (t.kind !== "named" || t.resolved?.kind !== "enum" || !this.isClosed(t.resolved.fqn)) return
    if (file.syntax === "proto3")
      this.cx.issue(
        "invalid-definition",
        `closed enum ${t.resolved.fqn} cannot be used in a proto3 message (field ${f.name})`,
        file,
        fp,
        f.locs.type ?? f.locs[""],
      )
    else if (
      isEditions(file.syntax) &&
      !extension &&
      !f.repeated &&
      !f.map &&
      !f.oneof &&
      features.field_presence === "IMPLICIT"
    )
      this.cx.issue(
        "invalid-definition",
        `closed enum ${t.resolved.fqn} cannot be used in field ${f.name}, which has implicit presence`,
        file,
        fp,
        f.locs.type ?? f.locs[""],
      )
  }

  // ---- extensions --------------------------------------------------------------------------------------------------

  private extension(x: MField, file: MFile, chain: OptionTree[], scope: string) {
    const cx = this.cx
    const xp = extensionPointer(extensionFqn(x, scope))
    const xo = cx.opts(x, "field", file, scope)
    this.options.check(x, "field", file, scope, xp)
    const features = cx.features(file, [...chain, xo])
    if (isStyled(features)) checkName(cx, "extension", x.name, file, xp, x.locs.name)
    this.closedEnum(x, file, features, xp, true)
    const extendee = x.extendee?.resolved
    if (file.syntax === "proto3" && extendee && !OPTIONS_MESSAGES.has(extendee))
      cx.issue(
        "invalid-definition",
        `extensions in proto3 are only allowed for custom options; ${extendee} is not a google.protobuf options message`,
        file,
        xp,
        x.locs.extendee ?? x.locs[""],
      )
  }

  // ---- enums -------------------------------------------------------------------------------------------------------

  private enumeration(e: MEnum, file: MFile, chain: OptionTree[], strict: boolean, parent: MMessage | undefined) {
    const cx = this.cx
    const ep = enumPointer(e.fqn)
    const scope = parentScope(e.fqn)
    const eo = cx.opts(e, "enum", file, scope)
    this.options.check(e, "enum", file, scope, ep)
    const features = cx.features(file, [...chain, eo])
    if (isStyled(features)) checkName(cx, "enum", e.name, file, ep, e.locs.name)
    if (strict && parent && e.visibility === "export") this.strictNestedEnum(e, parent, file, ep)
    if (!e.values.length)
      cx.issue("invalid-definition", `enum ${e.fqn} must have at least one value`, file, ep, e.locs[""])
    const open = features.enum_type === "OPEN"
    const first = e.values[0]
    if (open && first && first.number !== 0)
      cx.issue(
        "invalid-definition",
        `the first value of open enum ${e.fqn} must be zero (${first.name} = ${first.number})`,
        file,
        `${ep}/values/${ptr(first.name)}`,
        first.locs.number ?? first.locs[""],
      )
    const allowAlias = eo.allow_alias === true
    const numbers = new Map<number, string>()
    let aliased = false
    const reserved = reservedRangesOf(e)
    const reservedNames = new Set(e.reservedNames)
    const keys = new Map<string, { name: string; number: number }>()
    const checkKeys = features.json_format !== "LEGACY_BEST_EFFORT"
    for (const v of e.values) {
      const vp = `${ep}/values/${ptr(v.name)}`
      this.options.check(v, "enumValue", file, scope, vp)
      const vo = cx.opts(v, "enumValue", file, scope)
      if (isStyled(vo.features ? cx.features(file, [...chain, eo, vo]) : features))
        checkName(cx, "enum value", v.name, file, vp, v.locs.name)
      if (v.number < INT32_MIN || v.number > INT32_MAX)
        cx.issue(
          "invalid-number",
          `enum value ${v.name} = ${v.number} is out of the int32 range`,
          file,
          vp,
          v.locs.number,
        )
      const prev = numbers.get(v.number)
      if (prev !== undefined && prev !== v.name) {
        aliased = true
        if (!allowAlias)
          cx.issue(
            "duplicate-number",
            `enum value number ${v.number} is used by ${prev} and ${v.name} (set allow_alias to allow aliases)`,
            file,
            vp,
            v.locs.number ?? v.locs[""],
          )
      } else if (prev === undefined) numbers.set(v.number, v.name)
      const r = reserved.find((x) => v.number >= x.start && v.number <= x.end)
      if (r)
        cx.issue(
          "reserved-conflict",
          `enum value ${v.name} = ${v.number} uses the reserved range ${fmtRange(r)}`,
          file,
          vp,
          v.locs[""],
        )
      if (reservedNames.has(v.name))
        cx.issue("reserved-conflict", `enum value name ${v.name} is reserved`, file, vp, v.locs.name ?? v.locs[""])
      if (checkKeys) {
        const key = enumValueKey(e.name, v.name)
        const k = keys.get(key)
        if (k && k.name !== v.name && k.number !== v.number)
          cx.issue(
            "duplicate-name",
            `enum value ${v.name} and ${k.name} have the same name once the ${e.name} prefix is removed and case is ignored`,
            file,
            vp,
            v.locs.name ?? v.locs[""],
          )
        else if (!k) keys.set(key, { name: v.name, number: v.number })
      }
    }
    if (allowAlias && !aliased)
      cx.issue(
        "invalid-option",
        `${e.fqn} sets allow_alias, but no two values share a number`,
        file,
        `${ep}/options/allow_alias`,
        e.optionLocs.allow_alias ?? e.locs[""],
      )
    checkEnumReserved(cx, e, file, ep, reserved)
  }

  /** STRICT: a nested enum may be exported only from a local message that reserves every field number (the
   *  "namespace" pattern `message Ns { export enum E { … } reserved 1 to max; }`). */
  private strictNestedEnum(e: MEnum, parent: MMessage, file: MFile, ep: string) {
    const at = `${ep}/options/visibility`
    const loc = e.locs.name ?? e.locs[""]
    const parentLocal = parent.visibility !== "export"
    if (!parentLocal)
      this.cx.issue(
        "invalid-definition",
        `nested enum ${e.fqn} cannot be exported (default_symbol_visibility STRICT)`,
        file,
        at,
        loc,
      )
    else if (parent.reservedRanges.length > 1)
      this.cx.issue(
        "invalid-definition",
        `nested enum ${e.fqn} can be exported only from a message with exactly one reserved range, 1 to max`,
        file,
        at,
        loc,
      )
    else {
      const [lo, hi] = parent.reservedRanges[0] ?? [0, 0]
      if (lo !== 1 || hi < FIELD_NUMBER_MAX)
        this.cx.issue(
          "invalid-definition",
          `nested enum ${e.fqn} can be exported only from a message that reserves all field numbers (reserved 1 to max)`,
          file,
          at,
          loc,
        )
    }
  }

  // ---- services ----------------------------------------------------------------------------------------------------

  private service(s: MService, file: MFile, chain: OptionTree[]) {
    const cx = this.cx
    const sp = servicePointer(s.fqn)
    const so = cx.opts(s, "service", file, s.fqn)
    this.options.check(s, "service", file, s.fqn, sp)
    const features = cx.features(file, [...chain, so])
    if (isStyled(features)) checkName(cx, "service", s.name, file, sp, s.locs.name)
    for (const m of s.methods) {
      const mp = `${sp}/methods/${ptr(m.name)}`
      const mo = cx.opts(m, "method", file, s.fqn)
      this.options.check(m, "method", file, s.fqn, mp)
      if (isStyled(cx.features(file, [...chain, so, mo]))) checkName(cx, "method", m.name, file, mp, m.locs.name)
    }
  }
}
