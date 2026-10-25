// Decode a DSH session log (zstd chunks) and print a readable timeline.
//
//   node tools/dump-session.mjs <session.v4.jsonl.zstd> [HH:MM:SS] [--all]
//
// Times are UTC; pass the HH:MM:SS of the first event you care about.

import fs from 'node:fs';
import zlib from 'node:zlib';

const [file, since = '00:00:00'] = process.argv.slice(2);
if (!file) {
  console.error('usage: node tools/dump-session.mjs <log> [HH:MM:SS]');
  process.exit(2);
}

const raw = fs.readFileSync(file);
const offsets = [];
for (let i = 0; i + 4 <= raw.length; i += 1) {
  if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) offsets.push(i);
}

let text = '';
for (const offset of offsets) {
  try {
    text += zlib.zstdDecompressSync(raw.subarray(offset)).toString('utf8');
  } catch {
    // a chunk that is still being written
  }
}

const stamp = (event) => {
  const value = Number(event.time);
  if (!Number.isFinite(value) || value <= 0) return '';
  try {
    return new Date(value).toISOString().slice(11, 19);
  } catch {
    return '';
  }
};

const clip = (value, width) => String(value ?? '').replace(/\s+/g, ' ').slice(0, width);
const events = text
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  })
  .filter(Boolean);

let printed = 0;
for (const event of events) {
  const at = stamp(event);
  if (!at || at < since) continue;
  if (event.type === 'tool/call') {
    console.log(at, '[call]', event.data.name, clip(event.data.arguments, 220));
  } else if (event.type === 'tool/result') {
    const body = (event.data.message?.content ?? []).map((part) => part.text ?? '').join(' ');
    console.log(at, event.data.message?.isError ? '[ERR]' : '[ok ]', clip(body, 220));
  } else if (event.type === 'assistant/message') {
    const body = (event.data.message?.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join(' ');
    if (body) console.log(at, '[say]', clip(body, 320));
  } else if (event.type === 'user/message') {
    const body = (event.data.message?.content ?? []).map((part) => part.text ?? '').join(' ');
    if (body && !body.startsWith('Current runtime')) console.log(at, '[user]', clip(body, 200));
  } else if (event.type.startsWith('approval')) {
    console.log(at, `[${event.type}]`, clip(JSON.stringify(event.data), 160));
  }
  printed += 1;
}
console.error(`events: ${events.length}, printed: ${printed}`);
