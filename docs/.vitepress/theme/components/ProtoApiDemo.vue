<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"

import { buildFromProto, type BuildIssue } from "../../../../src/index"
import { data as images } from "../../../examples/images.data"
import { CASES } from "../cases"
import {
  DEFAULT_OPTIONS,
  SOURCES,
  TARGETS,
  buildOptions,
  convert,
  decodeState,
  encodeState,
  formatIssue,
  serialize,
  type AnnotationsMode,
  type Conversion,
  type DemoOptions,
  type ImportsMode,
  type Language,
  type SourceKind,
  type TargetKind,
  type TextFormat,
} from "../convert"
import CodeEditor from "./CodeEditor.vue"

const source = ref<SourceKind>("proto")
const target = ref<TargetKind>("protoapi")
const format = ref<TextFormat>("yaml")
const preset = ref<string>(CASES[0].id)
const imports = ref<ImportsMode>(DEFAULT_OPTIONS.imports)
const annotations = ref<AnnotationsMode>(DEFAULT_OPTIONS.annotations)
/** entry files of the `.proto` input; undefined means every file */
const entry = ref<string[] | undefined>()

/** the `.proto` input: path -> text, and the file shown in the editor */
const files = ref<Record<string, string>>({})
const activeFile = ref("")
/** the single-text inputs */
const texts = ref<Record<"descriptor" | "protoapi", string>>({ descriptor: "", protoapi: "" })
const flash = ref("")
const inputEditor = ref<InstanceType<typeof CodeEditor>>()

const presetCase = (id: string) => CASES.find((item) => item.id === id) ?? CASES[0]

const options = computed<DemoOptions>(() => ({
  imports: imports.value,
  annotations: annotations.value,
  entry: entry.value,
}))

/** The preset in the form a single-text source expects */
const presetText = (kind: "descriptor" | "protoapi", id: string): string => {
  const item = presetCase(id)
  if (kind === "descriptor") {
    const image = images[item.id]
    return image && "image" in image ? image.image : ""
  }
  return serialize(
    buildFromProto(item.files, buildOptions({ ...DEFAULT_OPTIONS, entry: item.options?.entry })).document,
    "yaml",
  )
}

const loadPreset = (id: string) => {
  if (!id) {
    return
  }
  const item = presetCase(id)
  files.value = { ...item.files }
  activeFile.value = Object.keys(item.files).at(-1) ?? ""
  entry.value = item.options?.entry ? [...item.options.entry] : undefined
  texts.value = { descriptor: presetText("descriptor", id), protoapi: "" }
  if (source.value === "protoapi") {
    texts.value.protoapi = presetText("protoapi", id)
  }
}

const singleText = computed({
  get: () => (source.value === "proto" ? "" : texts.value[source.value]),
  set: (text: string) => {
    if (source.value !== "proto") texts.value[source.value] = text
  },
})

const editorText = computed({
  get: () => (source.value === "proto" ? files.value[activeFile.value] ?? "" : singleText.value),
  set: (text: string) => {
    if (source.value === "proto") {
      files.value = { ...files.value, [activeFile.value]: text }
    } else {
      singleText.value = text
    }
  },
})

const inputFiles = computed<Record<string, string>>(() =>
  source.value === "proto" ? files.value : { input: texts.value[source.value] },
)
const inputEmpty = computed(() => !Object.values(inputFiles.value).some((text) => text.trim()))

// conversions run on a debounced copy of the input, so typing into a large document stays responsive
const settled = ref<{ files: Record<string, string>; options: DemoOptions }>({ files: {}, options: DEFAULT_OPTIONS })
let timer: ReturnType<typeof setTimeout> | undefined
watch(
  [inputFiles, options],
  ([value, opts]) => {
    clearTimeout(timer)
    timer = setTimeout(() => (settled.value = { files: value, options: opts }), 150)
  },
  { immediate: true, deep: true },
)

