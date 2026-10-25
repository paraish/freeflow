// The layout editor: pages of plots and text that can be arranged, edited,
// repeated for every sample (batch) and exported as SVG or PNG.
//
// A layout: { id, name, size, width, height, items, batch, columns, sampleKey }
// An item:  { id, kind: 'plot' | 'text', x, y, w, h, ... } in page units
// (CSS pixels, 96 per inch). Plot items name their population by path and
// their sample by key (null = the page's sample), so a layout works on any
// sample that has the same gates, and in batch mode on every sample.

import { PAGE_SIZES, fillTokens, pageSVG, plotInner, plotSVG, textSVG } from './figure.js';
import { bivariatePixels } from './plot.js';

const GRID = 4;
const snap = (v) => Math.round(v / GRID) * GRID;
const escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let idN = 0;
const newId = (p) => `${p}${Date.now().toString(36)}${(idN++).toString(36)}`;

export function newLayout(name = 'Layout 1') {
  const size = PAGE_SIZES[0];
  return { id: newId('L'), name, size: size.id, width: size.w, height: size.h, items: [], batch: false, columns: 2, sampleKey: null };
}

/**
 * env: {
 *   samples(), activeSample(), sampleKey(s), findByPath(root, path), pathOf(pop),
 *   viewOf(pop), channels(s), channelLabel(s, name), stats(s, pop),
 *   plotData(s, pop, view) -> { xs, ys, idx, xTicks, yTicks, gates, histogram },
 *   cacheKey(s, pop, view), layouts(), changed(), toast(msg, isError)
 * }
 */
