/**
 * The buf image of every example, as ProtoJSON text: the online demo offers them as FileDescriptorSet inputs.
 * Built at build time with the buf CLI; an example buf rejects has the error instead.
 */
import { defineLoader } from "vitepress"

import { bufImage } from "../.vitepress/theme/buf.ts"
import { CASES } from "../.vitepress/theme/cases.ts"

export type ImageTexts = Record<string, { image: string } | { error: string }>

declare const data: ImageTexts
export { data }

export default defineLoader({
  watch: ["../.vitepress/theme/cases.ts"],
  load(): ImageTexts {
    const result: ImageTexts = {}
    for (const item of CASES) {
      const image = bufImage(item)
      result[item.id] = "image" in image ? { image: `${JSON.stringify(image.image, null, 2)}\n` } : image
    }
    return result
  },
})
