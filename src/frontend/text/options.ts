// Option statements of the .proto text front end: raw options with the locations buf gives them, and the field
// pseudo-options `json_name` and `default`.

import type { MField, MMessage, MOptionHolder } from "../../model/index.ts"
import type { Constant, FieldOption, FieldOptions, Option, OptionName } from "../../parser/index.ts"
import { addPending } from "../../model/index.ts"
import { decodeStringLiteral } from "../../values/literals.ts"
import { type Ctx, span, src } from "./context.ts"
import { fieldOptionList, optionNameSegments } from "./nodes.ts"

export const pushOption = (
  ctx: Ctx,
  holder: MOptionHolder,
  optionName: OptionName,
  constant: Constant,
  at: Option | FieldOption,
) => {
  // buf: an option statement `option (name) = { … };` (one name segment, aggregate value; at file level too) is
  // located from the option name to the closing brace; other option statements (sub-paths, scalar values) cover the
  // whole statement. For a repeated option field the whole statement is used too (C-10); the interpreter picks
  // `stmtLoc` once the field is known.
  const whole = span(ctx, at)
  const nameToBrace =
    at.type === "option" &&
    constant?.type === "aggregate" &&
    optionNameSegments(optionName, (x) => src(ctx, x)).length === 1
  const loc = nameToBrace ? ctx.loc(optionName.start, constant.end) : whole
  holder.raw.push({
    kind: "text",
    name: optionName,
    value: constant,
    text: src(ctx, constant).trim(),
    loc,
    ...(nameToBrace ? { stmtLoc: whole } : {}),
  })
}

/** The options of a `[...]` list as raw options of `holder`. */
export const pushFieldOptions = (ctx: Ctx, holder: MOptionHolder, fieldOptions: FieldOptions | undefined) => {
  for (const o of fieldOptionList(fieldOptions)) pushOption(ctx, holder, o.optionName, o.constant, o)
}

/** Field options, with the pseudo-options json_name and default moved to the field. */
export const applyFieldOptions = (ctx: Ctx, field: MField, fieldOptions: FieldOptions | undefined) => {
  for (const o of fieldOptionList(fieldOptions)) {
    const segs = optionNameSegments(o.optionName, (x) => src(ctx, x))
    if (segs.length === 1 && !segs[0].ext && segs[0].name === "json_name") {
      if (field.jsonName !== undefined)
        addPending(field, { code: "invalid-option", message: "json_name is set more than once", loc: span(ctx, o) })
      field.jsonName = decodeStringLiteral(src(ctx, o.constant))
      const l = span(ctx, o)
      if (l) field.locs.jsonName = l
      continue
    }
    if (segs.length === 1 && !segs[0].ext && segs[0].name === "default") {
      if (field.default !== undefined)
        addPending(field, { code: "invalid-option", message: "default is set more than once", loc: span(ctx, o) })
      field.default = { kind: "text", value: o.constant }
      const l = span(ctx, o)
      if (l) field.locs.default = l
      continue
    }
    pushOption(ctx, field, o.optionName, o.constant, o)
  }
}

/** `option message_set_wire_format = true;` among the raw options of a message (text form, before typing). */
export const isMessageSet = (ctx: Ctx, m: MMessage): boolean =>
  m.raw.some(
    (r) =>
      r.kind === "text" &&
      r.text === "true" &&
      optionNameSegments(r.name, (x) => src(ctx, x))
        .map((s) => (s.ext ? `(${s.name})` : s.name))
        .join(".") === "message_set_wire_format",
  )
