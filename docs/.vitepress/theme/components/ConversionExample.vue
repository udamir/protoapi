<script setup lang="ts">
import { withBase } from "vitepress"
import { computed, ref } from "vue"

import { data } from "../../../examples/examples.data.ts"

const props = defineProps<{ id: string }>()

const example = computed(() => {
  const found = data[props.id]
  if (!found) {
    throw new Error(`Unknown conversion example: ${props.id}`)
  }
  return found
})

const active = ref<string>("protoapi")
const panel = computed(() => example.value.panels.find((item) => item.id === active.value) ?? example.value.panels[0])

const ROUND_TRIP = {
  exact: { class: "ok", text: "✓ Lossless round trip" },
  conflicts: { class: "info", text: "Round trip equal without x-annotation-conflicts" },
  differs: { class: "warn", text: "Round trip normalizes the input" },
}

const DESCRIPTOR = {
  identical: { class: "ok", text: "✓ Identical to the buf FileDescriptorSet build" },
  different: { class: "warn", text: "Differs from the buf FileDescriptorSet build" },
  rejected: { class: "info", text: "buf rejects this input" },
  unavailable: { class: "info", text: "buf not available at build time" },
}
</script>

<template>
  <div class="conversion">
    <div class="bar">
      <div class="tabs" role="tablist">
        <button
          v-for="item in example.panels"
          :key="item.id"
          role="tab"
          :aria-selected="active === item.id"
          :class="{ active: active === item.id }"
          @click="active = item.id"
        >
          {{ item.label }}
        </button>
      </div>
    </div>
    <p v-if="panel.note" class="note"><code>{{ panel.note }}</code></p>
    <div class="code" v-html="panel.html" />
    <div class="facts">
      <span :class="['badge', ROUND_TRIP[example.roundTrip].class]">{{ ROUND_TRIP[example.roundTrip].text }}</span>
      <span :class="['badge', DESCRIPTOR[example.descriptor].class]">{{ DESCRIPTOR[example.descriptor].text }}</span>
      <a :class="['badge', example.issues ? 'warn' : 'ok']" :href="withBase('/guide/diagnostics')">
        {{ example.issues ? `${example.issues} build issues` : "✓ No build issues" }}
      </a>
      <span class="links">
        <a :href="withBase(`/spec/v0.1#${example.spec}`)">Specification</a>
        <a :href="withBase(`/demo#${example.demo}`)">Open in demo →</a>
      </span>
    </div>
  </div>
</template>

<style scoped>
.conversion {
  margin: 16px 0 32px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  overflow: hidden;
  background: var(--vp-c-bg-soft);
}

.bar {
  padding: 8px;
  border-bottom: 1px solid var(--vp-c-divider);
  overflow-x: auto;
}

.tabs {
  display: flex;
  gap: 4px;
  width: max-content;
}

.tabs button {
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

.tabs button:hover {
  color: var(--vp-c-text-1);
}

.tabs button.active {
  color: var(--vp-c-brand-1);
  background: var(--vp-c-bg);
  box-shadow: var(--vp-shadow-1);
}

.note {
  margin: 0 !important;
  padding: 8px 16px 0;
  font-size: 12px;
  line-height: 1.5;
}

.note code {
  font-size: 12px !important;
  background: transparent !important;
  padding: 0 !important;
  color: var(--vp-c-text-2);
}

.code {
  max-height: 560px;
  overflow: auto;
}

.code :deep(.file-name) {
  padding: 10px 16px 0;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--vp-c-text-2);
}

.code :deep(div[class*="language-"]) {
  margin: 8px 0 0 !important;
  border-radius: 0 !important;
}

.facts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--vp-c-divider);
  font-size: 12px;
}

.badge {
  padding: 2px 10px;
  border-radius: 999px;
  font-weight: 500;
}

a.badge {
  text-decoration: none;
}

.badge.ok {
  color: var(--vp-c-green-1);
  background: var(--vp-c-green-soft);
}

.badge.info {
  color: var(--vp-c-indigo-1);
  background: var(--vp-c-indigo-soft);
}

.badge.warn {
  color: var(--vp-c-yellow-1);
  background: var(--vp-c-yellow-soft);
}

.links {
  display: flex;
  gap: 14px;
  margin-left: auto;
}

.links a {
  font-weight: 500;
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.links a:hover {
  text-decoration: underline;
}
</style>
