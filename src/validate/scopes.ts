// Name clashes inside a scope (C++ scoping): fields and oneofs against the types and extensions of their message, enum values against the other values and the symbols of the scope their enum is declared in.

import type { MEnum, MField, MFile, MMessage, MOneof } from "../model.ts"
import { ptr } from "../paths.ts"
import { enumPointer, mapEntryName, qualify } from "../common/names.ts"
import type { ValidateContext } from "./context.ts"

/** The types and extensions declared in the message scope (C++ scoping: fields and oneofs share it), by name. */
export const memberScope = (m: MMessage): Map<string, string> => {
  const scoped = new Map<string, string>()
  for (const n of m.nested) scoped.set(n.name, `message ${n.fqn}`)
  for (const e of m.enums) scoped.set(e.name, `enum ${e.fqn}`)
  for (const x of m.extensions) scoped.set(x.name, `extension ${m.fqn}.${x.name}`)
  return scoped
}

/** A field named like a type or extension of its message (its own group type aside), or whose map entry name is taken. */
export const checkFieldScope = (
  cx: ValidateContext,
  scoped: Map<string, string>,
  f: MField,
  file: MFile,
  fp: string,
) => {
  if (!scoped.size) return
  const clash = scoped.get(f.name)
  const ownGroup = f.group && f.type.kind === "named" && clash === `message ${f.type.resolved?.fqn}`
  if (clash && !ownGroup)
    cx.issue("duplicate-name", `field ${f.name} has the name of ${clash}`, file, fp, f.locs.name ?? f.locs[""])
  const entry = f.map ? scoped.get(mapEntryName(f.name)) : undefined
  if (entry)
    cx.issue(
      "duplicate-name",
      `map field ${f.name} needs the entry message name ${mapEntryName(f.name)}, which ${entry} uses`,
      file,
      fp,
      f.locs[""],
    )
}

/** A oneof named like a field, type or extension of its message. */
export const checkOneofScope = (
  cx: ValidateContext,
  scoped: Map<string, string>,
  m: MMessage,
  o: MOneof,
  file: MFile,
  op: string,
) => {
  const field = m.fields.find((f) => f.name === o.name)
  const clash = field ? `field ${field.name}` : scoped.get(o.name)
  if (clash) cx.issue("duplicate-name", `oneof ${o.name} has the name of ${clash}`, file, op, o.locs.name ?? o.locs[""])
}

/** Enum values by scope; a package scope collects the values of every validated file of the package. */
export class EnumValueScopes {
  /** package -> enum value name -> enum fqn, across the validated files */
  private readonly packageValues = new Map<string, Map<string, string>>()
  private readonly cx: ValidateContext

  constructor(cx: ValidateContext) {
    this.cx = cx
  }

  /**
   * Enum values are siblings of their enum (C++ scoping): two enums of one scope with a value of the same name, or a
   * value named like a type, extension or service of that scope, clash (buf: "`A` declared multiple times").
   */
  check(enums: MEnum[], scope: string, file: MFile, members?: MMessage) {
    if (!enums.length) return
    // package scope: values of every file of the package; message scope: the message's own members
    let values = members ? new Map<string, string>() : this.packageValues.get(scope)
    if (!values) this.packageValues.set(scope, (values = new Map()))
    let local: Map<string, string> | undefined
    if (members) {
      local = new Map()
      for (const f of members.fields) local.set(f.name, `field ${members.fqn}.${f.name}`)
      for (const o of members.oneofs) local.set(o.name, `oneof ${members.fqn}.${o.name}`)
    }
    for (const e of enums) {
      const ep = enumPointer(e.fqn)
      for (const v of e.values) {
        const fqn = qualify(scope, v.name)
        const vp = `${ep}/values/${ptr(v.name)}`
        const loc = v.locs.name ?? v.locs[""]
        const other = values.get(v.name)
        if (other && other !== e.fqn)
          this.cx.issue("duplicate-name", `enum value ${fqn} is also a value of enum ${other}`, file, vp, loc)
        else if (!other) values.set(v.name, e.fqn)
        const sym = this.cx.symbols.get(fqn)
        const clash = sym && sym.kind !== "package" ? `${sym.kind} ${sym.fqn}` : local?.get(v.name)
        if (clash) this.cx.issue("duplicate-name", `enum value ${fqn} has the name of ${clash}`, file, vp, loc)
      }
    }
  }
}
