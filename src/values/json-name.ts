// JSON names: protoc's default JSON name of a field (rule J) and the snake_case form of a ProtoJSON key.

/** protoc's default JSON name (rule J). */
export const defaultJsonName = (name: string): string => {
  let out = ""
  let upper = false
  for (const ch of name) {
    if (ch === "_") upper = true
    else if (upper) {
      out += ch.toUpperCase()
      upper = false
    } else out += ch
  }
  return out
}

/** lowerCamelCase -> snake_case (generic rule for unknown definitions). */
export const toSnake = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
