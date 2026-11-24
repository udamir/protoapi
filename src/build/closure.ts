// Breadth-first walk over an import graph, shared by the builders' import closures and the binary path's bundled
// closure: every path is visited at most once, in the order it was first queued.

export class ImportClosure {
  private readonly queue: string[] = []
  private head = 0
  /** paths queued, visited or marked done */
  private readonly known = new Set<string>()

  /** `start`: the first paths to visit; `done`: paths that count as visited already. */
  constructor(start: Iterable<string>, done: Iterable<string> = []) {
    for (const path of done) this.known.add(path)
    for (const path of start) this.add(path)
  }

  /** Queue `path` unless it was queued, visited or marked done before. */
  add(path: string): void {
    if (this.known.has(path)) return
    this.known.add(path)
    this.queue.push(path)
  }

  /** `path` was queued, visited or marked done. */
  has(path: string): boolean {
    return this.known.has(path)
  }

  /** Mark `path` done without visiting it. */
  skip(path: string): void {
    this.known.add(path)
  }

  /** The next path to visit; undefined when the walk is complete. */
  next(): string | undefined {
    return this.head < this.queue.length ? this.queue[this.head++] : undefined
  }
}
