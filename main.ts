// Driver for the markdown-render-speed-02 entry. The harness runs
// `node /bot/main.ts` on Node 22 (type stripping, so only erasable syntax).
// It reads /input/cases.json — a JSON array of {id, markdown} — renders every
// case on its own with parse() from parse.js, and writes /output/html.json,
// a JSON array of the HTML strings in the cases' order. Outside a container,
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(IN_DIR, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const rendered: string[] = [];
for (const c of cases) rendered.push(parse(c.markdown));
writeFileSync(join(OUT_DIR, 'html.json'), JSON.stringify(rendered));
