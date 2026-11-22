/**
 * Origin: pbkit 0.0.72, `core/parser/location.d.ts` (https://github.com/pbkit/pbkit),
 * Copyright (c) JongChan Choi. Licence: MIT OR Apache-2.0 (see ./LICENSE-MIT, ./LICENSE-APACHE).
 *
 * Modifications:
 * - reconstructed as TypeScript source from the published `.d.ts`; type-only import.
 */
import type { ColRow } from "./recursive-descent-parser"

export interface Location extends Range {
  filePath: string
}

export interface Range {
  start: ColRow
  end: ColRow
}
