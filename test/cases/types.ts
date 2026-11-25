// Inline test cases with a buf oracle (phase B). Each case module under test/cases/ exports `cases: Case[]`;
// `node scripts/case-images.ts` builds every case with buf 1.75 and records the image (buf accepts) or buf's error
// (buf rejects) in test/images/cases/<module>.json, which the test files read.

import type { expect } from "vite-plus/test"
import type { BuildResult, TextBuildOptions } from "../../src/index.ts"

export interface Case {
  /** stable id, e.g. "PB-4.1" */
  id: string
  title: string
  sources: Record<string, string>
  /** the files built (buf `--path`, and the `entry` of both producers); default: every source */
  entry?: string[]
  /** build options of both producers (`tabWidth` applies to the text producer only) */
  options?: TextBuildOptions
  /**
   * buf rejects the input: a substring of buf's error, which the recorded oracle must contain. Absent: buf accepts
   * the input and the case is a conformance test (text document and source map equal the descriptor build).
   */
  buf?: string
  /** the text build's issues as `code @ pointer` (order-insensitive, exact); default: none */
  issues?: string[]
  /** further assertions on the text build */
  check?: (text: BuildResult, x: typeof expect) => void
  /** the descriptor build of the buf image differs on purpose (documented here); skip the document comparison */
  noConformance?: string
  /**
   * buf accepts the input: the descriptor build's issues as `code @ pointer` (default: none). Issues of the shared
   * lowering (annotation tags and conflicts, unknown option fields) are reported by both producers (phase C).
   */
  descriptorIssues?: string[]
  /** buf accepts the input: further assertions on the descriptor build of the buf image */
  descriptorCheck?: (descriptor: BuildResult, x: typeof expect) => void
}

export interface CaseOracle {
  /** buf's image (ProtoJSON, bundled files removed: the descriptor producer takes them from the bundle) */
  image?: { file: Record<string, unknown>[] }
  /** buf's error output when it rejects the input */
  error?: string
}
