// Printer options (spec §6).

import type { ProtoSources, TagName } from "./build.ts"

export interface PrintOptions {
  /** default two spaces */
  indent?: string
  /**
   * Comment annotations for keywords no available option can carry: `true` (default) prints comment tags, AIP prefixes and `Deprecated:` lines; `false` prints none (for documents built with `annotations: "options"` or `"none"`); a map renames or disables tags like `BuildOptions.tags` (pass the build's map, so the printed tags read back under the same names).
   */
  tags?: boolean | Partial<Record<TagName, string | false>>
  /** for documents without `files` (default "protoapi.proto") */
  fileName?: string
  /**
   * `.proto` sources (import path -> text) whose definitions type option values and names that the document does not
   * hold, typically the build's own sources when it ran with `imports: "referenced"` (option definitions of
   * imported files are not in the document). Bundled files are always consulted.
   */
  sources?: ProtoSources
}
