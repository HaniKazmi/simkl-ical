/**
 * The HTML primitives every page is built from, and the look they share.
 *
 * Everything a page interpolates that is not a config constant is
 * attacker-or-accident controlled: SIMKL show titles, spreadsheet contents
 * and tab names, Google and SIMKL error bodies. So the primitives escape by
 * default — a bare `escapeHtml` remembered at a hundred call sites is a rule,
 * and rules get forgotten. Two files render pages, `status/2-html.ts` and
 * `artwork/4-html.ts`, and they are the ones to audit for interpolation.
 */

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

/** The escape hatch. Its call sites are the stylesheets and the client script, and nothing that carries input. */
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



// --- The look --------------------------------------------------------------

/**
 * Inlined, and the reason `raw()` exists: a stylesheet cannot be escaped and
 * stay one, and it is the one string here with no untrusted input. External
 * assets are out — the feed token is in every page's URL, and any off-origin
 * request would carry it out in a `Referer` header.
 *
 * The palette, the type stack, the header and the card treatment come from
 * the index at hani.fyi that links here; the two are consecutive screens.
 * What that page has no need for is state, so `--ok/--warn/--crit` are added
 * from the same family, and `--faint` gives labels a third rank below
 * `--muted`. Each page appends what only it needs.
 */
export const BASE_STYLE = `
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
.msg{padding:.6rem .9rem;font-size:.8125rem;font-family:var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
footer{color:var(--faint);font-size:.8125rem;padding:.25rem .25rem 0}
`;

/**
 * The document shell around a page's body: the head every page shares, the
 * icon links, and one inlined stylesheet. The icon hrefs are document-relative
 * — `favicon.ico`, not `/favicon.ico` — which is what makes them resolve under
 * the token segment of the page's own URL without the page naming it.
 */
export const document = ({ title, style, head = null, body }: { title: string; style: string; head?: SafeHtml | null; body: SafeHtml }): string =>
  toHtml(html`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title>
<link rel="icon" href="favicon.ico" sizes="32x32">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<style>${raw(style)}</style>
${head}</head><body>
${body}
</body></html>`);
