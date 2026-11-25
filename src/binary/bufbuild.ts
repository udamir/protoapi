// The optional peer dependency @bufbuild/protobuf as the binary path uses it: version minimums, the shapes of its
// descriptor messages read here, and the context a decode runs in.

import type { BuildIssue } from "../types.ts"
import type { MFile } from "../model/index.ts"
import { editionNameOfNumber, knownSyntaxOfEdition } from "../common/editions.ts"

/** The first @bufbuild/protobuf release that supports edition 2024 (the peer dependency minimum). */
export const BUFBUILD_MINIMUM = "2.8.0"
/** The first @bufbuild/protobuf release that supports edition 2026. */
export const BUFBUILD_2026 = "2.16.0"
export const VERSION_HINT = `edition 2024 needs @bufbuild/protobuf >= ${BUFBUILD_MINIMUM}, edition 2026 needs >= ${BUFBUILD_2026}`

/** the optional peer is loaded dynamically and used structurally */
export type Any = any

export interface BufbuildModules {
  /** `@bufbuild/protobuf` */
  pb: Any
  /** `@bufbuild/protobuf/wkt` (undefined when the subpath does not exist, as in v1) */
  wkt: Any
}

export interface BinaryContext {
  /** bundled text by import path (the `bundle` option first), undefined when not bundled */
  bundleText: (path: string) => string | undefined
  /** parsed (cached) model of a bundled file */
  bundledFile: (path: string, text: string) => MFile
  issues: BuildIssue[]
}

/** An unknown field kept by @bufbuild/protobuf (`$unknown`). */
export interface UnknownField {
  no: number
  wireType: number
  data: Uint8Array
}

/** The parts of the decoded descriptor messages (`FileDescriptorProto` and its children) read here. */
export interface WithUnknown {
  $unknown?: UnknownField[]
}
export interface WithOptions extends WithUnknown {
  options?: WithUnknown
}
export interface FieldProto extends WithOptions {}
export interface EnumProto extends WithOptions {
  value?: WithOptions[]
}
export interface MessageProto extends WithOptions {
  field?: FieldProto[]
  extension?: FieldProto[]
  oneofDecl?: WithOptions[]
  extensionRange?: WithOptions[]
  nestedType?: MessageProto[]
  enumType?: EnumProto[]
}
export interface ServiceProto extends WithOptions {
  method?: WithOptions[]
}
export interface FileProto extends WithOptions {
  name: string
  dependency?: string[]
  syntax?: string
  edition: number
  messageType?: MessageProto[]
  enumType?: EnumProto[]
  extension?: FieldProto[]
  service?: ServiceProto[]
}

/** An edition number as written in issue messages. */
export const editionLabel = (n: number): string => {
  const name = editionNameOfNumber(n)
  const known = knownSyntaxOfEdition(name)
  return known ? `edition ${known}` : /^\d+$/.test(name) ? `edition ${name}` : name
}
