// Lowering of an extension: its field part (field.ts) with `extendee` and `file`.

import type { ProtoApiExtension } from "../types.ts"
import type { MField, MFile, OptionTree } from "../model/index.ts"
import { extensionFqn, extensionPointer } from "../common/names.ts"
import type { LowerContext } from "./context.ts"
import { orderKeys } from "./emit.ts"
import { lowerField } from "./field.ts"

/** An extension declared in `scope` (a message, or the package); `chain` holds the option trees of the enclosing scopes. */
export const lowerExtension = (
  cx: LowerContext,
  x: MField,
  file: MFile,
  chain: OptionTree[],
  scope: string,
): ProtoApiExtension => {
  const pointer = extensionPointer(extensionFqn(x, scope))
  const field = lowerField(cx, x, file, chain, scope, pointer, undefined, true)
  const extendee = x.extendee?.resolved ?? x.extendee?.unresolvedKey ?? x.extendee?.name.replace(/^\./, "") ?? ""
  const out: Record<string, unknown> = { ...field, title: field.title ?? x.name, extendee }
  if (cx.useFiles) out.file = file.path
  return orderKeys(out) as unknown as ProtoApiExtension
}
