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
  const setPill = (row, state, text, cls) => {
    row.dataset.state = state;
    const pill = row.querySelector('[data-pill]');
    if (pill) {
      pill.className = 'pill ' + cls;
      pill.textContent = text;
    }
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
  if (list) list.addEventListener('load', (event) => {
    const img = event.target;
    if (img.matches && img.matches('.thb img')) noteDims(img.closest('.row'), dimsOf(img));
  }, true);
  for (const row of rows) noteDims(row, dimsOf(row.querySelector('.thb img')));
  /** Swap the current image after a pick. The button is the renderer's; only its child changes. */
  const setThumb = (row, url) => {
    if (!loadable(url)) return;
    const button = row.querySelector('.thb');
    if (!button) return;
    const img = el('img', 'th' + (row.dataset.kind === 'movie' ? '' : ' portrait'));
    img.alt = '';
    img.loading = 'lazy';
    img.src = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
    button.replaceChildren(img);
    button.disabled = false;
    // An open panel's "current" label describes this image now, not the one it replaced.
    whenSized(img, (dims) => {
      const current = row.querySelector('.cands .current');
      if (current) current.textContent = 'current ' + dims;
    });
  };
  const settle = (row, result) => {
    const link = result.link;
    if (link.status === 'written' || link.status === 'kept') {
      setPill(row, 'done', 'done', 'ok');
      setThumb(row, link.link);
      return 'uploaded';
    }
    if (link.status === 'reported') {
      setThumb(row, link.link);
      return 'uploaded; link reported for ' + link.address + ' (mode is not apply)';
    }
    if (link.status === 'refused') return 'uploaded; link refused: ' + link.detail;
    if (link.status === 'unverified') return 'uploaded; link written at ' + link.address + ' but not read back: ' + link.detail + ' — re-read the page to see whether it landed';
    return 'uploaded; link failed at ' + link.address + ': ' + link.detail;
  };

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
  const pick = async (row, body, progress) => {
    let result = await post(body, false);
    if (result.status === 409 && !body.adopt) {
      const current = result.body && result.body.detail ? result.body.detail : 'the cell links another host';
      if (!window.confirm(row.dataset.title + ': ' + current + '.\n\nReplace it with this image?')) return 'kept the current image';
      result = await post(Object.assign({}, body, { adopt: true }), false);
    }
    if (result.status !== 200) return 'refused: ' + (result.body && (result.body.detail || result.body.error) ? result.body.detail || result.body.error : 'HTTP ' + result.status);
    return settle(row, result.body);
  };

  // --- candidates ------------------------------------------------------------
  const strips = new Map();
  /** Full size. No onUse means the image is only being looked at, so the button is hidden. */
  const openDialog = (url, caption, onUse) => {
    if (!dialog || !dialog.showModal) return;
    const img = dialog.querySelector('[data-dialog-image]');
    img.src = loadable(url) ? url : '';
    dialog.querySelector('[data-dialog-caption]').textContent = caption;
    const use = dialog.querySelector('[data-dialog-use]');
    use.hidden = !onUse;
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
    openDialog(img.src, row.dataset.title + ' · current image' + (dims ? ' · ' + dims : ''), null);
  });

  const renderStrip = (row, listing, panel) => {
    panel.replaceChildren();
    const label = el('div', 'lbl');
    const kind = row.dataset.kind;
    const what = kind === 'movie' ? ' backdrops from TMDb' : kind === 'show' ? ' posters from TVDB' : ' covers from Hardcover';
    label.appendChild(el('span', '', listing.candidates.length + what));
    const ranked = kind === 'movie' ? '16:9 only · English first, ranked by votes' : kind === 'show' ? 'English first, 680×1000 next, then by score' : 'English first, then 2:3, then 300px wide, then UK, then readers';
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
      // A book tile is its own class rather than 'port' because it renders
      // 'contain' where the other two crop. Nothing authors a book cover to a
      // standard, so a square audiobook cover reaches the strip; cropped to
      // 2:3 it would look like the poster it is not, hiding the very defect
      // its low rank is telling the reader about.
      const shape = kind === 'movie' ? 'land' : kind === 'book' ? 'book' : 'port';
      const item = el('div', 'cand ' + shape + (i === 0 ? ' pick' : ''));
      const button = el('button');
      button.type = 'button';
      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      if (loadable(cand.thumb)) img.src = cand.thumb;
      button.appendChild(img);
      // A null language means textless on a film backdrop and merely unknown
      // on a book cover, so a book badges its country — the fact its rank
      // turned on — and falls back to the language. The first tile's rank is
      // a badge of its own, so the language is shown on every tile.
      const mark = kind === 'book' ? cand.country || languageName(cand.language) || '?' : languageOf(cand, kind);
      button.appendChild(el('span', 'badge', mark));
      if (i === 0) button.appendChild(el('span', 'badge top', 'top'));
      const cap = el('div', 'cap');
      cap.appendChild(el('span', '', cand.width + '×' + cand.height));
      cap.appendChild(el('span', '', tally(cand, kind)));
      item.appendChild(button);
      item.appendChild(cap);
      if (kind === 'book') {
        // A cover reads as 1:1.50 against the 1:1.5 of 2:3 — the shape tier's
        // own question, in the form a reader can compare at a glance. The
        // dimensions above say how big; this says what shape.
        const shapeCap = el('div', 'cap');
        shapeCap.appendChild(el('span', '', cand.format || 'edition'));
        shapeCap.appendChild(el('span', '', shapeOf(cand.width, cand.height)));
        item.appendChild(shapeCap);
      }
      const use = async () => {
        for (const other of strip.querySelectorAll('.cand')) other.classList.remove('pick');
        item.classList.add('pick');
        progress.textContent = 'uploading…';
        progress.textContent = await pick(row, { kind, id: Number(row.dataset.id), url: cand.url }, progress);
      };
      button.addEventListener('click', () => openDialog(cand.url, row.dataset.title + ' · ' + describe(cand, kind), use));
      strip.appendChild(item);
    });
    panel.appendChild(frame);
    panel.appendChild(progress);
    // A book's linked cover is adopted here, one row at a time.
    if (LINKED.has(row.dataset.state)) {
      const adopt = el('button', 'btn quiet', 'Adopt the current image instead');
      adopt.type = 'button';
      adopt.addEventListener('click', async () => {
        progress.textContent = 'adopting…';
        progress.textContent = await pick(row, { kind, id: Number(row.dataset.id), adopt: true }, progress);
      });
      progress.before(adopt);
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
        const response = await fetch('artwork/candidates?' + params.toString());
        const listing = await read(response);
        if (response.status !== 200) throw new Error(listing.detail || listing.error || 'HTTP ' + response.status);
        renderStrip(row, listing, panel);
      } catch (err) {
        panel.replaceChildren(el('div', 'prog err', 'could not load candidates: ' + (err && err.message ? err.message : String(err))));
      }
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
