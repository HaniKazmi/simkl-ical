/**
 * RENDER — a StatusModel to one self-contained HTML page. Pure: no clock, no
 * config, no io.
 *
 * Everything here that is not a config constant is attacker-or-accident
 * controlled: SIMKL show titles, spreadsheet contents and tab names, Google
 * and SIMKL error bodies. So the primitives escape by default — a bare
 * `escapeHtml` remembered at a hundred call sites is a rule, and rules get
 * forgotten. The one file to audit for interpolation.
 */

import type { RunView, Stamp, StatusModel } from './1-model.ts';

/**
 * Module-private so the brand cannot be forged: a `{ html: string }` duck
 * type is satisfied by any object with that key — including one parsed from
 * JSON — and would pass through unescaped.
 */
const SAFE = Symbol('safe-html');

export interface SafeHtml {
  readonly [SAFE]: string;
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * One pass over a character class, never chained `.replace` calls: replacing
 * `&` after `<` turns an already-escaped `&lt;` into `&amp;lt;`.
 */
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => ENTITIES[c]!);

/** The escape hatch. One call site in this file: the stylesheet. */
export const raw = (value: string): SafeHtml => ({ [SAFE]: value });

const isSafe = (value: unknown): value is SafeHtml => typeof value === 'object' && value !== null && SAFE in value;

/**
 * Interpolate, escaping anything not marked safe. `null`/`undefined` render
 * as nothing, so an unset timestamp never prints "null"; arrays join, making
 * a list of rows an expression; a nested `html` passes through, so composing
 * fragments does not double-escape.
 */
export const html = (strings: TemplateStringsArray, ...values: unknown[]): SafeHtml => {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i += 1) {
    out += stringify(values[i]) + (strings[i + 1] ?? '');
  }
  return raw(out);
};

const stringify = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (isSafe(value)) return value[SAFE];
  if (Array.isArray(value)) return value.map(stringify).join('');
  return escapeHtml(String(value));
};

/** Unwrap for the transport. The only place a SafeHtml becomes a string. */
export const toHtml = (value: SafeHtml): string => value[SAFE];


// --- The page --------------------------------------------------------------

/**
 * Inlined, and the only `raw()` in the file: a stylesheet cannot be escaped
 * and stay one, and it is the one string here with no untrusted input.
 * External assets are out — the feed token is in this page's URL, and any
 * off-origin request would carry it out in a `Referer` header.
 *
 * The palette, the type stack, the header and the card treatment come from the index at
 * hani.fyi that links here; the two are consecutive screens. What that page
 * has no need for is state, so `--ok/--warn/--crit` are added from the same
 * family, and `--faint` gives labels a third rank below `--muted`.
 */
const STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#1b1f24;--muted:#6a737d;--faint:#8b949e;--line:#e1e4e8;--accent:#2f6feb;
--ok:#1a7f4b;--okbg:#e8f5ee;--warn:#9a6700;--warnbg:#fdf3d8;--crit:#cf222e;--critbg:#ffebe9;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#14171a;--card:#1d2126;--ink:#e8eaed;--muted:#9aa4af;--faint:#7d8590;
--line:#2c3238;--accent:#6c9bff;--ok:#3fb950;--okbg:#12261c;--warn:#d29922;--warnbg:#2a2113;--crit:#f85149;--critbg:#2d1a1a}}
*{box-sizing:border-box}
body{margin:0;padding:0 0 3rem;background:var(--bg);color:var(--ink);
font:0.875rem/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:65rem;margin:0 auto;padding:0 1.25rem;display:grid;gap:.75rem}
header{background:var(--card);border-bottom:1px solid var(--line);margin-bottom:1.5rem}
.bar{max-width:65rem;margin:0 auto;padding:.75rem 1.25rem;display:flex;flex-wrap:wrap;align-items:center;gap:.75rem}
.mark{width:1rem;height:1rem;border-radius:4px;background:var(--accent);flex:none}
h1{font-size:.875rem;font-weight:600;margin:0;letter-spacing:.07em;text-transform:uppercase}
.meta{margin-left:auto;text-align:right;color:var(--muted);font-size:.8125rem;line-height:1.45}
.pill{display:inline-flex;align-items:center;gap:.375rem;font-size:.6875rem;font-weight:600;letter-spacing:.06em;
text-transform:uppercase;padding:.15rem .5rem;border-radius:6px;border:1px solid currentColor;white-space:nowrap}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.ok{color:var(--ok);background:var(--okbg)}.pill.warn{color:var(--warn);background:var(--warnbg)}
.pill.crit{color:var(--crit);background:var(--critbg)}
.pill.mute{color:var(--muted);background:var(--bg);border-color:var(--line)}.pill.mute::before{display:none}
.tiles{display:grid;gap:.5rem;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr))}
.tile{display:grid;gap:.125rem;padding:.75rem .9rem;border:1px solid var(--line);border-radius:8px;background:var(--card)}
.tile.warn{border-color:var(--warn);background:var(--warnbg)}
.tile.crit{border-color:var(--crit);background:var(--critbg)}
.t-name{display:flex;align-items:center;gap:.375rem;font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;
font-weight:600;color:var(--muted)}
.t-name::before{content:"";width:7px;height:7px;border-radius:50%;flex:none;background:var(--faint)}
.tile.ok .t-name::before{background:var(--ok)}
.tile.warn .t-name::before{background:var(--warn)}.tile.warn .t-name{color:var(--warn)}
.tile.crit .t-name::before{background:var(--crit)}.tile.crit .t-name{color:var(--crit)}
.t-head{font-size:1rem;font-weight:600;letter-spacing:-.01em}
.t-next{color:var(--muted);font-size:.85rem}
.problems{padding:.75rem .9rem;border:1px solid var(--crit);background:var(--critbg);border-radius:8px}
.problems ul{margin:0;padding-left:1.1rem}.problems li{margin:.125rem 0}
.grid{display:grid;gap:.75rem;grid-template-columns:1fr}
@media(min-width:900px){.grid{grid-template-columns:1fr 1fr}}
section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.9rem 1.1rem 1rem;min-width:0}
.head{display:flex;flex-wrap:wrap;align-items:baseline;gap:.625rem;margin-bottom:.75rem}
h2.name{font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600;margin:0}
.sum{margin-left:auto;color:var(--muted);font-size:.8125rem}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
a:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
.ext{color:var(--faint);font-size:.7rem}
.mono{font-family:var(--mono)}
.dim{color:var(--muted)}
time{border-bottom:1px dotted transparent;cursor:help}
time:hover{border-bottom-color:var(--line)}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{text-align:left;font-size:.6875rem;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);
font-weight:600;padding:0 .625rem .45rem 0;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:.25rem .625rem .25rem 0;border-bottom:1px solid var(--bg);font-size:.8125rem}
tr:last-child td{border-bottom:0}
table.counts{width:auto;min-width:min(100%,24rem);margin-bottom:.9rem;font-family:var(--mono);font-size:.8125rem}
table.counts th{padding:0 0 .375rem 1rem;text-align:right}
table.counts th:first-child{padding-left:0;text-align:left}
table.counts td{padding:.15rem 0 .15rem 1rem;text-align:right;border-bottom:0}
table.counts td:first-child{padding-left:0;text-align:left;color:var(--muted);font-family:inherit;font-weight:600}
table.counts td.total{font-weight:600}
table.counts td.none{color:var(--line)}
.moved{display:grid;grid-template-columns:5rem minmax(0,1fr);gap:.125rem .75rem}
.moved .k,.subscribe .k,.lbl{font-size:.6875rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
.moved .v{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 .6rem}
.moved .because{grid-column:2;color:var(--muted)}
.deltas{display:flex;flex-wrap:wrap;gap:0 .75rem;font-family:var(--mono);font-size:.8125rem}
.delta{color:var(--ok)}
.run-when{color:var(--muted)}
.step{display:grid;grid-template-columns:.5rem 3.75rem minmax(0,1fr) auto;gap:.625rem;align-items:baseline;padding:.2rem 0}
.dot{width:7px;height:7px;border-radius:50%;background:var(--ok);align-self:center}
.step.bad .dot{background:var(--crit)}
.when{color:var(--muted);font-size:.8125rem;text-align:right;white-space:nowrap}
.next{margin-top:.75rem;padding-top:.6rem;border-top:1px solid var(--line);color:var(--muted);font-size:.8125rem;
display:flex;gap:.875rem;flex-wrap:wrap}
.next b{color:var(--ink);font-weight:600}
.subscribe{display:grid;grid-template-columns:5rem minmax(0,1fr);gap:.75rem;margin-top:.5rem;padding-top:.6rem;
border-top:1px solid var(--line)}
.subscribe a{overflow-wrap:anywhere;font-family:var(--mono);font-size:.8125rem}
.run{border:1px solid var(--line);border-radius:8px;margin-bottom:.5rem;overflow:hidden}
.run:last-child{margin-bottom:0}
.run-head,details.run>summary{display:flex;flex-wrap:wrap;align-items:center;gap:.625rem;padding:.6rem .9rem;background:var(--bg)}
.run-head{border-bottom:1px solid var(--line)}
.run-head.bare{border-bottom:0}
.run-count{margin-left:auto;color:var(--muted);font-size:.8125rem}
details.run>summary{list-style:none;cursor:pointer}
details.run>summary::-webkit-details-marker{display:none}
details.run>summary::before,.run-head.sole::before{content:"\\25B8";color:var(--muted);font-size:.8rem;line-height:1;display:inline-block;transition:transform .12s ease}
details.run[open]>summary::before{transform:rotate(90deg)}
details.run[open]>summary{border-bottom:1px solid var(--line)}
details.run:hover{border-color:var(--accent)}
details.run>summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
@media(prefers-reduced-motion:reduce){details.run>summary::before{transition:none}}
.edit{display:grid;grid-template-columns:4.5rem 5rem minmax(0,1fr);gap:.625rem;padding:.2rem .9rem;font-size:.8125rem}
.edit:first-of-type{padding-top:.5rem}.edit:last-child{padding-bottom:.5rem}
.addr{color:var(--accent);font-family:var(--mono)}
.edit.ins .addr{color:var(--ok)}
.fld{color:var(--muted)}
.run-head.sole{display:grid;grid-template-columns:auto 5.5rem 6rem 4.5rem 5rem minmax(0,1fr) auto;gap:.625rem;align-items:center}
.run-head.sole::before{visibility:hidden}
.run-head.sole .addr,.run-head.sole .fld,.note{font-size:.8125rem;overflow-wrap:anywhere}
.run-head.sole .run-count{margin-left:0;text-align:right}
.msg{padding:.6rem .9rem;font-size:.8125rem;font-family:var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
.freeze{border:1px solid var(--crit);background:var(--critbg);border-radius:8px;padding:.75rem .9rem;margin-bottom:.75rem;
white-space:pre-wrap;font-family:var(--mono);font-size:.8125rem}
.freeze b{display:block;color:var(--crit);font-size:.6875rem;letter-spacing:.06em;text-transform:uppercase;
margin-bottom:.35rem;font-family:system-ui,sans-serif}
.t-wrap{overflow-x:auto}
td.src{white-space:nowrap}
td.svc{color:var(--faint);white-space:nowrap}
td.path{overflow-wrap:anywhere;font-family:var(--mono);color:var(--muted)}
.num{text-align:right;white-space:nowrap;font-family:var(--mono)}
th.st,td.st{width:4rem}th.sz,td.sz{width:3.5rem}th.ms,td.ms{width:4rem}
td.when{color:var(--faint);text-align:right;white-space:nowrap}
th.wh{text-align:right;padding-right:0}
tr.bad td,tr.bad td.path{color:var(--crit)}
@media(max-width:640px){
thead{display:none}
table,tbody,tr,td{display:block;width:auto}
tr{border:1px solid var(--line);border-radius:8px;padding:.5rem .7rem;margin-bottom:.375rem}
tr.bad{border-color:var(--crit)}
td{border-bottom:0;padding:0}
td.src,td.svc,td.st,td.sz,td.ms,td.when{display:inline;text-align:left;font-size:.75rem}
td.src::after,td.svc::after,td.st::after,td.sz::after,td.ms::after{content:" \\00B7 ";color:var(--line)}
td.path{display:block;margin-top:.2rem;color:var(--ink)}
table.counts,table.counts tbody,table.counts tr,table.counts td{display:revert}
table.counts tr{border:0;padding:0;margin:0}
.run-head.sole{display:flex;flex-wrap:wrap}
.run-head.sole::before{display:none}
.run-head.sole .note{flex-basis:100%}
}
footer{color:var(--faint);font-size:.8125rem;padding:.25rem .25rem 0}
`;

/**
 * `title` is null for every stamp with no usable instant, which includes a
 * timestamp read off disk that will not parse — a wider condition than a null
 * `iso`. Branching on it keeps the `datetime` attribute valid.
 */
const time = (s: Stamp) =>
  s.title === null ? html`<span class="dim">${s.label}</span>` : html`<time datetime="${s.iso}" title="${s.title}">${s.label}</time>`;

/**
 * The first screen: one card per half of the service, each saying what it
 * holds and when it next acts. A healthy tile is as quiet as any other card —
 * only `warn` and `crit` take colour, so the eye lands on what wants it.
 */
const tiles = (model: StatusModel) =>
  model.tiles.map(
    (tile) => html`<div class="tile ${tile.state}">
      <span class="t-name">${tile.name}</span>
      <span class="t-head">${tile.headline}</span>
      <span class="t-next">${tile.next}</span>
    </div>`,
  );

/**
 * Every count the library holds, not just the totals: the per-status split is
 * the sanity check, and it costs three rows. An em dash is a status the type
 * does not have, which is not the same as a zero.
 */
const counts = (model: StatusModel) => html`<table class="counts">
  <thead><tr><th></th><th>total</th>${model.library.countColumns.map((column) => html`<th>${column}</th>`)}</tr></thead>
  <tbody>${model.library.counts.map(
    (row) => html`<tr>
      <td>${row.key}</td><td class="total">${row.count}</td>
      ${row.byStatus.map((n) => (n === null ? html`<td class="none">—</td>` : html`<td>${n}</td>`))}
    </tr>`,
  )}</tbody>
</table>`;

/**
 * What the last pull was and what it meant. The label matters: this is the
 * last poll that *moved* something, which on a quiet system is days older than
 * the gate pill beside it.
 */
const movement = (model: StatusModel) => {
  const moved = model.library.movement;
  if (moved === null) return html`<div class="dim">no library movement seen yet</div>`;
  return html`<div class="moved">
    <span class="k">last pull</span>
    <span class="v"><span class="run-when">${time(moved.at)}</span><span>${moved.pulled}</span></span>
    ${moved.deltas.length === 0
      ? null
      : html`<span class="because"><span class="deltas">${moved.deltas.map((d) => html`<span class="delta">${d}</span>`)}</span></span>`}
    <span class="because">${moved.consequence}</span>
  </div>`;
};

/**
 * Every outbound call this process made, newest first. The one view that
 * shows the gate working: lone `/sync/activities` rows with the occasional
 * delta beside them is the delta sync doing its job. A failure carries its
 * body — `user_token_failed` and a revoked credential look identical without
 * one.
 */
const requestRows = (model: StatusModel) =>
  model.requests.map(
    (r) => html`<tr class="${r.error === null ? '' : 'bad'}">
      <td class="src">${r.component}</td>
      <td class="svc">${r.service}</td>
      <td class="path" title="${r.full}">${r.method === 'GET' ? null : html`${r.method} `}${r.path}</td>
      <td class="num st">${r.status === null ? '—' : r.status}${r.attempts > 1 ? html` ×${r.attempts}` : null}</td>
      <td class="num sz">${r.size}</td>
      <td class="num ms">${r.ms}ms</td>
      <td class="when">${time(r.at)}</td>
    </tr>`,
  );

const steps = (model: StatusModel) =>
  model.feed.steps.map(
    (step) => html`<div class="step ${step.ok ? '' : 'bad'}">
      <span class="dot"></span><span class="lbl">${step.name}</span>
      <span>${step.detail}</span><span class="when">${time(step.at)}</span>
    </div>`,
  );

const runChanges = (run: RunView) => [
  ...run.edits.map(
    (e) => html`<div class="edit"><span class="addr">${e.address}</span><span class="fld">${e.field}</span><span>${e.note}</span></div>`,
  ),
  ...run.inserts.map(
    (i) => html`<div class="edit ins"><span class="addr">${i.address}</span><span class="fld">insert</span><span>${i.note}</span></div>`,
  ),
  ...(run.error === null ? [] : [html`<div class="msg">${run.error}</div>`]),
];

/**
 * The newest run stands open; the rest collapse to their summary line. Fifty
 * runs of fifteen near-identical edits is what the journal can hold, and
 * expanded it buries every section below this one. `details` does it with no
 * script, which the page's `default-src 'none'` requires.
 *
 * A run with a `sole` change gets no expander at all: an incremental history
 * is nearly all one-change runs, and a triangle that reveals the line already
 * shown is worse than none. Its cells sit at fixed widths so a column of them
 * reads down — the reason the whole section exists is to compare one run's
 * change against the next's.
 */
const runs = (model: StatusModel) =>
  model.sheet.runs.map((run) => {
    const changes = runChanges(run);
    const summary = html`<span class="pill ${run.state}">${run.status}</span>
      <span class="run-when">${time(run.at)}</span>
      ${run.sole === null
        ? null
        : html`<span class="addr">${run.sole.address}</span><span class="fld">${run.sole.field}</span><span class="note">${run.sole.note}</span>`}
      ${run.count === null ? null : html`<span class="run-count">${run.count}</span>`}`;
    if (run.sole !== null) return html`<div class="run"><div class="run-head bare sole">${summary}</div></div>`;
    return run.open
      ? html`<div class="run">
          <div class="run-head ${changes.length ? '' : 'bare'}">${summary}</div>
          ${changes}
        </div>`
      : html`<details class="run"><summary>${summary}</summary>${changes}</details>`;
  });

const sheetBody = (model: StatusModel) => {
  const { sheet } = model;
  if (!sheet.configured) return html`<p class="dim">Not configured — set SHEET_ID and a Google credential to switch it on.</p>`;
  return html`
    ${sheet.frozen === null ? null : html`<div class="freeze"><b>Frozen — no further writes this process</b>${sheet.frozen}</div>`}
    ${sheet.error === null ? null : html`<div class="msg">${sheet.error}</div>`}
    ${sheet.runs.length ? runs(model) : html`<p class="dim">Nothing written yet.</p>`}`;
};

/**
 * What the sync has recorded SIMKL as saying, and when that last moved.
 *
 * Here because nothing else on the page can say it. A first run records every
 * tracked field and writes nothing by design, which reaches the history as an
 * `idle` run with no edits — the same thing a sync that never armed produces.
 * A count separates them.
 *
 * A count and a time, never anything read out of the file: the run log is the
 * one thing here rendered verbatim, and it should stay the only one.
 */
const tracking = (model: StatusModel) => {
  const { seasons, movedAt } = model.sheet.baseline;
  if (seasons === 0) return html`<span class="dim">nothing tracked yet</span>`;
  return html`tracking <b class="mono">${seasons}</b> seasons, last moved ${time(movedAt)}`;
};

/** The tab, linked when there is a spreadsheet id to link it to. */
const sheetTab = (model: StatusModel) =>
  model.sheet.url === null
    ? html`tab “${model.sheet.tab}”`
    : html`tab <a href="${model.sheet.url}" target="_blank" rel="noopener noreferrer">“${model.sheet.tab}” <span class="ext">↗</span></a>`;

/** The whole page, as one self-contained document. */
export const renderPage = (model: StatusModel): string =>
  toHtml(html`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${model.appName} status</title>
<link rel="icon" href="favicon.ico" sizes="32x32">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<style>${raw(STYLE)}</style>
</head><body>

<header><div class="bar">
  <span class="mark"></span>
  <h1>${model.appName}</h1>
  <span class="pill ${model.ok ? 'ok' : 'warn'}">${model.ok ? 'healthy' : 'degraded'}</span>
  <span class="meta">v${model.version} · ${model.timezone}<br>${model.uptime === null ? 'starting' : html`up ${model.uptime}`} · ${model.feed.events} events</span>
</div></header>

<div class="wrap">

<div class="tiles">${tiles(model)}</div>

${model.problems.length === 0 ? null : html`<div class="problems"><ul>${model.problems.map((p) => html`<li>${p}</li>`)}</ul></div>`}

<div class="grid">
  <section>
    <div class="head">
      <h2 class="name">Library</h2>
      <span class="pill mute">${model.library.gate}</span>
      <span class="sum">gated ${time(model.library.polled)} · ${model.library.total} items</span>
    </div>
    ${counts(model)}
    ${movement(model)}
    <div class="next">
      <span class="dim">a gate is one <b class="mono">/sync/activities</b> call; a delta pull, a render and a sheet sync follow only if it says something moved</span>
    </div>
    ${model.library.error === null ? null : html`<div class="msg">${model.library.error}</div>`}
  </section>

  <section>
    <div class="head">
      <h2 class="name">Feed</h2>
      <span class="pill mute">fetch → join → render → save</span>
      <span class="sum">rendered ${time(model.feed.rendered)}</span>
    </div>
    ${steps(model)}
    <div class="next">
      <span><b>films</b> ${model.feed.filmsDue ? 'due on the next gate' : 'none due'}</span>
      <span class="dim">films resolve on the gate, not on a timer of their own</span>
    </div>
    <div class="subscribe">
      <span class="k">subscribe</span>
      <a href="${model.feed.subscribe.href}" title="${model.feed.subscribe.url}" rel="noopener noreferrer">feed.ics <span class="ext">↗</span></a>
    </div>
    ${model.feed.error === null ? null : html`<div class="msg">${model.feed.error}</div>`}
  </section>
</div>

<section>
  <div class="head">
    <h2 class="name">Sheet</h2>
    <span class="pill ${model.sheet.state}">${model.sheet.status}</span>
    <span class="sum">${model.sheet.configured
      ? html`${model.sheet.mode} mode · ${sheetTab(model)} · ${time(model.sheet.lastRun)}${model.sheet.runtimes ? null : ' · runtimes off'} · ${tracking(model)}`
      : 'off'}</span>
  </div>
  ${sheetBody(model)}
</section>

<section>
  <div class="head">
    <h2 class="name">Requests</h2>
    <span class="pill mute">${model.requests.length} recent</span>
    <span class="sum">every outbound call, newest first</span>
  </div>
  ${model.requests.length === 0
    ? html`<p class="dim">Nothing requested yet.</p>`
    : html`<div class="t-wrap"><table>
        <thead><tr><th>From</th><th></th><th>Path</th><th class="num st">Status</th><th class="num sz">Size</th><th class="num ms">Took</th><th class="num wh">When</th></tr></thead>
        <tbody>${requestRows(model)}</tbody>
      </table></div>`}
  ${model.requestErrors.map((error) => html`<div class="msg">${error}</div>`)}
</section>

<footer>Read-only. The page loads nothing but its own icon; the two links are yours to click.</footer>

</div></body></html>`);
