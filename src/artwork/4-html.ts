/**
 * RENDER — an `ArtworkModel` to one page. Pure: no clock, no config, no io.
 * Every value here that is not a constant is a show title, a spreadsheet
 * cell or an upstream error, so everything goes through `html`; the
 * stylesheet reaches the document through `document()`'s `raw`. With
 * `2-html.ts` under `status/`, one of the two files to audit for
 * interpolation.
 *
 * Every `src` and `href` is relative (`artwork/app.js`, `status`, the icons)
 * or an https image URL — a cell may link any public host, and the row shows
 * what it links. No absolute URL on this page carries the feed token: the
 * page is reached through it, and the `no-referrer` header the route sends
 * is what keeps it out of those hosts' logs.
 */

import { BASE_STYLE, document, html, type SafeHtml } from '../shared/html.ts';
import { duration, plainDateIn } from '../shared/dates.ts';
import { allowedImageUrl } from '../api/images.ts';
import type { ArtworkKind, ArtworkState, ArtworkSummary, ArtworkTitle } from './1-index.ts';

/**
 * What a row calls its kind. A record so a fourth kind fails `tsc` rather than
 * rendering as whatever the last branch of a ternary said.
 */
const KIND_LABEL: Record<ArtworkKind, string> = { movie: 'film', show: 'show', book: 'book' };

/** What a row's last touch was, by kind; the same record shape, for the same reason. */
const TOUCHED_BY: Record<ArtworkKind, 'watched' | 'read'> = { movie: 'watched', show: 'watched', book: 'read' };

/** One row as the page shows it; built by the shell from an `ArtworkTitle` and the clock. */
export interface ArtworkRow {
  kind: ArtworkKind;
  id: number | null;
  title: string;
  /** The row on the tab, one-based, as a reader would find it. */
  rowNumber: number;
  address: string | null;
  context: string | null;
  franchise: string | null;
  /** ISO date, for ordering inside a franchise; empty for a show or an undated film. */
  released: string;
  state: ArtworkState;
  /** The image the row shows today, when its host is one the page may load from. */
  image: string | null;
  /** `2d ago` inside `RELATIVE_AGE`, the local date beyond it, or null. */
  touched: { label: string; because: 'added by the sync' | 'watched' | 'read' } | null;
  /** Inside the recency window: what the "added by the sync" chip filters on. */
  recent: boolean;
  /** What the cell holds, in a reader's words. */
  cell: string;
}

export interface ArtworkModel {
  appName: string;
  version: string;
  timezone: string;
  mode: 'off' | 'report' | 'apply';
  buckets: Record<ArtworkKind, string>;
  /**
   * Whether the books half is configured. The gate that stops the reads has to
   * reach the page too: unconfigured, "books are simply not listed" has to mean
   * the chip, the count and the copy as well as the rows.
   */
  books: boolean;
  summary: ArtworkSummary;
  /** `30 days`, for the chip and the tile. */
  recentWindow: string;
  errors: string[];
  rows: ArtworkRow[];
  built: { label: string; title: string | null };
}

/** What a cell holds, in a reader's words. */
const describeCell = (title: ArtworkTitle): string => {
  const host = (url: string | null): string => {
    try {
      return url ? new URL(url).hostname : 'nothing';
    } catch {
      return 'text';
    }
  };
  switch (title.cell.kind) {
    case 'bucket':
      return title.stored.exists === false ? 'links the bucket, no object yet' : 'links the bucket';
    case 'formula':
      return title.state === 'unrecognised' ? 'a formula resolving elsewhere' : title.stored.exists === false ? 'a formula linking the bucket, no object yet' : 'a formula linking the bucket';
    case 'blank':
      return title.stored.exists ? 'cell is blank, object already uploaded' : 'cell is blank';
    case 'foreign':
      // Read off the URL, not the state: a row with no usable id is `no-id`
      // whatever its cell links, and its link is no less public for that.
      return allowedImageUrl(title.cell.url ?? '') ? `links ${host(title.cell.url)}` : `links ${host(title.cell.url)}, which is not an https URL on a public host`;
    case 'other':
      return 'cell holds text that is not a link';
  }
};

