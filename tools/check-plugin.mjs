/**
 * Check a DSH plugin bundle before loading it.
 *
 * The failure this catches: `ctx.tools.register()` forwards `parameters`
 * verbatim to the model API, so a "property map" ( { code: { type: 'string' } } )
 * ships a schema without an object root. The model then rejects EVERY turn with
 *
 *   Invalid schema for function 'gee_eval':
 *   schema must be a JSON Schema of 'type: "object"', got 'type: null'.  (400)
 *
 * Run: node scripts/check-plugin.mjs [plugin-dir]
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ALLOWED = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
  '$comment',
  'deprecated',
  'readOnly',
  'writeOnly',
]);
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'json']);

const problems = [];

function checkNode(node, where) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    problems.push(`${where}: must be a schema object`);
    return;
  }
  for (const key of Object.keys(node)) {
    if (!ALLOWED.has(key)) {
      problems.push(
        `${where}: unsupported keyword "${key}" — a bare property map belongs under parameters.properties, not at the root`,
      );
    }
  }
  if (Object.hasOwn(node, 'type')) {
    if (!TYPES.has(node.type)) problems.push(`${where}.type: unsupported value ${JSON.stringify(node.type)}`);
  }
  if (Object.hasOwn(node, 'properties')) {
    if (node.type !== 'object') problems.push(`${where}: "properties" requires type: 'object'`);
    for (const [key, child] of Object.entries(node.properties)) checkNode(child, `${where}.properties.${key}`);
  }
  if (Object.hasOwn(node, 'required')) {
    if (!Array.isArray(node.required) || node.required.some((key) => typeof key !== 'string')) {
      problems.push(`${where}.required: must be an array of strings`);
    }
  }
  if (Object.hasOwn(node, 'items')) checkNode(node.items, `${where}.items`);
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    problems.push(`${where}.additionalProperties: must be a boolean`);
  }
}

const dir = path.resolve(process.argv[2] ?? 'dsh-gee');
const entry = path.join(dir, 'index.js');
const plugin = await import(pathToFileURL(entry).href);

const registered = [];
plugin.apply(
  {
    get: () => undefined,
    effect(callback) {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    attachments: {
      async saveImage() {
        throw new Error('check-plugin: attachments.saveImage is not exercised');
      },
    },
    webServer: {
      register() {
        return () => {};
      },
    },
  },
  {},
);

for (const definition of registered) {
  const where = `tool "${definition.name}"`;
  if (definition.parameters?.type !== 'object') {
    problems.push(
      `${where}: parameters is not an object-rooted JSON Schema (got type=${JSON.stringify(definition.parameters?.type ?? null)}). ` +
        'Wrap a parameter map as { type: "object", properties: {...}, required: [...], additionalProperties: false }',
    );
  }
  checkNode(definition.parameters ?? {}, `${where}.parameters`);
  checkNode(definition.output?.schema ?? {}, `${where}.output.schema`);
}

console.log(`plugin: ${plugin.name ?? '(unnamed)'}  entry: ${entry}`);
console.log(`tools:  ${registered.map((tool) => tool.name).join(', ') || '(none)'}`);
for (const definition of registered) {
  const properties = Object.keys(definition.parameters?.properties ?? {});
  console.log(`  ${definition.name.padEnd(14)} parameters.type=${definition.parameters?.type} props=[${properties}]`);
}

if (problems.length > 0) {
  console.error('\nFAIL');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('\nOK: every tool schema would survive the model request');