export function createLayoutEditor(root, env) {
  const ui = { layoutId: null, sel: null, zoom: 1, previewUrl: null, previewTimer: null };
  const imageCache = new Map();
  const $ = (id) => root.querySelector(`#${id}`);

  const layouts = () => env.layouts();
  const current = () => layouts().find((l) => l.id === ui.layoutId) || layouts()[0] || null;
  const itemById = (id) => current()?.items.find((i) => i.id === id) || null;

  // ---------------------------------------------------------------- resolving items to drawable data

  function sampleFor(item, pageSample) {
    if (item.sampleKey) return env.samples().find((s) => env.sampleKey(s) === item.sampleKey) || null;
    return pageSample;
  }

  function pageSampleOf(layout) {
    return (layout.sampleKey && env.samples().find((s) => env.sampleKey(s) === layout.sampleKey)) || env.activeSample() || env.samples()[0] || null;
  }

  function tokensFor(s, pop, view) {
    if (!s) return { keywords: {} };
    const st = pop ? env.stats(s, pop) : null;
    return {
      sample: s.name, file: s.fileName, n: s.n, keywords: s.keywords,
      population: pop ? pop.name : '', parent: pop?.parent ? pop.parent.name : '',
      path: pop ? ['All Events', ...env.pathOf(pop)].join(' / ') : '',
      count: st ? st.count.toLocaleString('en-US') : '', freq: st ? st.freq : '', freqTotal: st ? st.freqTotal : '',
      x: view ? env.channelLabel(s, view.x) : '', y: view && view.type !== 'histogram' ? env.channelLabel(s, view.y) : '',
    };
  }

  function densityHref(s, pop, view, data, pw, ph) {
    const scale = 2;
    const bw = Math.max(8, Math.min(1200, Math.round(pw * scale)));
    const bh = Math.max(8, Math.min(1200, Math.round(ph * scale)));
    const key = `${env.cacheKey(s, pop, view)}|${bw}x${bh}`;
    let href = imageCache.get(key);
    if (!href) {
      const px = bivariatePixels({ xs: data.xs, ys: data.ys, idx: data.idx, type: view.type, dotRGB: [0, 0, 0] }, bw, bh);
      const c = document.createElement('canvas');
      c.width = bw; c.height = bh;
      c.getContext('2d').putImageData(new ImageData(px, bw, bh), 0, 0);
      href = c.toDataURL('image/png');
      if (imageCache.size > 120) imageCache.clear();
      imageCache.set(key, href);
    }
    return href;
  }

  function itemSVG(item, pageSample, dx = 0, dy = 0) {
    const box = { x: item.x + dx, y: item.y + dy, w: item.w, h: item.h };
    if (item.kind === 'text') {
      const s = pageSample;
      return textSVG({ ...box, text: fillTokens(item.text, tokensFor(s, null, null)), fontSize: item.fontSize, bold: item.bold, align: item.align });
    }
    const s = sampleFor(item, pageSample);
    const base = { ...box, fontSize: item.fontSize, xTicks: [], yTicks: [], gates: [] };
    if (!s) return plotSVG({ ...base, title: item.title ? 'No sample' : '', message: 'No sample open' });
    const pop = env.findByPath(s.root, item.path || []);
    if (!pop) return plotSVG({ ...base, title: fillTokens(item.title, tokensFor(s, null, null)), message: `${s.name} has no "${(item.path || []).join(' / ')}"` });
    const have = new Set(env.channels(s).map((c) => c.name));
    const view = { ...(item.view || env.viewOf(pop)) };
    if (!have.has(view.x) || (view.type !== 'histogram' && !have.has(view.y))) {
      return plotSVG({ ...base, title: fillTokens(item.title, tokensFor(s, pop, null)), message: `${s.name} has no ${!have.has(view.x) ? view.x : view.y}` });
    }
    const data = env.plotData(s, pop, view);
    const tk = tokensFor(s, pop, view);
    const title = fillTokens(item.title ?? '', tk);
    const hist = view.type === 'histogram';
    const { pw, ph } = plotInner(item.w, item.h, item.fontSize, !!title);
    return plotSVG({
      ...base,
      title,
      xLabel: item.xLabel ? fillTokens(item.xLabel, tk) : env.channelLabel(s, view.x),
      yLabel: hist ? (item.yLabel ? fillTokens(item.yLabel, tk) : '% of max') : (item.yLabel ? fillTokens(item.yLabel, tk) : env.channelLabel(s, view.y)),
      xTicks: data.xTicks, yTicks: data.yTicks, gates: data.gates,
      showGates: item.showGates !== false, showLabels: item.showLabels !== false,
      histogram: hist ? data.histogram : null,
      image: hist ? null : { href: densityHref(s, pop, view, data, pw, ph) },
    });
  }

  // The full sheet: one page, or in batch mode one copy per sample in a grid.
  function sheet(layout) {
    if (!layout) return { width: 800, height: 600, svg: pageSVG({ width: 800, height: 600, parts: [] }), blocks: [] };
    const samples = layout.batch ? env.samples() : [pageSampleOf(layout)];
    const cols = layout.batch ? Math.max(1, Math.min(layout.columns || 1, samples.length || 1)) : 1;
    const rows = Math.max(1, Math.ceil(samples.length / cols));
    const width = layout.width * cols;
    const height = layout.height * rows;
    const parts = [];
    const blocks = [];
    samples.forEach((s, i) => {
      const dx = (i % cols) * layout.width;
      const dy = Math.floor(i / cols) * layout.height;
      blocks.push({ dx, dy, sample: s });
      if (layout.batch && i > 0) parts.push(`<line x1="${dx}" y1="${dy}" x2="${dx + layout.width}" y2="${dy}" stroke="#dddddd" stroke-width="0.5"/>`);
      for (const item of layout.items) parts.push(itemSVG(item, s, dx, dy));
    });
    return { width, height, svg: pageSVG({ width, height, parts }), blocks };
  }

  // ---------------------------------------------------------------- export

  async function svgToPngBlob(svg, width, height, scale = 2) {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.decoding = 'sync';
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('The figure could not be drawn as an image.')); img.src = url; });
      const c = document.createElement('canvas');
      c.width = Math.round(width * scale);
      c.height = Math.round(height * scale);
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      return await new Promise((res) => c.toBlob(res, 'image/png'));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function save(filename, data, mime) {
    const claude = globalThis.claude;
    const downloads = claude?.use ? await claude.use('downloads').catch(() => null) : null;
    if (downloads) {
      try {
        await downloads.save({ filename, data });
        env.toast(`Saved ${filename}.`);
      } catch (e) {
        if (e?.code !== 'declined') env.toast(`${filename} could not be saved: ${e?.message || e}`, true);
      }
      return;
    }
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    env.toast(`Saved ${filename}.`);
  }

  const fileBase = (l) => (l?.name || 'Layout').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Layout';

  function singleItemSheet(item) {
    const l = current();
    const s = pageSampleOf(l);
    const width = item.w, height = item.h;
    return { width, height, svg: pageSVG({ width, height, parts: [itemSVG(item, s, -item.x, -item.y)] }) };
  }

  async function copyImage(sh) {
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('unsupported');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': svgToPngBlob(sh.svg, sh.width, sh.height) })]);
      env.toast('Copied as an image. Paste it into PowerPoint, Word, Slack or an email.');
    } catch {
      env.toast('Copying images is blocked here. Right-click the preview under Export and choose Copy image.', true);
    }
  }

  function schedulePreview() {
    clearTimeout(ui.previewTimer);
    ui.previewTimer = setTimeout(async () => {
      const img = $('lay-preview');
      if (!img || root.hidden) return;
      const sh = sheet(current());
      try {
        const blob = await svgToPngBlob(sh.svg, sh.width, sh.height, 1.5);
        if (ui.previewUrl) URL.revokeObjectURL(ui.previewUrl);
        ui.previewUrl = URL.createObjectURL(blob);
        img.src = ui.previewUrl;
      } catch { /* keep the old preview */ }
    }, 700);
  }

  // ---------------------------------------------------------------- rendering

  function renderList() {
    const l = current();
    $('lay-list').innerHTML = layouts().map((x) => `<li><button class="lay-pick${x === l ? ' is-sel' : ''}" data-act="pick-layout" data-id="${x.id}">${escH(x.name)}<span class="sample-meta">${x.items.length} item${x.items.length === 1 ? '' : 's'}${x.batch ? ' · batch' : ''}</span></button></li>`).join('')
      || '<li class="empty">No layouts yet.</li>';
    $('lay-items').innerHTML = l ? l.items.map((it) => `<li><button class="lay-pick${it.id === ui.sel ? ' is-sel' : ''}" data-act="pick-item" data-id="${it.id}">${it.kind === 'text' ? 'Text' : 'Plot'}: ${escH(it.kind === 'text' ? (it.text || '').split('\n')[0].slice(0, 40) : (it.path || []).slice(-1)[0] || 'All Events')}</button></li>`).join('')
      || '<li class="empty">Add a plot from the gating view (Add to layout) or with the buttons below.</li>' : '';
  }

  function renderStage() {
    const l = current();
    const stage = $('lay-stage');
    if (!l) { stage.innerHTML = '<p class="empty">Create a layout to start.</p>'; return; }
    const sh = sheet(l);
    const avail = Math.max(300, stage.clientWidth - 24);
    ui.zoom = Math.min(1, avail / sh.width);
    const z = ui.zoom;
    const overlays = l.items.map((it) => `<div class="lay-box${it.id === ui.sel ? ' is-sel' : ''}" data-id="${it.id}" style="left:${it.x * z}px;top:${it.y * z}px;width:${it.w * z}px;height:${it.h * z}px">${it.id === ui.sel ? '<span class="lay-resize" data-act="resize" aria-hidden="true"></span>' : ''}</div>`).join('');
    stage.innerHTML = `<div class="lay-sheet" style="width:${sh.width * z}px;height:${sh.height * z}px">
      <div class="lay-svg">${sh.svg}</div>
      ${l.batch ? `<div class="lay-block-hint" style="width:${l.width * z}px;height:${l.height * z}px"></div>` : ''}
      <div class="lay-overlay">${overlays}</div></div>`;
    const svg = stage.querySelector('.lay-svg svg');
    svg.setAttribute('width', sh.width * z);
    svg.setAttribute('height', sh.height * z);
    schedulePreview();
  }

  function pageOptions(l) {
    return PAGE_SIZES.map((p) => `<option value="${p.id}" ${l.size === p.id ? 'selected' : ''}>${p.label}</option>`).join('');
  }

  function renderProps() {
    const l = current();
    const el = $('lay-props');
    if (!l) { el.innerHTML = ''; return; }
    const it = itemById(ui.sel);
    const samples = env.samples();
    const field = (id, label, input) => `<label class="field"><span>${label}</span>${input}</label>`;
    const num = (id, v, attrs = '') => `<input id="${id}" type="number" value="${+(+v).toFixed(1)}" ${attrs}>`;
    const txt = (id, v, ph = '') => `<input id="${id}" type="text" value="${escH(v ?? '')}" placeholder="${escH(ph)}" autocomplete="off">`;
    const check = (id, v, label) => `<label class="check check-small"><input id="${id}" type="checkbox" ${v ? 'checked' : ''}> ${label}</label>`;
    const tokensHelp = '<p class="muted small">Fill-ins: {sample} {population} {parent} {count} {freq} {freqTotal} {x} {y}, or any keyword in braces, such as {$DATE} or {DONOR}.</p>';

    let itemHTML = '<p class="muted small">Click an item on the page to edit it. Drag to move it; drag its corner to resize it.</p>';
    if (it?.kind === 'plot') {
      const s = sampleFor(it, pageSampleOf(l));
      const pops = [];
      if (s) {
        const walkP = (p, path) => { pops.push(path); p.children.forEach((c) => walkP(c, [...path, c.name])); };
        walkP(s.root, []);
      }
      const chans = s ? env.channels(s) : [];
      const view = it.view || { x: chans[0]?.name, y: chans[1]?.name, type: 'pseudo' };
      const chOpts = (sel) => chans.map((c) => `<option value="${escH(c.name)}" ${c.name === sel ? 'selected' : ''}>${escH(c.label)}</option>`).join('');
      itemHTML = `
        <div class="fields">
          ${field('', 'Sample', `<select id="lp-sample"><option value="">${l.batch ? 'Each sample (batch)' : 'Page sample'}</option>${samples.map((x) => `<option value="${escH(env.sampleKey(x))}" ${it.sampleKey === env.sampleKey(x) ? 'selected' : ''}>${escH(x.name)}</option>`).join('')}</select>`)}
          ${field('', 'Population', `<select id="lp-path">${pops.map((p) => `<option value="${escH(JSON.stringify(p))}" ${JSON.stringify(p) === JSON.stringify(it.path) ? 'selected' : ''}>${escH(['All Events', ...p].join(' / '))}</option>`).join('')}</select>`)}
          ${field('', 'Plot type', `<select id="lp-type">${[['pseudo', 'Pseudocolor'], ['dot', 'Dot'], ['histogram', 'Histogram']].map(([v, t]) => `<option value="${v}" ${view.type === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`)}
          ${field('', 'X channel', `<select id="lp-x">${chOpts(view.x)}</select>`)}
          ${view.type === 'histogram' ? '' : field('', 'Y channel', `<select id="lp-y">${chOpts(view.y)}</select>`)}
          ${field('', 'Title', txt('lp-title', it.title, 'No title'))}
          ${field('', 'X axis label', txt('lp-xlabel', it.xLabel, 'Channel name'))}
          ${field('', 'Y axis label', txt('lp-ylabel', it.yLabel, view.type === 'histogram' ? '% of max' : 'Channel name'))}
          ${field('', 'Font size', num('lp-font', it.fontSize, 'min="6" max="40" step="1"'))}
          <div class="field-pair">${field('', 'Width', num('lp-w', it.w, 'min="80" step="4"'))}${field('', 'Height', num('lp-h', it.h, 'min="80" step="4"'))}</div>
          ${check('lp-gates', it.showGates !== false, 'Show gates')}
          ${check('lp-labels', it.showLabels !== false, 'Show gate names and %')}
        </div>
        ${tokensHelp}
        <div class="btn-row"><button class="btn" data-act="copy-item">Copy plot as image</button><button class="btn" data-act="dup-item">Duplicate</button><button class="btn btn-danger" data-act="del-item">Delete</button></div>`;
    } else if (it?.kind === 'text') {
      itemHTML = `
        <div class="fields">
          <label class="field field-stack"><span>Text</span><textarea id="lt-text" rows="3">${escH(it.text)}</textarea></label>
          ${field('', 'Font size', num('lt-font', it.fontSize, 'min="6" max="96" step="1"'))}
          ${field('', 'Align', `<select id="lt-align">${['left', 'center', 'right'].map((a) => `<option ${it.align === a ? 'selected' : ''}>${a}</option>`).join('')}</select>`)}
          ${check('lt-bold', it.bold, 'Bold')}
          <div class="field-pair">${field('', 'Width', num('lt-w', it.w, 'min="20" step="4"'))}${field('', 'Height', num('lt-h', it.h, 'min="12" step="4"'))}</div>
        </div>
        ${tokensHelp}
        <div class="btn-row"><button class="btn" data-act="dup-item">Duplicate</button><button class="btn btn-danger" data-act="del-item">Delete</button></div>`;
    }

    el.innerHTML = `
      <section class="card">
        <header class="card-head"><span class="eyebrow">Page</span></header>
        <div class="fields">
          ${field('', 'Name', txt('lpg-name', l.name))}
          ${field('', 'Size', `<select id="lpg-size">${pageOptions(l)}</select>`)}
          ${l.size === 'custom' ? `<div class="field-pair">${field('', 'Width', num('lpg-w', l.width, 'min="200" step="8"'))}${field('', 'Height', num('lpg-h', l.height, 'min="200" step="8"'))}</div>` : ''}
          ${l.batch ? '' : field('', 'Sample', `<select id="lpg-sample"><option value="">Sample open in gating</option>${samples.map((x) => `<option value="${escH(env.sampleKey(x))}" ${l.sampleKey === env.sampleKey(x) ? 'selected' : ''}>${escH(x.name)}</option>`).join('')}</select>`)}
          ${check('lpg-batch', l.batch, `Batch: repeat for every sample (${samples.length})`)}
          ${l.batch ? field('', 'Copies per row', num('lpg-cols', l.columns, 'min="1" max="12" step="1"')) : ''}
        </div>
      </section>
      <section class="card">
        <header class="card-head"><span class="eyebrow">${it ? (it.kind === 'text' ? 'Text' : 'Plot') : 'Item'}</span></header>
        ${itemHTML}
      </section>
      <section class="card">
        <header class="card-head"><span class="eyebrow">Export</span></header>
        <div class="btn-row">
          <button class="btn btn-primary" data-act="svg">Download SVG</button>
          <button class="btn" data-act="png">Download PNG</button>
          <button class="btn" data-act="copy">Copy as image</button>
        </div>
        <p class="muted small">SVG keeps text, axes and gates editable in Illustrator, Inkscape or PowerPoint. Right-click the preview to copy it.</p>
        <img id="lay-preview" class="lay-preview" alt="Preview of the layout">
      </section>`;
  }

  function render() {
    if (!current() && layouts().length) ui.layoutId = layouts()[0].id;
    if (current() && !ui.layoutId) ui.layoutId = current().id;
    renderList();
    renderStage();
    const active = document.activeElement;
    const keepFocus = active && $('lay-props').contains(active) && active.id ? { id: active.id, start: active.selectionStart } : null;
    renderProps();
    if (keepFocus) {
      const elx = root.querySelector(`#${keepFocus.id}`);
      if (elx) { elx.focus(); try { if (keepFocus.start != null) elx.setSelectionRange(keepFocus.start, keepFocus.start); } catch { /* not a text field */ } }
    }
  }

  let renderTimer = null;
  function renderSoon() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => { renderList(); renderStage(); }, 120);
  }

  function changed({ props = false } = {}) {
    env.changed();
    if (props) renderProps();
    renderSoon();
  }

  // ---------------------------------------------------------------- editing

  function ensureLayout() {
    let l = current();
    if (!l) {
      l = newLayout(`Layout ${layouts().length + 1}`);
      layouts().push(l);
      ui.layoutId = l.id;
    }
    return l;
  }

  // Next free spot: left to right, then down, on the page grid.
  function placeFor(l, w, h) {
    const margin = 24;
    for (let y = margin; y + h <= l.height - margin + 1; y += 8) {
      for (let x = margin; x + w <= l.width - margin + 1; x += 8) {
        const clash = l.items.some((it) => x < it.x + it.w + 8 && x + w + 8 > it.x && y < it.y + it.h + 8 && y + h + 8 > it.y);
        if (!clash) return { x, y };
      }
    }
    return { x: margin, y: margin };
  }

  function addPlot(s, pop, view) {
    const l = ensureLayout();
    const w = 300, h = 300;
    const at = placeFor(l, w, h);
    const item = {
      id: newId('i'), kind: 'plot', ...at, w, h, sampleKey: null, path: s ? env.pathOf(pop) : [],
      view: view ? { ...view } : null, title: '{population}', xLabel: '', yLabel: '', fontSize: 11, showGates: true, showLabels: true,
    };
    l.items.push(item);
    ui.sel = item.id;
    env.changed();
    return { layout: l, item };
  }

  function addText() {
    const l = ensureLayout();
    const at = placeFor(l, 320, 40);
    const item = { id: newId('i'), kind: 'text', ...at, w: 320, h: 40, text: '{sample}', fontSize: 18, bold: true, align: 'left' };
    l.items.push(item);
    ui.sel = item.id;
    env.changed();
    render();
  }

  function onPropInput(e) {
    const l = current();
    if (!l) return;
    const t = e.target;
    const it = itemById(ui.sel);
    const val = t.type === 'checkbox' ? t.checked : t.value;
    const n = parseFloat(val);
    switch (t.id) {
      case 'lpg-name': l.name = val || 'Layout'; return changed();
      case 'lpg-size': {
        l.size = val;
        const p = PAGE_SIZES.find((x) => x.id === val);
        if (p?.w) { l.width = p.w; l.height = p.h; }
        return changed({ props: true });
      }
      case 'lpg-w': if (n >= 200) { l.width = n; changed(); } return;
      case 'lpg-h': if (n >= 200) { l.height = n; changed(); } return;
      case 'lpg-sample': l.sampleKey = val || null; return changed({ props: true });
      case 'lpg-batch': l.batch = val; return changed({ props: true });
      case 'lpg-cols': if (n >= 1) { l.columns = Math.round(n); changed(); } return;
      default: break;
    }
    if (!it) return;
    if (it.kind === 'plot') {
      const s = sampleFor(it, pageSampleOf(l));
      it.view = it.view || (s ? { ...env.viewOf(env.findByPath(s.root, it.path || []) || s.root) } : { x: '', y: '', type: 'pseudo' });
      switch (t.id) {
        case 'lp-sample': it.sampleKey = val || null; return changed({ props: true });
        case 'lp-path': it.path = JSON.parse(val); return changed();
        case 'lp-type': it.view.type = val; return changed({ props: true });
        case 'lp-x': it.view.x = val; return changed();
        case 'lp-y': it.view.y = val; return changed();
        case 'lp-title': it.title = val; return changed();
        case 'lp-xlabel': it.xLabel = val; return changed();
        case 'lp-ylabel': it.yLabel = val; return changed();
        case 'lp-font': if (n >= 6) { it.fontSize = n; changed(); } return;
        case 'lp-w': if (n >= 80) { it.w = n; changed(); } return;
        case 'lp-h': if (n >= 80) { it.h = n; changed(); } return;
        case 'lp-gates': it.showGates = val; return changed();
        case 'lp-labels': it.showLabels = val; return changed();
        default: return;
      }
    }
    switch (t.id) {
      case 'lt-text': it.text = val; return changed();
      case 'lt-font': if (n >= 6) { it.fontSize = n; changed(); } return;
      case 'lt-align': it.align = val; return changed();
      case 'lt-bold': it.bold = val; return changed();
      case 'lt-w': if (n >= 20) { it.w = n; changed(); } return;
      case 'lt-h': if (n >= 12) { it.h = n; changed(); } return;
      default: break;
    }
  }

  async function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const l = current();
    const act = b.dataset.act;
    if (act === 'new-layout') {
      const nl = newLayout(`Layout ${layouts().length + 1}`);
      layouts().push(nl);
      ui.layoutId = nl.id;
      ui.sel = null;
      env.changed();
      return render();
    }
    if (act === 'pick-layout') { ui.layoutId = b.dataset.id; ui.sel = null; return render(); }
    if (act === 'pick-item') { ui.sel = b.dataset.id; return render(); }
    if (act === 'add-text') return addText();
    if (act === 'add-plot') {
      const s = env.activeSample();
      if (!s) { env.toast('Open a sample first.'); return; }
      addPlot(s, s.root, env.viewOf(s.root));
      return render();
    }
    if (act === 'del-layout' && l) {
      if (b.dataset.confirm !== '1') {
        b.dataset.confirm = '1';
        b.textContent = 'Delete this layout?';
        setTimeout(() => { if (b.isConnected) { b.dataset.confirm = ''; b.textContent = 'Delete layout'; } }, 3000);
        return;
      }
      layouts().splice(layouts().indexOf(l), 1);
      ui.layoutId = layouts()[0]?.id ?? null;
      ui.sel = null;
      env.changed();
      return render();
    }
    if (!l) return;
    const it = itemById(ui.sel);
    if (act === 'del-item' && it) { l.items.splice(l.items.indexOf(it), 1); ui.sel = null; env.changed(); return render(); }
    if (act === 'dup-item' && it) {
      const copy = { ...JSON.parse(JSON.stringify(it)), id: newId('i'), ...placeFor(l, it.w, it.h) };
      l.items.push(copy);
      ui.sel = copy.id;
      env.changed();
      return render();
    }
    if (act === 'copy-item' && it) return copyImage(singleItemSheet(it));
    const sh = () => sheet(l);
    if (act === 'svg') return save(`${fileBase(l)}.svg`, sh().svg, 'image/svg+xml');
    if (act === 'png') {
      const x = sh();
      try { return save(`${fileBase(l)}.png`, await svgToPngBlob(x.svg, x.width, x.height, 2), 'image/png'); } catch (err) { return env.toast(err.message, true); }
    }
    if (act === 'copy') return copyImage(sh());
  }

  // Dragging and resizing items on the page.
  let drag = null;
  function onPointerDown(e) {
    const box = e.target.closest('.lay-box');
    const stage = $('lay-stage');
    if (!box) {
      if (e.target.closest('.lay-sheet') && ui.sel) { ui.sel = null; render(); }
      return;
    }
    const it = itemById(box.dataset.id);
    if (!it) return;
    e.preventDefault();
    if (ui.sel !== it.id) { ui.sel = it.id; render(); }
    const resize = !!e.target.closest('[data-act="resize"]');
    drag = { it, resize, sx: e.clientX, sy: e.clientY, ox: it.x, oy: it.y, ow: it.w, oh: it.h, moved: false };
    stage.setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e) {
    if (!drag) return;
    const l = current();
    const dx = (e.clientX - drag.sx) / ui.zoom, dy = (e.clientY - drag.sy) / ui.zoom;
    if (!drag.moved && Math.hypot(dx, dy) < 2) return;
    drag.moved = true;
    const { it } = drag;
    if (drag.resize) {
      it.w = Math.max(it.kind === 'text' ? 20 : 120, snap(drag.ow + dx));
      it.h = Math.max(it.kind === 'text' ? 12 : 120, snap(drag.oh + dy));
    } else {
      it.x = Math.max(0, Math.min(l.width - 20, snap(drag.ox + dx)));
      it.y = Math.max(0, Math.min(l.height - 12, snap(drag.oy + dy)));
    }
    const z = ui.zoom;
    const box = root.querySelector(`.lay-box[data-id="${it.id}"]`);
    if (box) Object.assign(box.style, { left: `${it.x * z}px`, top: `${it.y * z}px`, width: `${it.w * z}px`, height: `${it.h * z}px` });
    renderSoon();
  }
  function onPointerUp() {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) { env.changed(); render(); }
  }

  function onKey(e) {
    if (root.hidden || e.target.matches('input, textarea, select')) return;
    const it = itemById(ui.sel);
    if (!it) return;
    const l = current();
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      l.items.splice(l.items.indexOf(it), 1);
      ui.sel = null;
      env.changed();
      render();
      return;
    }
    const step = e.shiftKey ? 16 : GRID;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      it.x = Math.max(0, it.x + moves[e.key][0]);
      it.y = Math.max(0, it.y + moves[e.key][1]);
      env.changed();
      render();
    }
    if (e.key === 'Escape') { ui.sel = null; render(); }
  }

  root.addEventListener('click', onClick);
  root.addEventListener('input', (e) => { if (e.target.closest('#lay-props')) onPropInput(e); });
  root.addEventListener('change', (e) => { if (e.target.closest('#lay-props') && (e.target.tagName === 'SELECT' || e.target.type === 'checkbox')) { /* handled on input */ } });
  root.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  document.addEventListener('keydown', onKey);
  new ResizeObserver(() => { if (!root.hidden) renderStage(); }).observe(root);

  return {
    render,
    addPlot: (s, pop, view) => { const r = addPlot(s, pop, view); return r; },
    select: (layoutId, itemId) => { ui.layoutId = layoutId; ui.sel = itemId; },
    currentName: () => current()?.name || '',
    invalidate: () => imageCache.clear(),
  };
}
