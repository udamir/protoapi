// The public API over a set of bundled definitions (design §4.3, validation decision PK-1). `protoapi` creates it
// with the bundled sources, `protoapi/core` with none; `createProtoApi` lets a caller inject a bundle of its own
// (for example the `bundledFiles` of `protoapi`, loaded lazily).

import type { PrintOptions, ProtoApiDocument } from "./types.ts"
import { type Builders, createBuilders } from "./build.ts"
import { createPrinter } from "./print/index.ts"

export interface ProtoApi extends Builders {
  /** Print a document back to `.proto` files (path -> text). */
  printProto(document: ProtoApiDocument, options?: PrintOptions): Record<string, string>
  /** The bundled `.proto` sources (import path -> text) this API resolves imports and option types with. */
  readonly bundledFiles: Readonly<Record<string, string>>
}

/** Create the builders and the printer over `bundle` (import path -> `.proto` text). */
export const createProtoApi = (bundle: Readonly<Record<string, string>> = {}): ProtoApi => ({
  ...createBuilders(bundle),
  printProto: createPrinter(bundle),
  bundledFiles: bundle,
})
