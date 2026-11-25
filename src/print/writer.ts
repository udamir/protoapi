// The printed lines of one file: indented statements, `//` comments, and the final text with blank lines between top-level declarations.

export class Writer {
  private readonly lines: string[] = []
  private readonly indent: string

  constructor(indent: string) {
    this.indent = indent
  }

  /** One line at `depth`; a `}` right after a `{` line closes the empty body on that line (`message A {}`). */
  emit(depth: number, text: string): void {
    const lines = this.lines
    const pad = this.indent.repeat(depth)
    const last = lines[lines.length - 1]
    if (text === "}" && last?.endsWith("{") && last.startsWith(pad) && !last.startsWith(`${pad}//`)) {
      lines[lines.length - 1] = `${last}}`
      return
    }
    lines.push(text ? `${pad}${text}` : "")
  }

  /** Comment lines at `depth` (undefined entries are skipped, multi-line entries split). */
  comment(depth: number, lines: (string | undefined)[]): void {
    for (const l of lines) {
      if (l === undefined) continue
      for (const part of l.split("\n")) this.emit(depth, part ? `// ${part}` : "//")
    }
  }

  /** The lines written so far; the writer is empty afterwards. */
  take(): string[] {
    return this.lines.splice(0)
  }
}

/** The text of a file: `header`, then `body` with a blank line between top-level declarations. */
export const fileText = (header: string[], body: string[], indent: string): string => {
  const out: string[] = []
  for (const l of body) {
    const prev = out[out.length - 1]
    const atTop = (x: string) => !!indent && !x.startsWith(indent)
    if (prev && l && atTop(l) && !l.startsWith("}") && atTop(prev) && prev.endsWith("}") && !prev.startsWith("//"))
      out.push("")
    out.push(l)
  }
  return `${[...header, ...out]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+$/, "")}\n`
}
