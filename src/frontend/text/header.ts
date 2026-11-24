// The syntax / edition and package statements of a .proto file, read before the other statements (they scope them).

import type { Location } from "../../types.ts"
import type { Edition, Syntax, TopLevelStatement } from "../../parser/index.ts"
import { unsupportedEdition } from "../../features.ts"
import { isEditions, isKnownSyntax } from "../../common/editions.ts"
import { filePointer } from "../../common/names.ts"
import { ptr } from "../../paths.ts"
import { type Ctx, identText, report, span, src } from "./context.ts"

const syntaxValue = (ctx: Ctx, st: Syntax | Edition): string =>
  src(ctx, st.type === "syntax" ? st.syntax : st.edition).replace(/["']/g, "")

/**
 * The syntax / edition and package statements (they scope everything else). The first of each wins; a second one, or a syntax statement that is not the first statement, is an `invalid-definition` (buf: "unexpected `syntax` declaration"). An unknown `syntax` value (`"proto4"`) is an `invalid-definition` and the file is read as proto2, as the descriptor producer reads an unknown descriptor `syntax`; an unknown edition is kept verbatim (spec §3.3).
 */
export const readHeader = (ctx: Ctx, statements: TopLevelStatement[]) => {
  const { file, path } = ctx
  const fp = filePointer(ctx.path)
  let syntaxSeen = false
  let packageSeen = false
  let first = true
  for (const st of statements) {
    if (st.type === "empty") continue
    if (st.type === "syntax" || st.type === "edition") {
      if (syntaxSeen) {
        report(
          ctx,
          "invalid-definition",
          `unexpected \`${st.type}\` declaration: the file already declares its syntax`,
          st,
          `${fp}/syntax`,
        )
        continue
      }
      if (!first)
        report(
          ctx,
          "invalid-definition",
          `the \`${st.type}\` declaration must be the first statement of the file`,
          st,
          `${fp}/syntax`,
        )
      syntaxSeen = true
      const v = syntaxValue(ctx, st)
      if (st.type === "syntax") {
        file.syntax = v === "proto3" ? "proto3" : "proto2"
        if (v !== "proto2" && v !== "proto3")
          report(
            ctx,
            "invalid-definition",
            `unrecognized syntax "${v}" (proto2 or proto3 expected); the file is read as proto2`,
            st.syntax,
            `${fp}/syntax`,
          )
      } else {
        // a known edition, else the edition string verbatim with an `unsupported` issue
        file.syntax = v
        if (!isKnownSyntax(v) || !isEditions(v))
          ctx.issues.push(unsupportedEdition(`edition "${v}"`, path, ptr(path), ctx.loc(st.start, st.end)))
      }
      file.locs.syntax = span(ctx, st) as Location
    } else if (st.type === "package") {
      if (packageSeen)
        report(
          ctx,
          "invalid-definition",
          "unexpected `package` declaration: the file already declares a package",
          st,
          `${fp}/package`,
        )
      else {
        packageSeen = true
        file.package = identText(ctx, st.fullIdent)
        file.locs.package = span(ctx, st) as Location
      }
    }
    first = false
  }
}
