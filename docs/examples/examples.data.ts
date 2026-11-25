/**
 * Renders every example through every conversion at build time, so the examples page always shows the output of the
 * current sources.
 */
import { createMarkdownRenderer, defineLoader } from "vitepress"

import { buildFromDescriptorSet, buildFromProto, printProto } from "../../src/index.ts"
import { bufImage, displayImage } from "../.vitepress/theme/buf.ts"
import { CASES } from "../.vitepress/theme/cases.ts"
import {
  DEFAULT_OPTIONS,
  encodeState,
  formatIssue,
  formatSourceMap,
  optionsCode,
  serialize,
  withoutConflicts,
} from "../.vitepress/theme/convert.ts"

export interface ExamplePanel {
  id: string
  label: string
  /** highlighted HTML of the code block(s) */
  html: string
  note?: string
}

export interface Example {
  id: string
  title: string
  spec: string
  demo: string
  panels: ExamplePanel[]
  /** build(print(build(x))) equals build(x): "exact", "conflicts" (equal without x-annotation-conflicts) or "differs" */
  roundTrip: "exact" | "conflicts" | "differs"
  /** the build from buf's FileDescriptorSet equals the build from the text: "identical", "different" or the buf error */
  descriptor: "identical" | "different" | "rejected" | "unavailable"
  issues: number
}

declare const data: Record<string, Example>
export { data }

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export default defineLoader({
  watch: ["../.vitepress/theme/*.ts", "../../src/**/*.ts"],
  async load(): Promise<Record<string, Example>> {
    const md = await createMarkdownRenderer(process.cwd())
    // VitePress highlights code asynchronously, so `render` would leave the blocks unhighlighted
    const code = (language: string, text: string): Promise<string> =>
      md.renderAsync(`\`\`\`${language}\n${text.trimEnd()}\n\`\`\`\n`)
    // several files in one panel, each under its path
    const files = async (texts: Record<string, string>): Promise<string> => {
      const parts = await Promise.all(
        Object.entries(texts).map(
          async ([path, text]) => `<div class="file-name">${path}</div>${await code("proto", text)}`,
        ),
      )
      return parts.join("")
    }

    const result: Record<string, Example> = {}
    for (const item of CASES) {
      const options = item.options ?? {}
      const built = buildFromProto(item.files, options)
      const printed = printProto(built.document)
      const rebuilt = buildFromProto(printed, options).document
      const image = bufImage(item)
      const call = `buildFromProto(files${optionsCode(options)})`

      const panels: ExamplePanel[] = [
        { id: "proto", label: ".proto", html: await files(item.files) },
        {
          id: "protoapi",
          label: "ProtoApi",
          html: await code("yaml", serialize(built.document, "yaml")),
          note: `${call}.document`,
        },
      ]
      if ("image" in image) {
        panels.push({
          id: "descriptor",
          label: "FileDescriptorSet",
          html: await code("json", serialize(displayImage(image.image), "json")),
          note: "buf build -o image.json — the example's files, without sourceCodeInfo; buildFromDescriptorSet(image) gives the same document",
        })
      }
      panels.push(
        {
          id: "sourcemap",
          label: "Source map",
          html: await code("yaml", formatSourceMap(built.sourceMap, Object.keys(item.files))),
          note: `${call}.sourceMap — pointer: file line:column-line:column, 1-based here (zero-based in the map)`,
        },
        { id: "printed", label: "Back to .proto", html: await files(printed), note: "printProto(document)" },
      )
      if (built.issues.length) {
        panels.push({
          id: "issues",
          label: `Issues (${built.issues.length})`,
          html: await code("text", built.issues.map(formatIssue).join("\n")),
          note: `${call}.issues`,
        })
      }

      result[item.id] = {
        id: item.id,
        title: item.title,
        spec: item.spec,
        demo: encodeState({
          source: "proto",
          target: "protoapi",
          format: "yaml",
          files: item.files,
          options: { ...DEFAULT_OPTIONS, ...(item.options?.entry ? { entry: item.options.entry } : {}) },
        }),
        roundTrip: same(rebuilt, built.document)
          ? "exact"
          : same(withoutConflicts(rebuilt), withoutConflicts(built.document))
            ? "conflicts"
            : "differs",
        descriptor:
          "image" in image
            ? same(buildFromDescriptorSet(image.image, options).document, built.document)
              ? "identical"
              : "different"
            : image.error === "the buf CLI is not installed"
              ? "unavailable"
              : "rejected",
        issues: built.issues.length,
        panels,
      }
    }
    return result
  },
})
