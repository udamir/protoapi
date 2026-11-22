// Comment text handling shared by both producers (design §3.8 "Comment attachment", D15).
//
// Both front ends deliver comments in protoc's SourceCodeInfo form: for `//` comments the text after `//` of each
// line followed by "\n"; for `/* */` comments the text between the markers where every line after the first has
// its leading whitespace and one `*` removed. `normalizeComment` turns that form into description text.
// buf 1.75 writes the same form, except that a `//` comment on the line of the previous token has no final "\n"; the descriptions are equal.

/** Convert one comment token (`// …` or `/* … *\/`) into protoc's SourceCodeInfo text form. */
export const protocCommentText = (raw: string): string => {
  if (raw.startsWith("//")) {
    const body = raw.slice(2)
    return body.endsWith("\n") ? body : `${body}\n`
  }
  // block comment
  const inner = raw.slice(2, raw.endsWith("*/") ? -2 : undefined)
  const lines = inner.split("\n")
  const out = [lines[0]]
  for (let i = 1; i < lines.length; i++) {
    out.push(lines[i].replace(/^[ \t\v\f\r]*\*?/, ""))
  }
  return out.join("\n")
}

/** Join consecutive comment tokens of one group (consecutive `//` lines or one block). */
export const protocGroupText = (tokens: string[]): string => tokens.map(protocCommentText).join("")

/** Description text from protoc comment text (D15): doc-block marker line removed, common indentation stripped,
 *  horizontal whitespace runs collapsed, trailing whitespace removed, blank-line runs kept as one empty line. */
export const normalizeComment = (text: string | undefined): string | undefined => {
  if (!text) return undefined
  // fast path: one line without tabs or runs of spaces
  const nl = text.indexOf("\n")
  if ((nl < 0 || nl === text.length - 1) && !text.includes("\t") && !text.includes("  ") && !text.includes("\r")) {
    const line = (nl < 0 ? text : text.slice(0, nl)).trim()
    if (line && !/^\*+$/.test(line) && !line.startsWith("* ")) return line
  }
  const lines = text.replace(/\r/g, "").split("\n")
  if (lines.length && /^\*+[ \t]*$/.test(lines[0])) lines.shift()
  else if (lines.length && /^\*+[ \t]/.test(lines[0])) lines[0] = lines[0].replace(/^\*+/, "")
  // common indentation in columns (a tab advances to the next multiple of 4, buf's tab stop), so lines indented
  // with tabs and with spaces lose the same indentation (A-14)
  let indent = Number.POSITIVE_INFINITY
  for (const line of lines) {
    if (!line.trim()) continue
    indent = Math.min(indent, indentColumns(line))
  }
  if (!Number.isFinite(indent)) return undefined
  const out: string[] = []
  for (const line of lines) {
    const l = stripColumns(line, indent)
      .replace(/[ \t\v\f]+/g, " ")
      .replace(/\s+$/, "")
    if (!l && (!out.length || out[out.length - 1] === "")) continue
    out.push(l)
  }
  while (out.length && out[out.length - 1] === "") out.pop()
  return out.length ? out.join("\n") : undefined
}

const TAB_STOP = 4

/** Width of the leading spaces and tabs of a line, in columns. */
const indentColumns = (line: string): number => {
  let col = 0
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i)
    if (c === 32) col++
    else if (c === 9) col += TAB_STOP - (col % TAB_STOP)
    else break
  }
  return col
}

/** Remove `n` columns of leading spaces and tabs; a tab that reaches past column `n` is removed whole. */
const stripColumns = (line: string, n: number): string => {
  if (n === 0) return line
  let col = 0
  let i = 0
  while (i < line.length && col < n && (line[i] === " " || line[i] === "\t")) {
    col += line[i] === "\t" ? TAB_STOP - (col % TAB_STOP) : 1
    i++
  }
  return line.slice(i)
}

/** Split normalised text into lines; used by the annotation layer. */
export const descriptionLines = (text: string | undefined): string[] => (text ? text.split("\n") : [])
