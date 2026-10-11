/**
 * The page's script, served as `artwork/app.js` under the page's own CSP
 * (`script-src 'self'`). Kept as a string beside the renderer so the two
 * agree on every `data-` hook, and so the server has one artefact to serve.
 *
 * Rules the script keeps, and the tests pin: no `innerHTML` and no inline
 * handlers — every node is built with `createElement` and `textContent`, so a
 * title or an upstream error cannot become markup; an `<img>` gets a `src`
 * only when it is an https URL, the same bound the CSP's `img-src` enforces,
 * so a bad URL fails here with a message rather than silently in the console;
 * every request is relative, so the feed token never appears in the script.
 */


export const CLIENT_SCRIPT = String.raw`'use strict';
(() => {
  /** Films, then shows, then books, within one franchise. */
  const KIND_RANK = { movie: 0, show: 1, book: 2 };
  const NEEDS = new Set(['missing-object', 'unlinked', 'adopt']);
  /** Mirrors LINKED_ELSEWHERE in 1-index.ts: the states a cell linking another host lands in. */
  const LINKED = new Set(['adopt', 'cover']);
  // The upstreams send ISO 639 codes in two widths, TVDB three letters and
  // TMDB and Hardcover two, and the browser names both; a code it cannot
  // parse is shown as sent.
  const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
  const languageName = (code) => {
    if (!code) return null;
    try {
      return languageNames.of(code.toLowerCase());
    } catch {
      return code;
    }
  };
  // A backdrop with no language is textless: TMDB files title-free art under
  // null. A poster or a cover with none is merely unrecorded.
  const languageOf = (cand, kind) => languageName(cand.language) || (kind === 'movie' ? 'textless' : 'unknown');
  const rows = Array.from(document.querySelectorAll('.row'));
  const chips = Array.from(document.querySelectorAll('[data-filter]'));
  const search = document.querySelector('[data-search]');
  const showing = document.querySelector('[data-showing]');
  const dialog = document.querySelector('[data-dialog]');
  let filter = 'all';
  let query = '';

  const loadable = (url) => {
    try {
      return new URL(url).protocol === 'https:';
    } catch {
      return false;
    }
  };
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // --- filtering -----------------------------------------------------------
  // A chip is named after the state or kind it lists, so those need no case each.
  const matchesFilter = (row, name) =>
    name === 'all' ||
    (name === 'needs' && NEEDS.has(row.dataset.state)) ||
    (name === 'recent' && row.dataset.recent === '1') ||
    (name === 'seasons' && row.dataset.seasonsOpen === '1') ||
    name === row.dataset.state ||
    name === row.dataset.kind;
  const matches = (row) => matchesFilter(row, filter) && (!query || row.dataset.q.includes(query));
  const applyFilter = () => {
    let shown = 0;
    for (const row of rows) {
      const ok = matches(row);
      row.hidden = !ok;
      if (ok) shown += 1;
    }
    // A franchise heading with nothing visible under it goes too. Membership
    // is held rather than walked, because a row outside any group can follow
    // a group's last row with no heading between them.
    for (const [heading, members] of headings) heading.hidden = !members.some((row) => !row.hidden);
    if (showing) showing.textContent = 'showing ' + shown + ' of ' + rows.length;
  };

  // --- ordering ------------------------------------------------------------
  // The server's order is needs-first, then most recently touched. By
  // franchise sorts the same rows by franchise, films in release order, then
  // shows, then books; a title with no franchise sorts under its own title.
  // A heading goes only over a group of two or more: over one row it repeats
  // the title printed directly beneath it, and most rows have no franchise.
  const list = document.querySelector('.rows');
  const order = document.querySelector('[data-order]');
  const serverOrder = rows.slice();
  /** Each heading on the page, and the rows under it. */
  const headings = new Map();
  const franchiseOf = (row) => row.dataset.franchise || row.dataset.title;
  /** One collator: the sort's group key and the run pass below compare with the same one by construction. */
  const collate = new Intl.Collator(undefined, { sensitivity: 'base' }).compare;
  const byFranchise = (a, b) =>
    collate(franchiseOf(a), franchiseOf(b)) ||
    KIND_RANK[a.dataset.kind] - KIND_RANK[b.dataset.kind] ||
    (a.dataset.released || '9999').localeCompare(b.dataset.released || '9999') ||
    collate(a.dataset.title, b.dataset.title);
  const reorder = (mode) => {
    if (!list) return;
    for (const heading of headings.keys()) heading.remove();
    headings.clear();
    if (mode === 'franchise') {
      // The sort's first key is the group, so a group's rows are contiguous
      // and one pass finds each run.
      const runs = [];
      for (const row of rows.slice().sort(byFranchise)) {
        const run = runs[runs.length - 1];
        if (run && collate(run.name, franchiseOf(row)) === 0) run.rows.push(row);
        else runs.push({ name: franchiseOf(row), rows: [row] });
      }
      for (const run of runs) {
        if (run.rows.length > 1) {
          const heading = el('div', 'grp', run.name);
          list.appendChild(heading);
          headings.set(heading, run.rows);
        }
        for (const row of run.rows) list.appendChild(row);
      }
    } else {
      for (const row of serverOrder) list.appendChild(row);
    }
    applyFilter();
  };
  const sorts = Array.from(document.querySelectorAll('[data-sort]'));
  for (const button of sorts) {
    button.addEventListener('click', () => {
      for (const other of sorts) other.setAttribute('aria-pressed', String(other === button));
      if (order) order.textContent = button.dataset.caption;
      reorder(button.dataset.sort);
    });
  }
  for (const chip of chips) {
    chip.addEventListener('click', () => {
      for (const other of chips) other.setAttribute('aria-pressed', String(other === chip));
      filter = chip.dataset.filter;
      applyFilter();
    });
  }
  if (search) search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    applyFilter();
  });
  applyFilter();

  // --- state after a pick ----------------------------------------------------
  // The chip counts and the two headline numbers follow the rows, so a pick
  // is reflected without a reload; the tiles the server computed are left
  // for the next read.
  const recount = () => {
    const count = (name) => rows.filter((row) => matchesFilter(row, name)).length;
    for (const chip of chips) {
      const b = chip.querySelector('b');
      if (b) b.textContent = String(count(chip.dataset.filter));
    }
    const needing = count('needs');
    const headline = document.querySelector('[data-needing]');
    if (headline) headline.textContent = String(needing);
    const pill = document.querySelector('[data-needing-pill]');
    if (pill) {
      pill.textContent = needing + ' need artwork';
      pill.className = 'pill ' + (needing ? 'warn' : 'ok');
    }
  };
  /** Repaint a status pill in place, a row's or a season's. */
  const paintPill = (pill, text, cls) => {
    pill.className = 'pill ' + cls;
    pill.textContent = text;
  };
  const setPill = (row, state, text, cls) => {
    row.dataset.state = state;
    const pill = row.querySelector('[data-pill]');
    if (pill) paintPill(pill, text, cls);
    recount();
  };
  // The current image's size is known nowhere but the browser: the cell holds
  // a URL, the bucket listing holds bytes, and neither says how many pixels are
  // behind the link. So it is read off the thumbnail once that loads, and a
  // row scrolled past unloaded shows nothing until it does. The ratio is
  // written the way the candidate tiles write theirs — height over width for
  // a portrait, width over height for a landscape — so the two compare at a glance.
  const shapeOf = (width, height) => (height >= width ? '1:' + (height / width).toFixed(2) : (width / height).toFixed(2) + ':1');
  const dimsOf = (img) => (img && img.naturalWidth > 0 ? img.naturalWidth + '×' + img.naturalHeight + ' · ' + shapeOf(img.naturalWidth, img.naturalHeight) : null);
  /** Run fn with the image's dimensions once it has them. */
  const whenSized = (img, fn) => {
    if (!img) return;
    const now = dimsOf(img);
    if (now) fn(now);
    else img.addEventListener('load', () => {
      const dims = dimsOf(img);
      if (dims) fn(dims);
    }, { once: true });
  };
  /** Fill the row's dims cell, which the renderer leaves empty; text only, so no node is inserted while the list is scrolling. */
  const noteDims = (row, dims) => {
    const span = row.querySelector('.dims');
    if (span && dims) span.textContent = ' · ' + dims;
  };
  // Thumbnails load lazily as the page scrolls. 'load' does not bubble, so one
  // capturing listener on the list hears every one in place of a listener per
  // row; images already complete from cache are read once here.
  // The row header's image only: a season's current image is inside the row
  // too, and its size is not the title's.
  if (list) list.addEventListener('load', (event) => {
    const img = event.target;
    if (img.matches && img.matches('.rh .thb img')) noteDims(img.closest('.row'), dimsOf(img));
  }, true);
  for (const row of rows) noteDims(row, dimsOf(row.querySelector('.thb img')));
  /** A URL the browser fetches afresh rather than from its cache: a pick replaces the object behind a link in place. */
  const busted = (url) => url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
  /**
   * Put an image in a current-image button, or the placeholder where there is
   * none to show, and return the image. The button stays; only its child
   * changes, which is how the renderer's buttons are built to be updated.
   */
  const fillThumb = (button, url, cls) => {
    const showable = Boolean(url) && loadable(url);
    button.disabled = !showable;
    if (!showable) {
      button.replaceChildren(el('span', 'ph'));
      return null;
    }
    const img = el('img', cls);
    img.alt = '';
    img.loading = 'lazy';
    img.src = url;
    button.replaceChildren(img);
    return img;
  };
  /** Swap the current image after a pick. */
  const setThumb = (row, url) => {
    if (!loadable(url)) return;
    const button = row.querySelector('.thb');
    if (!button) return;
    const img = fillThumb(button, busted(url), 'th' + (row.dataset.kind === 'movie' ? '' : ' portrait'));
    // An open panel's "current" label describes this image now, not the one it replaced.
    whenSized(img, (dims) => {
      const current = row.querySelector('.cands .current');
      if (current) current.textContent = 'current ' + dims;
    });
  };
  /** What a pick's link step came to, in the reader's words; one wording for a title and a season. */
  const outcome = (link) => {
    if (link.status === 'written' || link.status === 'kept') return 'uploaded';
    if (link.status === 'reported') return 'uploaded; link reported for ' + link.address + ' (mode is not apply)';
    if (link.status === 'refused') return 'uploaded; link refused: ' + link.detail;
    if (link.status === 'unverified') return 'uploaded; link written at ' + link.address + ' but not read back: ' + link.detail + ' — re-read the page to see whether it landed';
    return 'uploaded; link failed at ' + link.address + ': ' + link.detail;
  };
  /**
   * Show a pick's link outcome: the image wherever an object now stands behind
   * the link, and the done state only where the cell holds it. One branching
   * for a title and a season; each passes what shows it.
   */
  const settleLink = (link, { thumb, done }) => {
    if (link.status === 'written' || link.status === 'kept' || link.status === 'reported') thumb(link.link);
    if (link.status === 'written' || link.status === 'kept') done();
    return outcome(link);
  };
  const settle = (row, result) => settleLink(result.link, { thumb: (url) => setThumb(row, url), done: () => setPill(row, 'done', 'done', 'ok') });

  // --- the API ---------------------------------------------------------------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const read = async (response) => {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return { error: text || response.statusText };
    }
  };
  /** GET a listing, throwing the route's own words on anything but a 200. */
  const getJson = async (url) => {
    const response = await fetch(url);
    const body = await read(response);
    if (response.status !== 200) throw new Error(body.detail || body.error || 'HTTP ' + response.status);
    return body;
  };
  const messageOf = (err) => (err && err.message ? err.message : String(err));
  /** POST a pick; a 503 while the sheet is held waits Retry-After and tries once more. */
  const post = async (body, retried) => {
    const response = await fetch('artwork/pick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (response.status === 503 && !retried) {
      const wait = Number(response.headers.get('retry-after')) || 10;
      await sleep(wait * 1000);
      return post(body, true);
    }
    return { status: response.status, body: await read(response) };
  };
  /**
   * Post a pick and settle what came back. A season passes its own name for
   * the confirm and its own settle, since what changes on the page is that
   * season's header rather than the row's.
   */
  const pick = async (row, body, { apply = (result) => settle(row, result), name = row.dataset.title } = {}) => {
    let result = await post(body, false);
    if (result.status === 409 && !body.adopt) {
      const current = result.body && result.body.detail ? result.body.detail : 'the cell links another host';
      if (!window.confirm(name + ': ' + current + '.\n\nReplace it with this image?')) return 'kept the current image';
      result = await post(Object.assign({}, body, { adopt: true }), false);
    }
    if (result.status !== 200) return 'refused: ' + (result.body && (result.body.detail || result.body.error) ? result.body.detail || result.body.error : 'HTTP ' + result.status);
    return apply(result.body);
  };

  // --- candidates ------------------------------------------------------------
  const strips = new Map();
  /** Full size. No onUse means the image is only being looked at, so the button is hidden. */
  const openDialog = (url, caption, onUse, useLabel) => {
    if (!dialog || !dialog.showModal) return;
    const img = dialog.querySelector('[data-dialog-image]');
    img.src = loadable(url) ? url : '';
    dialog.querySelector('[data-dialog-caption]').textContent = caption;
    const use = dialog.querySelector('[data-dialog-use]');
    use.hidden = !onUse;
    use.textContent = useLabel || 'Use this one';
    use.onclick = () => {
      dialog.close();
      if (onUse) onUse();
    };
    dialog.showModal();
  };
  if (dialog) {
    dialog.querySelector('[data-dialog-close]').addEventListener('click', () => dialog.close());
    // Click on the backdrop closes too: the dialog's own box is the only thing the click can miss.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }
  // One reading of an upstream's own figure, for the tile caption and the
  // dialog both, so the two cannot name it differently. Hardcover counts the
  // readers holding an edition, which is not a vote on its cover. TVDB
  // publishes a score and no count, and the score is an internal figure in
  // the hundred thousands that orders nothing a reader can check, so a
  // poster says its language instead.
  const tally = (cand, kind) => (kind === 'book' ? cand.votes + ' readers' : cand.votes !== null ? cand.votes + ' votes' : languageOf(cand, kind));

  const describe = (cand, kind) => cand.width + '×' + cand.height + ' · ' + tally(cand, kind) + ' · ' + cand.source;

  // The row's current image enlarges the same way; the URL is the cell's. One
  // listener on the list, reading the image at click time, so the thumbnail
  // 'setThumb' swaps in after a pick needs no wiring of its own.
  if (list) list.addEventListener('click', (event) => {
    const button = event.target.closest('.thb');
    if (!button) return;
    const img = button.querySelector('img');
    const row = button.closest('.row');
    if (!img || !row) return;
    const dims = dimsOf(img);
    openDialog(img.src, (button.dataset.name || row.dataset.title) + ' · current image' + (dims ? ' · ' + dims : ''), null);
  });

  /**
   * One candidate tile: the thumbnail in a button, badges over it as
   * '[text, class]', and caption rows beneath it as '[left, right]'. 'onOpen'
   * is handed the tile, to mark it picked.
   */
  const tile = (cand, cls, badges, caps, onOpen) => {
    const item = el('div', 'cand' + (cls ? ' ' + cls : ''));
    const button = el('button');
    button.type = 'button';
    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    if (loadable(cand.thumb)) img.src = cand.thumb;
    button.appendChild(img);
    for (const [text, badgeCls] of badges) button.appendChild(el('span', badgeCls, text));
    item.appendChild(button);
    for (const [left, right] of caps) {
      const cap = el('div', 'cap');
      cap.appendChild(el('span', '', left));
      cap.appendChild(el('span', '', right));
      item.appendChild(cap);
    }
    button.addEventListener('click', () => onOpen(item));
    return item;
  };
  /** Mark a tile picked among the others in 'container' and run the pick, reporting into 'progress'. */
  const choose = async (container, item, progress, run) => {
    for (const other of container.querySelectorAll('.cand')) other.classList.remove('pick');
    item.classList.add('pick');
    progress.textContent = 'uploading…';
    progress.textContent = await run();
  };
  /** The button that copies a cell's current image into the bucket instead, reporting into 'progress'. */
  const adoptButton = (progress, run) => {
    const adopt = el('button', 'btn quiet', 'Adopt the current image instead');
    adopt.type = 'button';
    adopt.addEventListener('click', async () => {
      progress.textContent = 'adopting…';
      progress.textContent = await run();
    });
    return adopt;
  };

  const renderStrip = (row, listing, panel) => {
    panel.replaceChildren();
    const label = el('div', 'lbl');
    const kind = row.dataset.kind;
    const what = kind === 'movie' ? ' backdrops from TMDb' : kind === 'show' ? ' posters from TVDB' : ' covers from Hardcover';
    label.appendChild(el('span', '', listing.candidates.length + what));
    const ranked = kind === 'movie' ? '16:9 only · English first, ranked by votes' : kind === 'show' ? 'English first, then largest, then by score' : 'English first, then 2:3, then 300px wide, then UK, then readers';
    label.appendChild(el('span', 'dim', ranked + ' · click a tile to enlarge and use it'));
    // The current image's size beside the candidates', so a pick can be judged against what it replaces.
    const current = el('span', 'dim current');
    whenSized(row.querySelector('.thb img'), (dims) => {
      current.textContent = 'current ' + dims;
    });
    label.appendChild(current);
    if (listing.error) label.appendChild(el('span', 'err', listing.error));
    panel.appendChild(label);
    const strip = el('div', 'strip');
    // The fade on the frame's right edge says the strip scrolls; it goes once
    // the strip has nothing further to show. On the frame, not the strip,
    // because a pseudo-element on a scroll container scrolls with it.
    const frame = el('div', 'frame');
    frame.appendChild(strip);
    const edge = () => frame.classList.toggle('end', strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1);
    strip.addEventListener('scroll', edge, { passive: true });
    // Fires once the strip is in the document and sized, which is the first reading.
    new ResizeObserver(edge).observe(strip);
    const progress = el('div', 'prog');
    listing.candidates.forEach((cand, i) => {
      // A book tile is its own class rather than 'port' because its box takes
      // the cover's own width where the other two crop to a fixed one. Nothing
      // authors a book cover to a standard, so a square audiobook cover
      // reaches the strip; cropped to 2:3 it would look like the poster it is
      // not, hiding the very defect its low rank is telling the reader about,
      // and letterboxed into 2:3 the border would stand off every cover that
      // is not exactly that shape.
      const shape = kind === 'movie' ? 'land' : kind === 'book' ? 'book' : 'port';
      // A null language means textless on a film backdrop and merely unknown
      // on a book cover, so a book badges its country — the fact its rank
      // turned on — and falls back to the language. The first tile's rank is
      // a badge of its own, so the language is shown on every tile.
      const mark = kind === 'book' ? cand.country || languageName(cand.language) || '?' : languageOf(cand, kind);
      const badges = i === 0 ? [[mark, 'badge'], ['top', 'badge top']] : [[mark, 'badge']];
      const caps = [[cand.width + '×' + cand.height, tally(cand, kind)]];
      // A cover reads as 1:1.50 against the 1:1.5 of 2:3 — the shape tier's
      // own question, in the form a reader can compare at a glance. The
      // dimensions above say how big; this says what shape.
      if (kind === 'book') caps.push([cand.format || 'edition', shapeOf(cand.width, cand.height)]);
      const item = tile(cand, shape + (i === 0 ? ' pick' : ''), badges, caps, (picked) =>
        openDialog(cand.url, row.dataset.title + ' · ' + describe(cand, kind), () => choose(strip, picked, progress, () => pick(row, { kind, id: Number(row.dataset.id), url: cand.url }))),
      );
      strip.appendChild(item);
    });
    panel.appendChild(frame);
    panel.appendChild(progress);
    // A book's linked cover is adopted here, one row at a time.
    if (LINKED.has(row.dataset.state)) progress.before(adoptButton(progress, () => pick(row, { kind, id: Number(row.dataset.id), adopt: true })));
  };

  // --- season posters ----------------------------------------------------------
  // A show offering season posters opens a panel below its own strip: one
  // section per season row, each opening on its own TVDB season with the rest
  // folded. A folded group builds its tiles the first time it is opened, so a
  // series with hundreds of season posters loads only the ones looked at.
  /** Mirrors STATE_LABEL in 4-html.ts, but a blank season reads as a choice rather than a warning. */
  const SEASON_PILL = {
    done: ['done', 'ok'],
    'missing-object': ['no image', 'warn'],
    unlinked: ['blank', 'mute'],
    adopt: ['adoptable', 'adopt'],
    'no-id': ['no id', 'mute'],
    unrecognised: ['unrecognised', 'crit'],
  };
  const pillFor = (state) => SEASON_PILL[state] || [state, 'mute'];
  /**
   * The row's own summary of its seasons, kept to what the panel now knows. A
   * pick only ever links a season, so it can take the row off the Season
   * posters chip but never put it on — that is the server's rule to decide.
   */
  const recountSeasons = (row, seasonRows) => {
    const linked = seasonRows.filter((r) => r.state === 'done').length;
    const line = row.querySelector('[data-seasons-line]');
    if (line) line.textContent = 'seasons ' + linked + '/' + seasonRows.length + ' linked';
    if (!seasonRows.some((r) => NEEDS.has(r.state))) row.dataset.seasonsOpen = '';
    recount();
  };
  /** A season's current-image button; 'fillThumb' puts the image in it. */
  const seasonThumb = (name) => {
    const button = el('button', 'thb');
    button.type = 'button';
    button.title = 'enlarge';
    button.setAttribute('aria-label', 'enlarge the current image');
    button.dataset.name = name;
    return button;
  };
  /** A fold with a bold heading and a count after it. */
  const fold = (label, count) => {
    const details = el('details');
    const summary = el('summary');
    summary.appendChild(el('b', '', label));
    summary.appendChild(document.createTextNode(' · ' + count));
    details.appendChild(summary);
    return details;
  };
  /** One group's tiles under its fold, built when the fold first opens — or now, for the group a row opens on. */
  const groupFold = (group, open, onTile) => {
    const details = fold(group.label, group.candidates.length + (open ? ' · this season' : ''));
    const build = () => {
      const grid = el('div', 'sgrid');
      for (const cand of group.candidates) {
        const badges = [[languageOf(cand, 'show'), 'badge']];
        if (cand.url === group.preferred) badges.push(['TVDB default', 'badge top']);
        grid.appendChild(tile(cand, '', badges, [[cand.width + '×' + cand.height, shapeOf(cand.width, cand.height)]], (item) => onTile(cand, group, item)));
      }
      details.appendChild(grid);
    };
    if (open) {
      details.open = true;
      build();
    } else {
      details.addEventListener('toggle', build, { once: true });
    }
    return details;
  };
  /**
   * One season row: its header, the group it opens on, and every other group
   * of its series behind one fold whose own folds are built when it opens —
   * Doctor Who's 26 rows each carry some 44 groups, and building them all up
   * front is a thousand folds nobody opens.
   */
  const renderSeason = (row, seasonRow, series, multiple, onDone) => {
    const name = row.dataset.title + ' S' + seasonRow.season;
    const section = el('section', 'season');
    const head = el('div', 'sh');
    const thumb = seasonThumb(name);
    fillThumb(thumb, seasonRow.current.exists === false ? null : seasonRow.current.url, 'th');
    head.appendChild(thumb);
    head.appendChild(el('span', 'sk', 'S' + seasonRow.season));
    const pill = el('span', 'pill');
    paintPill(pill, ...pillFor(seasonRow.state));
    head.appendChild(pill);
    head.appendChild(el('span', 'ctx', 'row ' + seasonRow.rowNumber + (seasonRow.address ? ' · ' + seasonRow.address : '') + ' · ' + seasonRow.key));
    if (multiple && series) head.appendChild(el('span', 'ctx', 'from ' + (series.name || 'TVDB ' + series.tvdbId)));
    section.appendChild(head);
    const progress = el('div', 'prog');
    const body = (extra) => Object.assign({ kind: 'show', id: Number(row.dataset.id), season: seasonRow.season }, extra);
    const apply = (result) =>
      settleLink(result.link, {
        thumb: (url) => fillThumb(thumb, busted(url), 'th'),
        done: () => {
          seasonRow.state = 'done';
          paintPill(pill, ...pillFor('done'));
          onDone();
        },
      });
    const onTile = (cand, group, item) =>
      openDialog(cand.url, name + ' · ' + group.label + ' · ' + describe(cand, 'show'), () => choose(section, item, progress, () => pick(row, body({ url: cand.url }), { apply, name })), 'Use for S' + seasonRow.season);
    if (!series) {
      section.appendChild(el('div', 'prog err', seasonRow.tvdbId === null ? 'no TVDB series is known for this row' : 'TVDB did not answer for this row\'s series'));
    } else {
      const open = series.groups.find((g) => g.key === seasonRow.open);
      if (open) section.appendChild(groupFold(open, true, onTile));
      const rest = series.groups.filter((g) => g !== open);
      if (rest.length) {
        const others = fold(open ? 'Other seasons and posters' : 'TVDB posters', rest.length + (rest.length === 1 ? ' group' : ' groups'));
        others.classList.add('others');
        others.addEventListener('toggle', () => {
          for (const group of rest) others.appendChild(groupFold(group, false, onTile));
        }, { once: true });
        section.appendChild(others);
      }
    }
    if (LINKED.has(seasonRow.state)) section.appendChild(adoptButton(progress, () => pick(row, body({ adopt: true }), { apply, name })));
    section.appendChild(progress);
    return section;
  };
  const renderSeasons = (row, listing, box) => {
    box.replaceChildren();
    const label = el('div', 'lbl');
    const posters = listing.series.reduce((n, s) => n + s.groups.reduce((m, g) => m + g.candidates.length, 0), 0);
    const count = (n, one, many) => n + ' ' + (n === 1 ? one : many);
    label.appendChild(el('span', '', count(listing.rows.length, 'season row', 'season rows') + ' · ' + count(posters, 'poster', 'posters') + ' from TVDB'));
    label.appendChild(el('span', 'dim', 'each season opens on its own TVDB season · English first, then largest · click a poster to enlarge and use it'));
    for (const error of listing.errors) label.appendChild(el('span', 'err', error));
    box.appendChild(label);
    const nav = el('div', 'snav');
    nav.setAttribute('role', 'navigation');
    nav.setAttribute('aria-label', 'Seasons');
    box.appendChild(nav);
    const multiple = listing.series.length > 1;
    for (const seasonRow of listing.rows) {
      const series = listing.series.find((s) => s.tvdbId === seasonRow.tvdbId) || null;
      const chip = el('button', 'chip' + (seasonRow.state === 'done' ? ' done' : ''), 'S' + seasonRow.season);
      chip.type = 'button';
      const section = renderSeason(row, seasonRow, series, multiple, () => {
        chip.classList.add('done');
        recountSeasons(row, listing.rows);
      });
      chip.addEventListener('click', () => section.scrollIntoView({ block: 'start' }));
      nav.appendChild(chip);
      box.appendChild(section);
    }
  };
  const loadSeasons = async (row, panel) => {
    const box = el('div', 'seasons');
    box.appendChild(el('div', 'prog', 'loading season posters…'));
    panel.appendChild(box);
    try {
      renderSeasons(row, await getJson('artwork/seasons?' + new URLSearchParams({ id: row.dataset.id }).toString()), box);
    } catch (err) {
      box.replaceChildren(el('div', 'prog err', 'could not load season posters: ' + messageOf(err)));
    }
  };

  for (const row of rows) {
    const button = row.querySelector('[data-choose]');
    if (!button) continue;
    button.addEventListener('click', async () => {
      const open = strips.get(row);
      if (open) {
        open.hidden = !open.hidden;
        button.textContent = open.hidden ? 'choose artwork' : 'close';
        return;
      }
      const panel = el('div', 'cands');
      panel.appendChild(el('div', 'prog', 'loading candidates…'));
      row.appendChild(panel);
      strips.set(row, panel);
      button.textContent = 'close';
      const params = new URLSearchParams({ kind: row.dataset.kind, id: row.dataset.id });
      try {
        renderStrip(row, await getJson('artwork/candidates?' + params.toString()), panel);
      } catch (err) {
        panel.replaceChildren(el('div', 'prog err', 'could not load candidates: ' + messageOf(err)));
      }
      // The renderer sets data-seasons only on a show offering season posters.
      if (row.dataset.seasons) await loadSeasons(row, panel);
    });
  }

  // --- adopt all ---------------------------------------------------------------
  const adoptAll = document.querySelector('[data-adopt-all]');
  const adoptProgress = document.querySelector('[data-adopt-progress]');
  if (adoptAll) adoptAll.addEventListener('click', async () => {
    // A book's linked cover is 'cover', never 'adopt', so the kind check is a
    // second copy of that rule in the one place where a regression in it
    // would freeze four hundred covers in the bucket.
    const targets = rows.filter((row) => row.dataset.state === 'adopt' && row.dataset.id && row.dataset.kind !== 'book');
    if (!targets.length) return;
    if (!window.confirm('Copy the image behind ' + targets.length + ' rows into the bucket and rewrite each cell to the static link?')) return;
    adoptAll.disabled = true;
    let done = 0;
    const failures = [];
    // Paced: a pick is three Sheets requests, and the API allows sixty a
    // minute per user. Faster than this and the write — which is never
    // retried — starts meeting 429s.
    const PACE_MS = 3500;
    for (const row of targets) {
      done += 1;
      const started = Date.now();
      adoptProgress.textContent = 'adopting ' + done + ' of ' + targets.length + ' · ' + row.dataset.title;
      const outcome = await pick(row, { kind: row.dataset.kind, id: Number(row.dataset.id), adopt: true });
      if (!outcome.startsWith('uploaded')) failures.push(row.dataset.title + ': ' + outcome);
      const remaining = PACE_MS - (Date.now() - started);
      if (remaining > 0 && done < targets.length) await sleep(remaining);
    }
    adoptProgress.textContent = 'adopted ' + (targets.length - failures.length) + ' of ' + targets.length + (failures.length ? ' · ' + failures.length + ' failed: ' + failures.join('; ') : '');
    adoptAll.disabled = false;
  });
})();
`;
