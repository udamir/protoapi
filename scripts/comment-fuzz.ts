// Differential comment fuzz against buf (IN-10, Q0-P phase C): random comment layouts around every declaration
// boundary, compared with the SourceCodeInfo of a buf build. Dev only: needs the buf CLI from devDependencies.
//
//   bun run scripts/comment-fuzz.ts             # writes test/fixtures/named/comments-fuzz/fuzz.proto (seed 1);
//                                               # record its image with `bun run images named/comments-fuzz`
//   bun run scripts/comment-fuzz.ts check 200   # builds 200 random files (seeds 1..200) with buf and compares

import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { compareComments, isElementPath } from "../test/parser/sci"

const ROOT = join(import.meta.dir, "..")

/** Deterministic PRNG (mulberry32). */
const prng = (seed: number) => {
  let s = seed
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A `.proto` file with random whitespace and comments at the start, after every `;`, `{` and `}`, before every `}`, at the end, and sometimes inside declarations. */
export function fuzzFile(seed: number, elements = 12): string {
  const rnd = prng(seed)
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]
  let n = 0
  const piece = (eof: boolean): string => {
    const id = `c${++n}`
    return pick([
      " ",
      "\n",
      "\n",
      "\n\n",
      `// ${id}\n`,
      `// ${id}\n`,
      `// ${id}\n`,
      `/* ${id} */`,
      `/* ${id} */`,
      `/* ${id}\n   * more ${id} */`,
      `/** ${id} */`,
      eof ? `// ${id}` : `// ${id}\n`,
    ])
  }
  const gap = (eof = false): string => {
    let out = ""
    const k = Math.floor(rnd() * 6)
    for (let i = 0; i < k; i++) out += piece(eof && i === k - 1)
    return out
  }
  // inside a declaration: nothing, a space, a newline, or a block comment
  const inner = (): string => pick([" ", " ", " ", " ", "\n  ", ` /* i${++n} */ `])
  let field = 0
  const fieldDecl = (): string => `int32${inner()}f${++field}${inner()}= ${field};`
  const body = (decls: string[]): string => `{${gap()}${decls.map((d) => `${d}${gap()}`).join("")}}`
  const message = (depth: number): string => {
    const decls: string[] = []
    const k = 1 + Math.floor(rnd() * 4)
    for (let i = 0; i < k; i++) {
      const r = rnd()
      if (depth < 2 && r < 0.15) decls.push(message(depth + 1))
      else if (depth < 2 && r < 0.25) decls.push(enumDecl())
      else if (r < 0.32) decls.push(`oneof${inner()}o${++n} ${body([fieldDecl(), fieldDecl()])}`)
      else decls.push(fieldDecl())
    }
    return `message${inner()}M${++n} ${body(decls)}`
  }
  const enumDecl = (): string => {
    const name = `E${++n}`
    const k = 1 + Math.floor(rnd() * 3)
    return `enum ${name} ${body(Array.from({ length: k }, (_, i) => `${name}_${i}${inner()}= ${i};`))}`
  }
  const service = (): string => {
    const k = 1 + Math.floor(rnd() * 3)
    const rpcs = Array.from({ length: k }, () =>
      rnd() < 0.7
        ? `rpc R${++n}(F) returns${inner()}(F);`
        : `rpc R${++n}(F) returns (F) ${body(rnd() < 0.5 ? [] : ["option deprecated = true;"])}`,
    )
    return `service S${++n} ${body(rpcs)}`
  }
  const top = [`syntax = "proto3";`, `package fuzz.s${seed};`, "message F {}"]
  for (let i = 0; i < elements; i++) {
    const r = rnd()
    top.push(r < 0.6 ? message(0) : r < 0.8 ? enumDecl() : service())
  }
  const text = `${gap()}${top.map((d) => `${d}${gap()}`).join("")}${gap(true)}`
  // every fifth file with CRLF line endings and tab indentation
  return seed % 5 ? text : text.replace(/\n/g, "\r\n").replace(/ {2}/g, "\t")
}

if (import.meta.main) {
  if (process.argv[2] === "check") {
    const count = Number(process.argv[3] ?? 100)
    const work = join(ROOT, ".tmp", "comment-fuzz")
    rmSync(work, { recursive: true, force: true })
    mkdirSync(join(work, "src"), { recursive: true })
    writeFileSync(
      join(work, "buf.yaml"),
      "version: v2\nmodules:\n  - path: src\nlint:\n  use: []\nbreaking:\n  use: []\n",
    )
    const texts: string[] = []
    for (let seed = 1; seed <= count; seed++) {
      texts.push(fuzzFile(seed))
      writeFileSync(join(work, "src", `f${seed}.proto`), texts[seed - 1])
    }
    const out = join(work, "image.json")
    const res = spawnSync(join(ROOT, "node_modules", ".bin", "buf"), ["build", "-o", out], {
      cwd: work,
      encoding: "utf8",
    })
    if (res.status !== 0) throw new Error(res.stderr)
    const files = JSON.parse(readFileSync(out, "utf8")).file as { name: string; sourceCodeInfo: { location: [] } }[]
    let failed = 0
    let declarations = 0
    for (const f of files) {
      const seed = Number(f.name.slice(1, -6))
      const diffs = compareComments(texts[seed - 1], f.sourceCodeInfo.location)
      declarations += f.sourceCodeInfo.location.filter((l: { path?: number[] }) => isElementPath(l.path ?? [])).length
      if (diffs.length) {
        failed++
        console.log(`seed ${seed} (${f.name}):\n  ${diffs.slice(0, 5).join("\n  ")}`)
      }
    }
    console.log(`${files.length} files, ${declarations} declarations, ${failed} files with differences`)
    process.exit(failed ? 1 : 0)
  } else {
    const dir = join(ROOT, "test", "fixtures", "named", "comments-fuzz")
    mkdirSync(dir, { recursive: true })
    const header =
      "// Differential comment fuzz (IN-10, Q0-P phase C): generated by `bun run scripts/comment-fuzz.ts` (seed 1), image recorded with buf 1.75.0.\n\n"
    writeFileSync(join(dir, "fuzz.proto"), header + fuzzFile(1, 200))
    console.log(`wrote ${join(dir, "fuzz.proto")}`)
  }
}
