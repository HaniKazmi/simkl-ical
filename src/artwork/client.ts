/**
 * The page's script, served as `artwork/app.js` under the page's own CSP
 * (`script-src 'self'`). Kept as a string beside the renderer so the two
 * agree on every `data-` hook, and so the server has one artefact to serve.
 *
 * Rules the script keeps, and the tests pin: no `innerHTML` and no inline
 * handlers — every node is built with `createElement` and `textContent`, so a
 * title or an upstream error cannot become markup; an `<img>` gets a `src`
 * only after the host passes the same allowlist the CSP enforces, so a bad
 * URL fails here with a message rather than silently in the console; every
 * request is relative, so the feed token never appears in the script.
 */

export const IMAGE_HOSTS_CLIENT = ['image.tmdb.org', 'artworks.thetvdb.com', 'storage.googleapis.com'];

export const CLIENT_SCRIPT = String.raw`'use strict';
(() => {
  const HOSTS = ${JSON.stringify(IMAGE_HOSTS_CLIENT)};
  const NEEDS = new Set(['missing-object', 'unlinked', 'adopt']);
  const rows = Array.from(document.querySelectorAll('.row'));
  const chips = Array.from(document.querySelectorAll('.chip'));
  const search = document.querySelector('[data-search]');
  const showing = document.querySelector('[data-showing]');
  const dialog = document.querySelector('[data-dialog]');
  let filter = 'all';
  let query = '';

  const loadable = (url) => {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && HOSTS.includes(u.hostname);
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
  const matchesFilter = (row, name) => {
    const state = row.dataset.state;
    const kind = row.dataset.kind;
    return (
      name === 'all' ||
      (name === 'needs' && NEEDS.has(state)) ||
      (name === 'recent' && row.dataset.recent === '1') ||
      (name === 'show' && kind === 'show') ||
      (name === 'movie' && kind === 'movie') ||
      (name === 'adopt' && state === 'adopt') ||
      (name === 'no-id' && state === 'no-id')
    );
  };
  const matches = (row) => matchesFilter(row, filter) && (!query || row.dataset.q.includes(query));
  const applyFilter = () => {
    let shown = 0;
    for (const row of rows) {
      const ok = matches(row);
      row.hidden = !ok;
      if (ok) shown += 1;
    }
    if (showing) showing.textContent = 'showing ' + shown + ' of ' + rows.length;
  };
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
  const setThumb = (row, url) => {
    if (!loadable(url)) return;
    const old = row.querySelector('.th, .ph');
    const img = el('img', 'th' + (row.dataset.kind === 'show' ? ' portrait' : ''));
    img.alt = '';
    img.loading = 'lazy';
    img.src = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
    if (old) old.replaceWith(img);
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
  const openDialog = (cand, onUse) => {
    if (!dialog || !dialog.showModal) return;
    const img = dialog.querySelector('[data-dialog-image]');
    const caption = dialog.querySelector('[data-dialog-caption]');
    img.src = loadable(cand.url) ? cand.url : '';
    caption.textContent = cand.width + '×' + cand.height + (cand.votes !== null ? ' · ' + cand.votes + ' votes' : '') + ' · ' + cand.source;
    const use = dialog.querySelector('[data-dialog-use]');
    use.onclick = () => {
      dialog.close();
      onUse();
    };
    dialog.showModal();
  };
  if (dialog) dialog.querySelector('[data-dialog-close]').addEventListener('click', () => dialog.close());

  const renderStrip = (row, listing, panel) => {
    panel.replaceChildren();
    const label = el('div', 'lbl');
    const kind = row.dataset.kind;
    const what = kind === 'movie' ? ' backdrops from TMDb' : ' posters from TVDB';
    label.appendChild(el('span', '', listing.candidates.length + what));
    label.appendChild(el('span', 'dim', kind === 'movie' ? '16:9 only · English first, ranked by votes' : '680×1000 first, then by score'));
    if (listing.error) label.appendChild(el('span', 'err', listing.error));
    panel.appendChild(label);
    const strip = el('div', 'strip');
    const progress = el('div', 'prog');
    listing.candidates.forEach((cand, i) => {
      const item = el('div', 'cand ' + (kind === 'movie' ? 'land' : 'port') + (i === 0 ? ' pick' : ''));
      const button = el('button');
      button.type = 'button';
      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      if (loadable(cand.thumb)) img.src = cand.thumb;
      button.appendChild(img);
      button.appendChild(el('span', 'badge', i === 0 ? 'top' : cand.language === null ? 'textless' : cand.language));
      const cap = el('div', 'cap');
      cap.appendChild(el('span', '', cand.width + '×' + cand.height));
      cap.appendChild(el('span', '', cand.votes !== null ? cand.votes + ' votes' : 'score ' + cand.score));
      item.appendChild(button);
      item.appendChild(cap);
      const use = async () => {
        for (const other of strip.querySelectorAll('.cand')) other.classList.remove('pick');
        item.classList.add('pick');
        progress.textContent = 'uploading…';
        progress.textContent = await pick(row, { kind, id: Number(row.dataset.id), url: cand.url }, progress);
      };
      button.addEventListener('click', () => openDialog(cand, use));
      button.addEventListener('dblclick', use);
      strip.appendChild(item);
    });
    panel.appendChild(strip);
    panel.appendChild(progress);
    if (row.dataset.state === 'adopt') {
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
    const targets = rows.filter((row) => row.dataset.state === 'adopt' && row.dataset.id);
    if (!targets.length) return;
    if (!window.confirm('Copy the image behind ' + targets.length + ' rows into the bucket and rewrite each cell to the static link?')) return;
    adoptAll.disabled = true;
    let done = 0;
    const failures = [];
    for (const row of targets) {
      done += 1;
      adoptProgress.textContent = 'adopting ' + done + ' of ' + targets.length + ' · ' + row.dataset.title;
      const outcome = await pick(row, { kind: row.dataset.kind, id: Number(row.dataset.id), adopt: true });
      if (!outcome.startsWith('uploaded')) failures.push(row.dataset.title + ': ' + outcome);
    }
    adoptProgress.textContent = 'adopted ' + (targets.length - failures.length) + ' of ' + targets.length + (failures.length ? ' · ' + failures.length + ' failed: ' + failures.join('; ') : '');
    adoptAll.disabled = false;
  });
})();
`;
