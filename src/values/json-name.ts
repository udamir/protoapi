// JSON names: protoc's default JSON name of a field (rule J) and the conversions between snake_case and lowerCamelCase.

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

/** snake_case -> lowerCamelCase (ProtoJSON keys of fields without a `json_name`, FieldMask paths). */
export const lowerCamel = (name: string): string => name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