const hint = computed(() => {
  if (source.value === "descriptor" && !texts.value.descriptor.trim()) {
    const image = images[presetCase(preset.value).id]
    return image && "error" in image
      ? `There is no FileDescriptorSet for this example: buf rejects it.\n\n${image.error}`
      : "Paste a FileDescriptorSet in ProtoJSON, for example the output of `buf build -o image.json`."
  }
  return ""
})

const result = computed<Conversion | { error: string }>(() => {
  if (!Object.values(settled.value.files).some((text) => text.trim())) {
    return { error: hint.value }
  }
  try {
    return convert({
      source: source.value,
      files: settled.value.files,
      target: target.value,
      format: format.value,
      options: settled.value.options,
    })
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
const conversion = computed(() => ("outputs" in result.value ? result.value : undefined))
const error = computed(() => ("error" in result.value ? result.value.error : ""))
const outputNames = computed(() => Object.keys(conversion.value?.outputs ?? {}))
const activeOutput = ref("")
watch(outputNames, (names) => {
  if (!names.includes(activeOutput.value)) activeOutput.value = names.at(-1) ?? ""
})
const output = computed(() => conversion.value?.outputs[activeOutput.value] ?? "")
const outputLanguage = computed<Language>(() => conversion.value?.language ?? "yaml")
const issues = computed<BuildIssue[]>(() => conversion.value?.issues ?? [])

const sourceMeta = computed(() => SOURCES.find((item) => item.id === source.value)!)
const targetMeta = computed(() => TARGETS.find((item) => item.id === target.value)!)
const buildsDocument = computed(() => !(source.value === "protoapi" && target.value === "proto"))
const multiFileOutput = computed(() => target.value === "proto")

const lines = computed(() => (output.value ? output.value.trimEnd().split("\n").length : 0))

watch(source, (kind) => {
  if (kind !== "proto" && !texts.value[kind]) {
    texts.value[kind] = presetText(kind, preset.value || CASES[0].id)
  }
})

watch(preset, loadPreset)

const notify = (message: string) => {
  flash.value = message
  setTimeout(() => (flash.value = ""), 1800)
}

// ---- files of the .proto input

const isEntry = (path: string) => !entry.value || entry.value.includes(path)

const toggleEntry = (path: string) => {
  const current = entry.value ?? Object.keys(files.value)
  const next = current.includes(path) ? current.filter((item) => item !== path) : [...current, path]
  entry.value = next.length === Object.keys(files.value).length ? undefined : next
}

const addFile = () => {
  const path = prompt("Import path of the new file", "new.proto")?.trim()
  if (!path) return
  if (!(path in files.value)) {
    files.value = { ...files.value, [path]: 'syntax = "proto3";\n' }
    if (entry.value) entry.value = [...entry.value, path]
  }
  activeFile.value = path
}

const renameFile = (path: string) => {
  const next = prompt("Rename the file (import path)", path)?.trim()
  if (!next || next === path || next in files.value) return
  files.value = Object.fromEntries(Object.entries(files.value).map(([key, text]) => [key === path ? next : key, text]))
  if (entry.value) entry.value = entry.value.map((item) => (item === path ? next : item))
  activeFile.value = next
}

const removeFile = (path: string) => {
  const { [path]: _removed, ...rest } = files.value
  files.value = rest
  if (entry.value) entry.value = entry.value.filter((item) => item !== path)
  if (activeFile.value === path) activeFile.value = Object.keys(rest).at(-1) ?? ""
}

/** Jumps to the location of an issue in the `.proto` input */
const showIssue = (issue: BuildIssue) => {
  const location = issue.location
  if (source.value !== "proto" || !location || !(location.file in files.value)) return
  activeFile.value = location.file
  // the editor shows the new file after the next render
  setTimeout(() => inputEditor.value?.select(location.start, location.end))
}

const canShow = (issue: BuildIssue) =>
  source.value === "proto" && !!issue.location && issue.location.file in files.value

// ---- output actions

/** Continue with the output: it becomes the input, and the conversion goes the other way */
const useAsInput = () => {
  if (!conversion.value || target.value === "sourcemap") {
    return
  }
  if (target.value === "proto") {
    files.value = { ...conversion.value.outputs }
    activeFile.value = activeOutput.value
    entry.value = undefined
    source.value = "proto"
    target.value = "protoapi"
  } else {
    texts.value.protoapi = output.value
    source.value = "protoapi"
    target.value = "proto"
  }
}

const copy = async () => {
  await navigator.clipboard.writeText(output.value)
  notify("Output copied")
}

const download = () => {
  const name =
    target.value === "proto"
      ? activeOutput.value.split("/").at(-1) ?? "protoapi.proto"
      : target.value === "protoapi"
        ? `protoapi.${format.value}`
        : "sourcemap.yaml"
  const url = URL.createObjectURL(new Blob([output.value], { type: "text/plain" }))
  const link = Object.assign(document.createElement("a"), { href: url, download: name })
  link.click()
  URL.revokeObjectURL(url)
}

const share = async () => {
  const hash = encodeState({
    source: source.value,
    target: target.value,
    format: format.value,
    files: inputFiles.value,
    options: options.value,
  })
  const url = `${location.origin}${location.pathname}#${hash}`
  history.replaceState(null, "", url)
  await navigator.clipboard.writeText(url)
  notify("Link copied")
}

const reset = () => {
  if (source.value === "proto") {
    loadPreset(preset.value || CASES[0].id)
  } else {
    texts.value[source.value] = presetText(source.value, preset.value || CASES[0].id)
  }
}

const clear = () => {
  if (source.value === "proto") {
    files.value = { [activeFile.value || "example.proto"]: "" }
    activeFile.value = Object.keys(files.value)[0]
    entry.value = undefined
  } else {
    texts.value[source.value] = ""
  }
}

onMounted(() => {
  const state = location.hash.length > 1 ? decodeState(location.hash.slice(1)) : undefined
  if (!state) {
    loadPreset(preset.value)
    return
  }
  // a shared link (or an "Open in demo" link of the examples) wins over the preset
  source.value = state.source
  target.value = state.target
  format.value = state.format
  imports.value = state.options?.imports ?? DEFAULT_OPTIONS.imports
  annotations.value = state.options?.annotations ?? DEFAULT_OPTIONS.annotations
  entry.value = state.options?.entry
  const same = (item: (typeof CASES)[number]) => JSON.stringify(item.files) === JSON.stringify(state.files)
  preset.value = state.source === "proto" ? CASES.find(same)?.id ?? "" : ""
  if (state.source === "proto") {
    files.value = { ...state.files }
    activeFile.value = Object.keys(state.files).at(-1) ?? ""
  } else {
    texts.value = { descriptor: "", protoapi: "", [state.source]: Object.values(state.files)[0] ?? "" }
  }
})
</script>

<template>
  <div class="demo">
    <div class="toolbar">
      <div class="group">
        <span class="caption">From</span>
        <div class="segmented" role="radiogroup" aria-label="Convert from">
          <button
            v-for="item in SOURCES"
            :key="item.id"
            role="radio"
            :aria-checked="source === item.id"
            :class="{ active: source === item.id }"
            @click="source = item.id"
          >
            {{ item.label }}
          </button>
        </div>
      </div>
      <div class="group">
        <span class="caption">To</span>
        <div class="segmented" role="radiogroup" aria-label="Convert to">
          <button
            v-for="item in TARGETS"
            :key="item.id"
            role="radio"
            :aria-checked="target === item.id"
            :class="{ active: target === item.id }"
            @click="target = item.id"
          >
            {{ item.label }}
          </button>
        </div>
      </div>
      <div class="group selects">
        <label>
          Example
          <select v-model="preset">
            <option v-if="!preset" value="" disabled>Shared input</option>
            <option v-for="item in CASES" :key="item.id" :value="item.id">{{ item.title }}</option>
          </select>
        </label>
        <label v-if="buildsDocument" title="BuildOptions.imports: which declarations of imported files are emitted">
          imports
          <select v-model="imports">
            <option value="user">user</option>
            <option value="referenced">referenced</option>
            <option value="all">all</option>
          </select>
        </label>
        <label v-if="buildsDocument" title="BuildOptions.annotations: what the annotation layer lifts into keywords">
          annotations
          <select v-model="annotations">
            <option value="all">all</option>
            <option value="options">options</option>
            <option value="none">none</option>
          </select>
        </label>
        <label v-if="target === 'protoapi'">
          Format
          <select v-model="format">
            <option value="yaml">YAML</option>
            <option value="json">JSON</option>
          </select>
        </label>
      </div>
    </div>

    <div class="panes">
      <section class="pane">
        <header>
          <span>{{ sourceMeta.label }}</span>
          <span class="actions">
            <button class="link" @click="reset">Reset</button>
            <button class="link" :disabled="inputEmpty" @click="clear">Clear</button>
          </span>
        </header>
        <div v-if="source === 'proto'" class="files" role="tablist" aria-label="Input files">
          <span
            v-for="path in Object.keys(files)"
            :key="path"
            :class="['file', { active: activeFile === path, imported: !isEntry(path) }]"
          >
            <button
              role="tab"
              :aria-selected="activeFile === path"
              :title="`${path}${isEntry(path) ? ' (entry file)' : ' (imported only)'} — double-click to rename`"
              @click="activeFile = path"
              @dblclick="renameFile(path)"
            >
              {{ path }}
            </button>
            <button
              v-if="Object.keys(files).length > 1"
              class="remove"
              :aria-label="`Remove ${path}`"
              @click="removeFile(path)"
            >
              ×
            </button>
          </span>
          <button class="add" title="Add a file" @click="addFile">+ File</button>
          <label v-if="activeFile && Object.keys(files).length > 1" class="entry">
            <input type="checkbox" :checked="isEntry(activeFile)" @change="toggleEntry(activeFile)" />
            entry file
          </label>
        </div>
        <CodeEditor
          ref="inputEditor"
          v-model="editorText"
          :language="sourceMeta.language"
          :label="`${sourceMeta.label} input`"
        />
      </section>

      <section class="pane">
        <header>
          <span>
            {{ targetMeta.label }}<small v-if="lines"> · {{ lines }} lines</small>
            <span v-if="conversion && buildsDocument" :class="['count', { problems: issues.length }]">
              {{ issues.length ? `${issues.length} issues` : "✓ no issues" }}
            </span>
          </span>
          <span class="actions">
            <span v-if="flash" class="flash" role="status">{{ flash }}</span>
            <button
              class="link"
              :disabled="!output || target === 'sourcemap'"
              title="Make the output the input"
              @click="useAsInput"
            >
              ⇄ Use as input
            </button>
            <button class="link" :disabled="!output" @click="copy">Copy</button>
            <button class="link" :disabled="!output" @click="download">Download</button>
            <button class="link" :disabled="inputEmpty" @click="share">Share</button>
          </span>
        </header>
        <div v-if="multiFileOutput && outputNames.length > 1 && !error" class="files" role="tablist" aria-label="Output files">
          <span v-for="name in outputNames" :key="name" :class="['file', { active: activeOutput === name }]">
            <button role="tab" :aria-selected="activeOutput === name" @click="activeOutput = name">{{ name }}</button>
          </span>
        </div>
        <pre v-if="error" :class="['error', { hint: error === hint }]" role="alert">{{ error }}</pre>
        <CodeEditor
          v-else
          :model-value="output"
          :language="outputLanguage"
          readonly
          :label="`${targetMeta.label} output`"
        />
      </section>
    </div>

    <div v-if="conversion" class="code-line">
      <code>{{ conversion.code }}</code>
      <p v-for="note in conversion.notes" :key="note" class="note">{{ note }}</p>
    </div>

    <div v-if="issues.length" class="issues">
      <h2>Build issues</h2>
      <ul>
        <li v-for="(issue, index) in issues" :key="index">
          <button v-if="canShow(issue)" class="issue" title="Show in the input" @click="showIssue(issue)">
            <code>{{ issue.code }}</code> {{ formatIssue(issue).slice(issue.code.length + 1) }}
          </button>
          <span v-else class="issue"><code>{{ issue.code }}</code> {{ formatIssue(issue).slice(issue.code.length + 1) }}</span>
          <small v-if="issue.pointer" class="pointer">{{ issue.pointer }}</small>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.demo {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 20px;
}

.group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.caption {
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-text-2);
}

.segmented {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 3px;
  border-radius: 9px;
  background: var(--vp-c-bg-soft);
}

.segmented button {
  padding: 5px 12px;
  border-radius: 7px;
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  color: var(--vp-c-text-2);
  transition:
    color 0.2s,
    background-color 0.2s;
}

.segmented button:hover {
  color: var(--vp-c-text-1);
}

.segmented button.active {
  color: var(--vp-c-brand-1);
  background: var(--vp-c-bg);
  box-shadow: var(--vp-shadow-1);
}

.selects {
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-left: auto;
  font-size: 13px;
  color: var(--vp-c-text-2);
}

.selects select {
  margin-left: 6px;
  padding: 3px 8px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
}

.panes {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
  height: calc(100vh - var(--vp-nav-height) - 260px);
  min-height: 520px;
}

@media (max-width: 960px) {
  .group {
    flex-wrap: wrap;
  }

  .selects {
    margin-left: 0;
  }

  .panes {
    grid-template-columns: minmax(0, 1fr);
    height: auto;
  }

  .pane {
    height: 460px;
  }
}

.pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  overflow: hidden;
  background: var(--vp-code-block-bg);
}

.pane header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--vp-c-divider);
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-text-2);
}

