/**
 * RENDER — a StatusModel to one self-contained HTML page. Pure: no clock, no
 * config, no io.
 *
 * The primitives are `shared/html.ts`'s; they are re-exported here because
 * this is the file a reader auditing the status page's interpolation opens.
 */

import type { RunView, Stamp, StatusModel } from './1-model.ts';
import { BASE_STYLE, document, html } from '../shared/html.ts';

export { escapeHtml, html, raw, toHtml, type SafeHtml } from '../shared/html.ts';

// --- The page --------------------------------------------------------------

/** What the status page needs beyond the shared look: its tables, steps, runs and edits. */
const STYLE = `${BASE_STYLE}
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
      ${
        // One poll writes one record per tab, so without this a quiet films run
        // and a quiet show run read identically. A record with no `tab` is a
        // show run.
        run.tab === 'films' ? html`<span class="fld">films</span>` : null
      }
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
  const { seasons, films, movedAt } = model.sheet.baseline;
  if (seasons + films === 0) return html`<span class="dim">nothing tracked yet</span>`;
  // Named apart, because one record holds both tabs and a rolled-up number
  // says neither.
  const counts = films === 0 ? html`<b class="mono">${seasons}</b> seasons` : html`<b class="mono">${seasons}</b> seasons and <b class="mono">${films}</b> films`;
  return html`tracking ${counts}, last moved ${time(movedAt)}`;
};

/** The tab, linked when there is a spreadsheet id to link it to. */
/**
 * Which tabs are being kept current. Both are named when both are synced: they
 * are different tabs of one spreadsheet with different rules, and naming only
 * the first says the films tab is not touched — which is exactly what the
 * reader is trying to find out.
 */
const sheetTab = (model: StatusModel) =>
  model.sheet.url === null
    ? html`${tabs(model)}`
    : html`<a href="${model.sheet.url}" target="_blank" rel="noopener noreferrer">${tabs(model)} <span class="ext">↗</span></a>`;

const tabs = (model: StatusModel) =>
  model.sheet.films ? html`tabs “${model.sheet.tab}” and “${model.sheet.filmsTab}”` : html`tab “${model.sheet.tab}”`;

/** The whole page, as one self-contained document. */
export const renderPage = (model: StatusModel): string =>
  document({
    title: `${model.appName} status`,
    style: STYLE,
    body: html`
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
      ? html`${model.sheet.mode} mode · ${sheetTab(model)} · ${time(model.sheet.lastRun)}${model.sheet.runtimes ? null : ' · runtimes off'}${model.sheet.films ? null : ' · films off'} · ${tracking(model)}`
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

</div>`,
  });
