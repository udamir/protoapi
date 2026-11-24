// Text option statements (`option (name).sub = constant;`, `[name = constant]`): the option name resolved segment by
// segment against the `*Options` message and the extensions in scope, and the value set at its path in the tree.

import type { Location } from "../types.ts"
import type { MField, MRawOption, OptionTree } from "../model.ts"
import { kindName } from "../symbols.ts"
import { type Spanned, optionNameSegments } from "../frontend/text/nodes.ts"
import { isPlainObject } from "../common/objects.ts"
import { OPTIONS_MESSAGE, type OptionsKind } from "./kinds.ts"
import { fieldByName, typeOfRef } from "./definitions.ts"
import { isAbsentValue } from "./presence.ts"
import { deepMerge, setRaw } from "./tree.ts"
import { TextFormatReader } from "./textproto.ts"

/** The option statement layer of the option interpreter. */
export class OptionStatementReader extends TextFormatReader {
  /**
   * Interpret one text option statement into `tree`. Returns the top-level key it set and the location to record for
   * it: the statement as located by the front end, or the whole statement for a repeated field (C-10).
   */
  interpretText(
    raw: Extract<MRawOption, { kind: "text" }>,
    kind: OptionsKind,
    tree: OptionTree,
  ): { key: string; loc?: Location } | undefined {
    const { symbols } = this.ctx
    const segments = optionNameSegments(raw.name, (n) => this.src(n))
    if (!segments.length) return undefined
    const rawKey = segments.map((s) => s.name).join(".")
    let def = symbols.message(OPTIONS_MESSAGE[kind])
    const path: { key: string; field: MField }[] = []
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      if (!def) return this.unknown(raw, rawKey, tree)
      let field: MField | undefined
      let key: string
      if (seg.ext) {
        // protoc / buf: the first symbol of any kind found from the scope outward (`LookupSymbol`); a message or
        // other non-extension there is an error, not skipped
        const r = symbols.lookup(seg.name, this.ctx.scope, "any", this.from)
        const found = r.found
        if (found && found.kind !== "extension") {
          this.issue(
            "unresolved-type",
            `option name (${seg.name}) resolves to ${kindName(found.kind)} ${found.fqn}, which is not an extension`,
            raw.loc,
            `options/${rawKey}`,
          )
          tree[rawKey] = raw.text
          return { key: rawKey, loc: raw.loc }
        }
        const entry = found ? symbols.extensionByName.get(found.fqn) : undefined
        if (!entry || entry.field.extendee?.resolved !== def.fqn)
          return this.unknown(
            raw,
            rawKey,
            tree,
            r.hidden ? symbols.hiddenReason(r.hidden, this.from) : undefined,
            i ? undefined : segments.map((x) => x.name),
          )
        field = entry.field
        key = entry.fqn
      } else {
        field = fieldByName(def, seg.name)
        key = seg.name
        if (!field) {
          if (i === 0) return this.unknown(raw, rawKey, tree)
          // C-11: a sub-field the definition does not have (protovalidate before 1.0, a newer FeatureSet) is kept raw
          this.issue(
            "unknown-option",
            `option ${rawKey}: ${def.fqn} has no field "${seg.name}"; the value is kept as written`,
            raw.loc,
            `options/${path[0].key}`,
          )
          setRaw(
            tree,
            [...path.map((p) => p.key), ...segments.slice(i).map((x) => x.name)],
            this.bestEffort(raw.value as unknown as Spanned),
          )
          return { key: path[0].key, loc: raw.loc }
        }
      }
      path.push({ key, field })
      if (i < segments.length - 1) {
        if (field.repeated || field.map) {
          this.issue("invalid-option", `option ${rawKey}: a repeated or map field needs an aggregate value`, raw.loc)
          return undefined
        }
        const t = typeOfRef(field, symbols)
        def = t.kind === "message" ? t.def : undefined
        if (!def) return this.unknown(raw, rawKey, tree)
      }
    }
    const leaf = path[path.length - 1]
    // C-10: protoc / buf locate an option statement that sets a repeated field by the whole statement
    const loc = leaf.field.repeated && raw.stmtLoc ? raw.stmtLoc : raw.loc
    this.currentSub = `options/${path[0].key}`
    const result = this.constantValue(raw.value as unknown as Spanned, leaf.field, raw.loc)
    this.currentSub = undefined
    if (!result.ok) {
      this.issue(
        "invalid-option",
        `invalid value for option ${rawKey}: ${result.reason}`,
        raw.loc,
        `options/${path[0].key}`,
      )
      return undefined
    }
    const value = result.value
    if (path.length > 1) {
      const parent = typeOfRef(path[path.length - 2].field, symbols)
      if (
        parent.kind === "message" &&
        parent.def &&
        !leaf.field.repeated &&
        isAbsentValue(value, leaf.field, parent.def, symbols)
      ) {
        // an implicit-presence zero is the same as an absent value; the enclosing message is still set (C-14)
        this.setPath(tree, path.slice(0, -1), {}, raw.loc, false)
        return { key: path[0].key, loc }
      }
    }
    this.setPath(tree, path, value, raw.loc, (raw.value as unknown as Spanned).type === "aggregate")
    return { key: path[0].key, loc }
  }

  /** An option without a definition: its source text under the name as written, parentheses stripped. Below an unknown extension (`(unk.sub).x`, `names` = the segments) it nests like a known one: `unk.sub: { x }`. */
  private unknown(
    raw: Extract<MRawOption, { kind: "text" }>,
    rawKey: string,
    tree: OptionTree,
    reason?: string,
    names?: string[],
  ): { key: string; loc?: Location } {
    const key = names?.[0] ?? rawKey
    this.issue(
      "unknown-option",
      reason ? `unknown option ${rawKey}: ${reason}` : `unknown option ${rawKey}`,
      raw.loc,
      `options/${key}`,
    )
    if (names && names.length > 1) setRaw(tree, names, raw.text)
    else tree[rawKey] = raw.text
    return { key, loc: raw.loc }
  }

  /**
   * Set `value` at `path`. A non-repeated field set twice is an `invalid-option` (last wins). A sub-path statement
   * merges into a message set before; an aggregate replaces it and is an `invalid-option` when the message was set
   * already (A-5; buf: "message extension `p.agg` set multiple times").
   */
  private setPath(
    tree: OptionTree,
    path: { key: string; field: MField }[],
    value: unknown,
    loc: Location | undefined,
    aggregate: boolean,
  ) {
    let cur = tree as Record<string, unknown>
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i].key
      if (!isPlainObject(cur[k])) cur[k] = {}
      cur = cur[k] as Record<string, unknown>
    }
    const { key, field } = path[path.length - 1]
    if (field.repeated && !field.map) {
      const arr = (Array.isArray(cur[key]) ? cur[key] : (cur[key] = [])) as unknown[]
      arr.push(value)
    } else if ((field.map || !aggregate) && isPlainObject(cur[key]) && isPlainObject(value)) {
      deepMerge(cur[key] as Record<string, unknown>, value)
    } else {
      if (key in cur)
        this.issue(
          "invalid-option",
          `option ${path.map((p) => p.key).join(".")} is set more than once`,
          loc,
          `options/${path[0].key}`,
        )
      cur[key] = value
    }
  }
}