.pane header small {
  font-weight: 400;
}

.files {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--vp-c-divider);
  font-size: 12px;
}

.file {
  display: inline-flex;
  align-items: center;
  border-radius: 6px;
  font-family: var(--vp-font-family-mono);
  color: var(--vp-c-text-2);
}

.file button {
  padding: 3px 8px;
}

.file.active {
  color: var(--vp-c-brand-1);
  background: var(--vp-c-bg);
  box-shadow: var(--vp-shadow-1);
}

.file.imported button:first-child {
  font-style: italic;
  opacity: 0.8;
}

.file .remove {
  padding: 3px 6px 3px 0;
  color: var(--vp-c-text-3);
}

.file .remove:hover {
  color: var(--vp-c-danger-1);
}

.add {
  padding: 3px 8px;
  font-weight: 500;
  color: var(--vp-c-brand-1);
}

.entry {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  color: var(--vp-c-text-2);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 14px;
}

.link {
  font-size: 13px;
  font-weight: 500;
  color: var(--vp-c-brand-1);
}

.link:disabled {
  color: var(--vp-c-text-3);
  cursor: default;
}

.count {
  margin-left: 8px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  color: var(--vp-c-green-1);
  background: var(--vp-c-green-soft);
}

.count.problems {
  color: var(--vp-c-yellow-1);
  background: var(--vp-c-yellow-soft);
}

.flash {
  font-weight: 500;
  color: var(--vp-c-green-1);
}

.error {
  flex: 1;
  margin: 0;
  padding: 12px 14px;
  overflow: auto;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  color: var(--vp-c-danger-1);
}

.error.hint {
  color: var(--vp-c-text-2);
}

.code-line {
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
  font-size: 13px;
  overflow-x: auto;
}

.code-line code {
  font-family: var(--vp-font-family-mono);
  color: var(--vp-c-text-1);
  white-space: pre;
}

.note {
  margin: 6px 0 0;
  color: var(--vp-c-text-2);
}

.issues {
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--vp-c-yellow-soft);
  font-size: 13px;
}

.issues h2 {
  margin: 0 0 6px;
  padding: 0;
  border: none;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
}

.issues ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

.issues li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 10px;
  padding: 2px 0;
}

.issue {
  text-align: left;
  color: var(--vp-c-text-1);
}

button.issue:hover {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
}

.issue code {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  font-weight: 600;
}

.pointer {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  color: var(--vp-c-text-2);
}
</style>
