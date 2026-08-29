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

import type { Stamp, StatusModel } from './1-model.ts';

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
 */
const STYLE = `
:root{--bg:#fff;--panel:#f5f6f9;--ink:#191b21;--slate:#5c6475;--faint:#858c9c;--line:#e3e6ec;
--accent:#3e3b86;--ok:#2e7d52;--warn:#9a6b12;--crit:#a63028;--okbg:#e6f2ea;--warnbg:#f8f0dd;--critbg:#fbeae8}
@media(prefers-color-scheme:dark){:root{--bg:#14151a;--panel:#1c1e25;--ink:#e6e8ee;--slate:#a3aab9;--faint:#7c8494;
--line:#2a2d36;--accent:#9b96e8;--ok:#5fb98a;--warn:#d1a34d;--crit:#e07d73;--okbg:#1a2a22;--warnbg:#2c2518;--critbg:#2e1d1b}}
*{box-sizing:border-box}
body{margin:0;padding:0 20px 64px;background:var(--bg);color:var(--ink);
font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;-webkit-font-smoothing:antialiased}
.wrap{max-width:820px;margin:0 auto}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:12px;padding:28px 0 18px;border-bottom:1px solid var(--line)}
h1{font-size:17px;font-weight:650;margin:0;letter-spacing:-.01em}
.meta{margin-left:auto;text-align:right;color:var(--faint);font-size:12px}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:650;letter-spacing:.05em;
text-transform:uppercase;padding:3px 9px;border-radius:3px;border:1px solid currentColor}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.ok{color:var(--ok);background:var(--okbg)}.pill.warn{color:var(--warn);background:var(--warnbg)}
.pill.crit{color:var(--crit);background:var(--critbg)}
.pill.mute{color:var(--faint);background:var(--panel);border-color:var(--line)}.pill.mute::before{display:none}
section{padding:20px 0 22px;border-bottom:1px solid var(--line)}
section:last-of-type{border-bottom:0}
.head{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;margin-bottom:14px}
.name{font-size:11px;letter-spacing:.17em;text-transform:uppercase;color:var(--accent);font-weight:650}
.sum{margin-left:auto;color:var(--faint);font-size:12px}
.problems{margin:14px 0 0;padding:12px 14px;border:1px solid var(--crit);background:var(--critbg);border-radius:4px}
.problems ul{margin:0;padding-left:18px}.problems li{margin:2px 0}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{text-align:left;font-size:10px;letter-spacing:.13em;text-transform:uppercase;color:var(--faint);
font-weight:600;padding:0 8px 7px 0;border-bottom:1px solid var(--line)}
td{padding:4px 8px 4px 0;border-bottom:1px solid var(--panel);font-size:12.5px}
tr:last-child td{border-bottom:0}
.num{text-align:right;width:64px}
.dim{color:var(--faint)}
.totals{display:flex;flex-wrap:wrap;gap:0 1.1rem;padding:.5rem .9rem;border-bottom:1px solid var(--line)}
.tot b{font-weight:600;color:var(--faint)}
.moved{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 .6rem;padding:.5rem .9rem}
.deltas{display:flex;flex-wrap:wrap;gap:0 .5rem}
.delta{color:var(--ok)}
td.src{color:var(--slate)}
td.svc{color:var(--faint)}
td.path{word-break:break-all}
tr.bad td{color:var(--crit)}
.step{display:grid;grid-template-columns:14px 62px minmax(0,1fr) auto;gap:12px;align-items:baseline;padding:5px 0}
.dot{width:7px;height:7px;border-radius:50%;background:var(--ok);align-self:center}
.step.bad .dot{background:var(--crit)}
.lbl{font-size:11px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--slate)}
.when{color:var(--faint);font-size:12px;text-align:right;white-space:nowrap}
.next{margin-top:12px;padding-top:10px;border-top:1px dashed var(--line);color:var(--faint);
font-size:12px;display:flex;gap:18px;flex-wrap:wrap}.next b{color:var(--slate);font-weight:600}
.run{border:1px solid var(--line);border-radius:5px;margin-bottom:9px;overflow:hidden}
.run-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:9px 12px;background:var(--panel);border-bottom:1px solid var(--line)}
.run-head.bare{border-bottom:0}
.run-when{color:var(--slate);font-size:12px}.run-count{margin-left:auto;color:var(--faint);font-size:12px}
.edit{display:grid;grid-template-columns:64px 78px minmax(0,1fr);gap:10px;padding:4px 12px;font-size:12.5px}
.edit .addr{color:var(--accent)}.edit.ins .addr{color:var(--ok)}.edit .fld{color:var(--faint)}
.msg{padding:8px 12px;font-size:12.5px;white-space:pre-wrap;word-break:break-word}
.freeze{border:1px solid var(--crit);background:var(--critbg);border-radius:5px;padding:11px 13px;margin-bottom:12px;white-space:pre-wrap}
.freeze b{display:block;color:var(--crit);font-size:11px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:5px}
footer{padding-top:18px;color:var(--faint);font-size:11.5px}
`;

