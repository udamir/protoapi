// File path normalisation (D12): posix separators, no leading `./`, `..` and `.` segments resolved.

export const normalizePath = (path: string): string => {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue
    if (part === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop()
    else parts.push(part)
  }
  return parts.join("/")
}

/** Escape a key for use as a JSON Pointer segment (RFC 6901). */
export const ptr = (segment: string | number): string => {
  const s = String(segment)
  return s.includes("~") || s.includes("/") ? s.replace(/~/g, "~0").replace(/\//g, "~1") : s
}

export const join = (...segments: (string | number)[]): string => segments.map(ptr).join("/")