export interface ModelOptions {
  now: Temporal.Instant;
  timezone: string;
  /** Days and below only. */
  recentWindow: Temporal.Duration;
  appName: string;
  version: string;
  mode: 'off' | 'report' | 'apply';
  buckets: Record<ArtworkKind, string>;
  books: boolean;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * How old a touch may be and still read as relative. Past it a relative label
 * is a count nobody reads — most rows were last watched years ago, and
 * `3609d 22h ago` says less than the date it stands for. Not `RECENT_WINDOW`,
 * though the two agree today: that asks what the sync added lately, this asks
 * when a label stops being readable.
 */
const RELATIVE_AGE = Temporal.Duration.from({ days: 30 });

/**
 * An index to what the page shows. Pure given the clock: the relative labels
 * and the recency chip both need `now`, and it is passed rather than read.
 */
export const artworkModel = (
  index: { titles: readonly ArtworkTitle[]; summary: ArtworkSummary; errors: string[]; builtAt: Temporal.Instant },
  { now, timezone, recentWindow, appName, version, mode, buckets, books }: ModelOptions,
): ArtworkModel => {
  const since = now.subtract({ seconds: recentWindow.total('seconds') });
  const relativeFrom = now.subtract({ seconds: RELATIVE_AGE.total('seconds') });
  // A touch ahead of the clock — a finish date typed for next week — is a
  // date too, where a negative span would read as "0s ago".
  const age = (at: Temporal.Instant): string =>
    Temporal.Instant.compare(at, relativeFrom) >= 0 && Temporal.Instant.compare(at, now) <= 0 ? `${duration(at.until(now))} ago` : plainDateIn(at, timezone).toString();
  const local = index.builtAt.toZonedDateTimeISO(timezone);
  return {
    appName,
    version,
    timezone,
    mode,
    buckets,
    books,
    summary: index.summary,
    recentWindow: duration(recentWindow),
    errors: index.errors,
    built: { label: `${duration(index.builtAt.until(now))} ago`, title: `${local.toPlainDate()} ${pad(local.hour)}:${pad(local.minute)} ${timezone}` },
    rows: index.titles.map((title) => {
      const touched = title.recentAt
        ? {
            label: age(title.recentAt),
            because: title.addedBySync && title.recentAt.equals(title.addedBySync) ? ('added by the sync' as const) : TOUCHED_BY[title.kind],
          }
        : null;
      return {
        kind: title.kind,
        id: title.id,
        title: title.title,
        rowNumber: title.row + 1,
        address: title.address,
        context: title.context,
        franchise: title.franchise,
        released: title.releasedOn?.toString() ?? '',
        state: title.state,
        // A bucket link with nothing behind it would render as a broken image.
        image: title.cell.kind === 'foreign' ? title.cell.url : title.stored.exists === false ? null : title.cell.url,
        touched,
        recent: title.addedBySync !== null && Temporal.Instant.compare(title.addedBySync, since) >= 0,
        cell: describeCell(title),
      };
    }),
  };
};

/**
 * What the artwork page needs beyond the shared look: the filter bar, the
 * rows, the candidate strip a row opens into, and the full-size dialog.
 */
const STYLE = `${BASE_STYLE}
.tool{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.tool input{font:inherit;padding:.4rem .6rem;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);min-width:16rem}
.tool input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.sortby{margin-left:auto;display:inline-flex;gap:.375rem;align-items:center}
.grp,.sortby .lbl,.kind{font-size:.6875rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
.grp{padding:.6rem 0 .1rem}
.grp[hidden]{display:none}
.chip{font:inherit;font-size:.75rem;padding:.25rem .6rem;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--muted);cursor:pointer;font-variant-numeric:tabular-nums}
.chip b{color:var(--ink);font-weight:600;margin-left:.3rem}
.chip[aria-pressed="true"]{border-color:var(--accent);color:var(--accent)}
.chip:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.tile.act{grid-template-columns:1fr auto;align-items:center}
.btn{font:inherit;font-size:.75rem;font-weight:600;padding:.35rem .7rem;border:1px solid var(--accent);border-radius:6px;background:var(--accent);color:#fff;cursor:pointer;white-space:nowrap}
.btn.quiet{background:transparent;color:var(--accent)}
.btn[disabled]{opacity:.5;cursor:default}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.rows{display:grid;gap:.375rem}
.row{border:1px solid var(--line);border-radius:8px;background:var(--bg);overflow:hidden}
.row[hidden]{display:none}
.rh{display:grid;grid-template-columns:6rem auto minmax(0,1fr) auto auto auto;grid-template-areas:"th kind txt pill rec act";gap:.75rem;align-items:center;padding:.5rem .75rem}
.rh>.thb{grid-area:th}.rh>.kind{grid-area:kind}.rh>.txt{grid-area:txt}.rh>.pill{grid-area:pill}.rh>.rec{grid-area:rec}.rh>.act{grid-area:act}
.thb{display:flex;align-items:center;justify-content:center;padding:0;border:0;background:none;cursor:zoom-in;border-radius:4px}
.thb[disabled]{cursor:default}
.thb:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.rh .th{width:100%;height:3.375rem;border-radius:4px;background:var(--line);object-fit:cover;display:block}
.rh .th.portrait{width:2.5rem;height:3.75rem}
.rh .ph{display:block;width:100%;height:3.375rem;border-radius:4px;border:1px dashed var(--line)}
.kind{letter-spacing:.06em;width:2.6rem}
.ttl{font-weight:600;letter-spacing:-.01em}
.ctx{color:var(--muted);font-size:.8125rem;overflow-wrap:anywhere}
.rec{color:var(--faint);font-size:.75rem;white-space:nowrap;text-align:right}
.rec b{display:block;color:var(--muted);font-weight:600}
.pill.adopt{color:var(--accent);background:var(--card);border-color:var(--accent)}
.cands{border-top:1px solid var(--line);background:var(--card);padding:.75rem .75rem .5rem}
.frame{position:relative}
.frame::after{content:"";position:absolute;top:0;right:0;bottom:.5rem;width:2.5rem;background:linear-gradient(to right,transparent,var(--card));pointer-events:none;transition:opacity .15s}
.frame.end::after{opacity:0}
.cands .lbl{margin-bottom:.5rem;display:flex;gap:.75rem;align-items:baseline;flex-wrap:wrap}
.cands .lbl .dim{text-transform:none;letter-spacing:0;font-weight:400}
.strip{display:flex;gap:.625rem;overflow-x:auto;padding-bottom:.5rem;scroll-snap-type:x proximity}
.cand{flex:none;display:grid;gap:.3rem;scroll-snap-align:start}
.cand button{padding:0;border:0;background:none;cursor:zoom-in;border-radius:6px;overflow:hidden;line-height:0;box-shadow:0 0 0 1px var(--line);position:relative}
.cand button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.cand img{display:block;background:var(--bg)}
.cand.land img{width:240px;height:135px;object-fit:cover}
.cand.port img{width:136px;height:200px;object-fit:cover}
.cand.book img{width:136px;height:204px;object-fit:contain;background:var(--bg)}
.cand.pick button{box-shadow:0 0 0 2px var(--accent)}
.cand .badge{position:absolute;top:.375rem;left:.375rem;font-size:.625rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;padding:.15rem .4rem;border-radius:4px;background:rgba(27,31,36,.8);color:#fff}
.cand.pick .badge{background:var(--accent)}
.cand .badge.top{left:auto;right:.375rem;background:var(--ok)}
.cand .cap{display:flex;justify-content:space-between;gap:.5rem;font-size:.6875rem;color:var(--faint);font-family:var(--mono)}
.prog{margin-top:.5rem;color:var(--muted);font-size:.8125rem}
.err{color:var(--crit)}
.note{padding:.75rem .9rem;border:1px solid var(--line);background:var(--card);border-radius:8px;color:var(--muted)}
dialog{border:0;border-radius:8px;padding:0;background:var(--card);width:fit-content;min-width:min(20rem,96vw);max-width:min(96vw,1400px);box-shadow:0 20px 60px rgba(0,0,0,.4)}
dialog::backdrop{background:rgba(0,0,0,.6)}
dialog img{display:block;max-width:min(96vw,1400px);max-height:80vh;margin:0 auto}
dialog .dbar{display:flex;flex-wrap:wrap;gap:.5rem .75rem;align-items:center;padding:.5rem .75rem;font-size:.8125rem;color:var(--muted);width:0;min-width:100%}
dialog .dbar [data-dialog-caption]{flex:1 1 12rem;min-width:0;overflow-wrap:anywhere}
@media(max-width:900px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:480px){.tiles{grid-template-columns:minmax(0,1fr)}}
@media(max-width:640px){.rh{grid-template-columns:6rem minmax(0,1fr) auto;grid-template-areas:"th txt txt" "pill pill act";row-gap:.5rem}.rh>.pill{justify-self:start}.rh .kind,.rh .rec{display:none}}
`;

const STATE_LABEL: Record<ArtworkState, { text: string; pill: string }> = {
  done: { text: 'done', pill: 'ok' },
  'missing-object': { text: 'no image', pill: 'warn' },
  unlinked: { text: 'no link', pill: 'warn' },
  adopt: { text: 'adoptable', pill: 'adopt' },
  cover: { text: 'cover linked', pill: 'mute' },
  'no-id': { text: 'no id', pill: 'mute' },
  unrecognised: { text: 'unrecognised', pill: 'crit' },
};

/** Whether an image URL is one the page's CSP lets it load: any https URL. */
export const loadableImage = (url: string | null): boolean => {
  if (!url) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * The current image inside a button, so the enlarge is reachable from the
 * keyboard, or the placeholder inside a disabled one. The button is always
 * there, name included: after a pick the client swaps only its child and
 * enables it, so the structure is built here and nowhere else. The
 * placeholder is a span because a button holds phrasing content only.
 */
const thumb = (row: ArtworkRow): SafeHtml =>
  html`<button class="thb" type="button" title="enlarge" aria-label="enlarge the current image"${row.image && loadableImage(row.image) ? '' : ' disabled'}>${
    row.image && loadableImage(row.image) ? html`<img class="th${row.kind === 'movie' ? '' : ' portrait'}" src="${row.image}" alt="" loading="lazy" decoding="async">` : html`<span class="ph"></span>`
  }</button>`;

const rowHtml = (row: ArtworkRow): SafeHtml => {
  const label = STATE_LABEL[row.state];
  const actionable = row.id !== null && row.state !== 'no-id';
  return html`<div class="row" data-kind="${row.kind}" data-id="${row.id ?? ''}" data-state="${row.state}" data-title="${row.title}" data-recent="${row.recent ? '1' : ''}" data-franchise="${row.franchise ?? ''}" data-released="${row.released}" data-q="${`${row.title} ${row.franchise ?? ''} ${row.context ?? ''}`.toLowerCase()}">
  <div class="rh">
    ${thumb(row)}
    <span class="kind">${KIND_LABEL[row.kind]}</span>
    <div class="txt"><div class="ttl">${row.title}</div><div class="ctx">${row.franchise && row.franchise !== row.title ? html`${row.franchise} · ` : null}${row.context ? html`${row.context} · ` : null}row ${row.rowNumber}${row.address ? html` · <span class="mono">${row.address}</span>` : null} · ${row.cell}<span class="mono dims"></span></div></div>
    <span class="pill ${label.pill}" data-pill>${label.text}</span>
    <span class="rec">${row.touched ? html`<b>${row.touched.label}</b>${row.touched.because}` : null}</span>
    ${actionable ? html`<button class="btn quiet act" type="button" data-choose>choose artwork</button>` : html`<span class="act"></span>`}
  </div>
</div>`;
};

/** What the section caption says of each order; the sort buttons carry theirs for the script to copy in. */
const ORDER_CAPTION = { needs: 'needs artwork first, then most recently touched', franchise: 'by franchise, films in release order, then shows, then books' };

const chip = (filter: string, label: string, count: number, pressed = false): SafeHtml =>
  html`<button class="chip" type="button" data-filter="${filter}" aria-pressed="${pressed ? 'true' : 'false'}">${label}<b>${count}</b></button>`;

export const renderArtworkPage = (model: ArtworkModel): string =>
  document({
    title: `${model.appName} artwork`,
    style: STYLE,
    body: html`
<header><div class="bar">
  <span class="mark"></span>
  <h1>${model.appName}</h1>
  <span class="pill ${model.summary.needing ? 'warn' : 'ok'}" data-needing-pill>${model.summary.needing} need artwork</span>
  <span class="meta">v${model.version} · ${model.timezone}<br>artwork · ${model.summary.total} titles · <a href="status" rel="noopener noreferrer">status</a></span>
</div></header>

<div class="wrap">

${model.errors.length === 0 ? null : html`<div class="problems"><ul>${model.errors.map((e) => html`<li>${e}</li>`)}</ul></div>`}
${model.mode === 'apply' ? null : html`<div class="note">Sheet mode is <span class="mono">${model.mode}</span>: images upload, and the link that would be written is reported instead of written.</div>`}

<div class="tiles">
  <div class="tile"><span class="t-name">titles</span><span class="t-head">${model.summary.total}</span><span class="t-next">${model.summary.byKind.show} shows · ${model.summary.byKind.movie} films${model.books ? html` · ${model.summary.byKind.book} books` : null}</span></div>
  <div class="tile${model.summary.needing ? ' warn' : ''}"><span class="t-name">need artwork</span><span class="t-head" data-needing>${model.summary.needing}</span><span class="t-next">no object behind the link, or no link</span></div>
  <div class="tile"><span class="t-name">added by the sync</span><span class="t-head">${model.summary.addedRecently}</span><span class="t-next">in the last ${model.recentWindow}</span></div>
  <div class="tile act"><div><span class="t-name">adoptable</span><span class="t-head" style="display:block">${model.summary.byState.adopt}</span><span class="t-next" data-adopt-progress>films and shows still linking another host</span></div><button class="btn" type="button" data-adopt-all ${model.summary.byState.adopt ? '' : 'disabled'}>Adopt all</button></div>
</div>

<div class="tool">
  <input type="search" data-search placeholder="Filter by title, franchise or status" aria-label="Filter by title, franchise or status">
  ${chip('all', 'All', model.summary.total, true)}
  ${chip('needs', 'Needs artwork', model.summary.needing)}
  ${chip('recent', 'Added by the sync', model.summary.addedRecently)}
  ${chip('show', 'Shows', model.summary.byKind.show)}
  ${chip('movie', 'Films', model.summary.byKind.movie)}
  ${model.books ? chip('book', 'Books', model.summary.byKind.book) : null}
  ${chip('adopt', 'Adoptable', model.summary.byState.adopt)}
  ${chip('no-id', 'No id', model.summary.byState['no-id'])}
  ${model.books ? chip('cover', 'Covers to pick', model.summary.byState.cover) : null}
  <span class="sortby"><span class="lbl">sort</span>
    <button class="chip" type="button" data-sort="needs" data-caption="${ORDER_CAPTION.needs}" aria-pressed="true">needs first</button>
    <button class="chip" type="button" data-sort="franchise" data-caption="${ORDER_CAPTION.franchise}" aria-pressed="false">by franchise</button>
  </span>
</div>

<section>
  <div class="head"><h2 class="name">Titles</h2><span class="sum"><span data-order>${ORDER_CAPTION.needs}</span> · read ${model.built.label} · <a href="artwork?fresh=1">re-read</a> · <span data-showing></span></span></div>
  <div class="rows">${model.rows.map(rowHtml)}</div>
</section>

<section>
  <div class="head"><h2 class="name">What this page does</h2></div>
  <div class="ctx" style="display:grid;gap:.4rem">
    <div>A pick downloads the image through this service and uploads it to <span class="mono">${model.buckets.movie}</span>, <span class="mono">${model.buckets.show}</span>${model.books ? html` or <span class="mono">${model.buckets.book}</span>` : null} under the title's name, then writes the static link into a blank <span class="mono">Artwork</span> cell. A formula cell is never written; a cell already linking the bucket decides the object name itself.</div>
    ${!model.books ? null : html`<div>Adopt all skips books. Adopting copies the cover a cell already links, and every cell on that tab links a cover this page exists to replace — a bulk adopt would put four hundred of them in the bucket. A book is adopted one row at a time, or picked from its covers.</div>`}
    <div><b>Adopt</b> takes the image a row currently links elsewhere and moves it into the bucket the same way. <b>Adopt all</b> runs that over every adoptable row, one at a time, with progress above.</div>
    <div>Sheet writes wait for a running sync and vice-versa, and happen only in <span class="mono">apply</span> mode — in <span class="mono">report</span> the object still uploads and the cell address is reported instead.</div>
  </div>
</section>

<footer>Reads the spreadsheet's tabs, the library, the run history and the buckets · candidates from TMDb, TVDB and Hardcover · images load from their CDNs and the buckets, and this page sends no referrer.</footer>

</div>
<dialog data-dialog><div class="dbar"><span data-dialog-caption></span><button class="btn" type="button" data-dialog-use>Use this one</button><button class="btn quiet" type="button" data-dialog-close>close</button></div><img alt="" data-dialog-image></dialog>
<script src="artwork/app.js"></script>`,
  });
