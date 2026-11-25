// Model -> FileDescriptorProto (ProtoJSON): the structure of a parsed bundled file (types, fields, extensions), the
// parts a @bufbuild/protobuf registry needs to decode the options a set uses.

import type { ProtoScalar } from "../types.ts"
import type { MEnum, MField, MFile, MMessage } from "../model/index.ts"
import { DESCRIPTOR_SCALAR } from "../values/scalars.ts"
import { defaultJsonName } from "../values/json-name.ts"
import { knownEditionName } from "../common/editions.ts"
import { mapEntryName } from "../common/names.ts"

const SCALAR_TYPE: Record<ProtoScalar, string> = Object.fromEntries(
  Object.entries(DESCRIPTOR_SCALAR).map(([k, v]) => [v, k]),
) as Record<ProtoScalar, string>

const typeJson = (t: MField["type"]): Record<string, unknown> => {
  if (t.kind === "scalar") return { type: SCALAR_TYPE[t.scalar] }
  const r = t.resolved
  return {
    type: r?.kind === "enum" ? "TYPE_ENUM" : "TYPE_MESSAGE",
    typeName: `.${r?.fqn ?? t.name.replace(/^\./, "")}`,
  }
}

const syntaxJson = (file: MFile): Record<string, unknown> => {
  if (file.syntax === "proto2") return {}
  if (file.syntax === "proto3") return { syntax: "proto3" }
  const name = knownEditionName(file.syntax)
  return { syntax: "editions", edition: name ?? "EDITION_UNKNOWN" }
}

const enumJson = (e: MEnum) => ({ name: e.name, value: e.values.map((v) => ({ name: v.name, number: v.number })) })

const fieldJson = (f: MField, file: MFile, oneofIndex: Map<string, number>, typeOverride?: Record<string, unknown>) => {
  const out: Record<string, unknown> = {
    name: f.name,
    number: f.number,
    label: f.repeated || f.map ? "LABEL_REPEATED" : f.required ? "LABEL_REQUIRED" : "LABEL_OPTIONAL",
    ...(typeOverride ?? typeJson(f.type)),
  }
  if (f.group && f.type.kind === "named") out.type = "TYPE_GROUP"
  if (f.extendee) out.extendee = `.${f.extendee.resolved ?? f.extendee.name.replace(/^\./, "")}`
  if (f.oneof !== undefined && oneofIndex.has(f.oneof)) out.oneofIndex = oneofIndex.get(f.oneof)
  // protoc always writes json_name; @bufbuild/protobuf uses it as the JSON key
  out.jsonName = f.jsonName ?? defaultJsonName(f.name)
  if (file.syntax === "proto3" && f.optional && !f.repeated && !f.map) out.proto3Optional = true
  return out
}

const messageJson = (m: MMessage, file: MFile): Record<string, unknown> => {
  const oneofs = m.oneofs.map((o) => ({ name: o.name }))
  const oneofIndex = new Map(m.oneofs.map((o, i) => [o.name, i]))
  const nested: Record<string, unknown>[] = m.nested.filter((n) => !n.mapEntry).map((n) => messageJson(n, file))
  const fields = m.fields.map((f) => {
    if (f.map) {
      const entry = mapEntryName(f.name)
      const value = f.map.value
      nested.push({
        name: entry,
        field: [
          { name: "key", number: 1, label: "LABEL_OPTIONAL", type: SCALAR_TYPE[f.map.key], jsonName: "key" },
          { name: "value", number: 2, label: "LABEL_OPTIONAL", ...typeJson(value), jsonName: "value" },
        ],
        options: { mapEntry: true },
      })
      return fieldJson(f, file, oneofIndex, { type: "TYPE_MESSAGE", typeName: `.${m.fqn}.${entry}` })
    }
    const json = fieldJson(f, file, oneofIndex)
    if (json.proto3Optional) {
      json.oneofIndex = oneofs.length
      oneofs.push({ name: `_${f.name}` })
    }
    return json
  })
  return {
    name: m.name,
    field: fields,
    nestedType: nested,
    enumType: m.enums.map(enumJson),
    extension: m.extensions.map((x) => fieldJson(x, file, new Map())),
    extensionRange: m.extensionRanges.map((r) => ({ start: r.start, end: r.end + 1 })),
    oneofDecl: oneofs,
  }
}

/** The structure of a parsed (and linked) file as a ProtoJSON FileDescriptorProto: types, fields, extensions. */
export const modelToDescriptorJson = (file: MFile): Record<string, unknown> => {
  const deps = file.imports.filter((i) => i.flag !== "option")
  return {
    name: file.path,
    ...(file.package ? { package: file.package } : {}),
    dependency: deps.map((i) => i.path),
    publicDependency: deps.flatMap((i, k) => (i.flag === "public" ? [k] : [])),
    weakDependency: deps.flatMap((i, k) => (i.flag === "weak" ? [k] : [])),
    messageType: file.messages.map((m) => messageJson(m, file)),
    enumType: file.enums.map(enumJson),
    extension: file.extensions.map((x) => fieldJson(x, file, new Map())),
    ...syntaxJson(file),
  }
}