/**
 * Looked up with `Object.hasOwn`, not `?? 'mute'`: `status` comes from
 * `sheet-runs.json`, and a record saying `"constructor"` resolves through the
 * prototype to a function, so the default never fires. Escaped, so not an
 * injection — but that file is the untrusted surface here.
 */
const STATE_PILL: Record<string, string> = {
  applied: 'ok',
  reported: 'mute',
  idle: 'mute',
  refused: 'warn',
  'rolled-back': 'warn',
  failed: 'crit',
  frozen: 'crit',
};

const pill = (status: string): string => (Object.hasOwn(STATE_PILL, status) ? STATE_PILL[status]! : 'mute');

const time = (s: Stamp) => (s.iso === null ? html`<span class="dim">never</span>` : html`<time datetime="${s.iso}">${s.label}</time>`);

const countRows = (model: StatusModel) =>
  model.library.counts.map((row) => html`<span class="tot"><b>${row.key}</b> ${row.count}</span>`);

/**
 * How the library last moved — what a bare count cannot say. The deltas are
 * membership, absent on the commonest poll (watching an episode moves no
 * count). The summary is what the delta carried, never zero on a poll that
 * pulled. Both together separate "your library changed" from "the poll did
 * some work".
 */
const movement = (model: StatusModel) => {
  const moved = model.library.movement;
  if (moved === null) return html`<div class="moved dim">no library movement seen yet</div>`;
  return html`<div class="moved">
    <span class="run-when">${time(moved.at)}</span>
    ${moved.deltas.length === 0 ? null : html`<span class="deltas">${moved.deltas.map((d) => html`<span class="delta">${d}</span>`)}</span>`}
    <span class="dim">${moved.summary}</span>
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
      <td class="path">${r.method === 'GET' ? null : html`${r.method} `}${r.path}</td>
      <td class="num">${r.status === null ? '—' : r.status}${r.attempts > 1 ? html` ×${r.attempts}` : null}</td>
      <td class="num">${r.size}</td>
      <td class="num">${r.ms}ms</td>
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

const runs = (model: StatusModel) =>
  model.sheet.runs.map((run) => {
    const changes = [
      ...run.edits.map((e) => html`<div class="edit"><span class="addr">${e.address}</span><span class="fld">${e.field}</span><span>${e.note}</span></div>`),
      ...run.inserts.map((i) => html`<div class="edit ins"><span class="addr">${i.address}</span><span class="fld">insert</span><span>${i.note}</span></div>`),
    ];
    const count = `${run.edits.length} edits · ${run.inserts.length} inserts${run.repeats > 1 ? ` · ${run.repeats} polls` : ''}`;
    return html`<div class="run">
      <div class="run-head ${changes.length || run.error ? '' : 'bare'}">
        <span class="pill ${pill(run.status)}">${run.status}</span>
        <span class="run-when">${time(run.at)}</span>
        <span class="run-count">${count}</span>
      </div>
      ${changes}
      ${run.error === null ? null : html`<div class="msg">${run.error}</div>`}
    </div>`;
  });

const sheetBody = (model: StatusModel) => {
  const { sheet } = model;
  if (!sheet.configured) return html`<p class="dim">Not configured — set SHEET_ID and a Google credential to switch it on.</p>`;
  return html`
    ${sheet.frozen === null ? null : html`<div class="freeze"><b>Frozen — no further writes this process</b>${sheet.frozen}</div>`}
    ${sheet.error === null || sheet.error === sheet.frozen ? null : html`<div class="msg">${sheet.error}</div>`}
    ${sheet.runs.length ? runs(model) : html`<p class="dim">Nothing written yet.</p>`}`;
};

/** The whole page, as one self-contained document. */
export const renderPage = (model: StatusModel): string =>
  toHtml(html`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${model.appName} status</title>
<style>${raw(STYLE)}</style>
</head><body><div class="wrap">

<header>
  <h1>${model.appName}</h1>
  <span class="pill ${model.ok ? 'ok' : 'warn'}">${model.ok ? 'healthy' : 'degraded'}</span>
  <span class="meta">v${model.version} · ${model.timezone}<br>${model.uptime === null ? 'starting' : html`up ${model.uptime}`} · ${model.feed.events} events</span>
</header>

${model.problems.length === 0 ? null : html`<div class="problems"><ul>${model.problems.map((p) => html`<li>${p}</li>`)}</ul></div>`}

<section>
  <div class="head">
    <span class="name">Library</span>
    <span class="pill mute">${model.library.gate}</span>
    <span class="sum">gated ${time(model.library.polled)} · ${model.library.total} items</span>
  </div>
  <div class="totals">${countRows(model)}</div>
  ${movement(model)}
  <div class="next">
    <span><b>next gate</b> ${model.library.due.label}</span>
    <span class="dim">one /sync/activities call, then a delta pull, a render and a sheet sync if anything moved</span>
  </div>
  ${model.library.error === null ? null : html`<div class="msg">${model.library.error}</div>`}
</section>

<section>
  <div class="head">
    <span class="name">Feed</span>
    <span class="pill mute">fetch → join → render → save</span>
    <span class="sum">rendered ${time(model.feed.rendered)}</span>
  </div>
  ${steps(model)}
  <div class="next">
    <span><b>next calendars</b> ${model.feed.calendarsDue.label}</span>
    <span><b>films</b> ${model.feed.filmsDue ? 'due on the gate above' : 'none due'}</span>
  </div>
  ${model.feed.error === null ? null : html`<div class="msg">${model.feed.error}</div>`}
</section>

<section>
  <div class="head">
    <span class="name">Sheet</span>
    <span class="pill ${pill(model.sheet.status)}">${model.sheet.status}</span>
    <span class="sum">${model.sheet.configured
      ? html`${model.sheet.mode} mode · tab “${model.sheet.tab}” · ${time(model.sheet.lastRun)}${model.sheet.runtimes ? null : ' · runtimes off'}`
      : 'off'}</span>
  </div>
  ${sheetBody(model)}
</section>

<section>
  <div class="head">
    <span class="name">Requests</span>
    <span class="pill mute">${model.requests.length} recent</span>
    <span class="sum">every outbound call, newest first</span>
  </div>
  ${model.requests.length === 0
    ? html`<p class="dim">Nothing requested yet.</p>`
    : html`<table>
        <thead><tr><th>From</th><th></th><th>Path</th><th class="num">Status</th><th class="num">Size</th><th class="num">Took</th><th>When</th></tr></thead>
        <tbody>${requestRows(model)}</tbody>
      </table>`}
  ${model.requestErrors.map((error) => html`<div class="msg">${error}</div>`)}
</section>

<footer>Read-only. Nothing on this page triggers a fetch.</footer>

</div></body></html>`);
