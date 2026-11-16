# markdown-render-speed-02-v1

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/rezimx-btc/markdown-render-speed-02-v1/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/rezimx-btc/markdown-render-speed-02-v1/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free Markdown renderer whose HTML is byte-identical to marked 18.1.3 (default options, GFM on). It implements CommonMark 0.31.2 + GFM 0.29 as marked renders them: one left-to-right block scan emitting HTML directly — no token tree, no second pass — with sticky regexes driven by a cursor, and inline runs queued as jobs until every link definition in the document is known. On the 720-case practice set it matches marked on every case and renders about 1.4x faster. `parse.js` is the whole parser (one exported `parse(markdown)`); `main.ts` is the driver the harness runs.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

It reads `/input/cases.json` (a JSON array of `{id, markdown}`), renders each case alone with `parse()`, and writes `/output/html.json` (a JSON array of the HTML strings, in order). Node 22, no dependencies, no install step.

---

<sub>Entered on [make.fun](https://make.fun/?ref=nht78ayn&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
