// The layout editor: pages of plots and text that can be arranged, edited,
// repeated for every sample (batch) and exported as SVG or PNG.
//
// A layout: { id, name, size, width, height, items, batch, columns, rows, order, sampleKey,
//            arrange, gridCols, gridRows, showStrategy, strategySize, strategyFont, ... }
// `arrange` is 'free' (items go where they are put) or 'grid' (plots snap to
// a grid of gridCols x gridRows cells, in order; see tiling.js).
// In batch, `columns` and `rows` set the grid (0 or missing: as many as
// needed) and `order` fills it across rows first ('row') or down columns ('col').
// `showStrategy` lists the gates down to the page's one plot above the figure.
// An item:  { id, kind: 'plot' | 'text', x, y, w, h, ... } in page units
// (CSS pixels, 96 per inch). Plot items name their population by path and
// their sample by key (null = the page's sample), so a layout works on any
// sample that has the same gates, and in batch mode on every sample.

import { PAGE_SIZES, axisSpots, fillTokens, pageSVG, plotInner, plotSizes, plotSVG, textSVG } from './figure.js';
import { bivariatePixels } from './plot.js';
import { applyGrid, cellAt, defaultGrid, gridCells, movePlot, titleTop } from './tiling.js';

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
 *   cacheKey(s, pop, view), layouts(), changed(), toast(msg, isError),
 *   editPlot(item, sample)   open a plot's gates for editing below the page
 *   editing()                true while a plot is open for editing
 *   itemRemoved(item)        an item was deleted
 *   checkpoint(key)          about to change a layout: keep an undo step (steps
 *                            with the same key close together are one step)
 *   labelOf(sample)          the name given to a sample in the Samples pane
 *   folderSamples(), folderName()   the folder picked in the Folders pane
 *   setOrder(key, n), setLabel(key, name)   change a sample's place or name
 *   plotDefaults(), setPlotDefaults(d)       text sizes and gate labels new plots start with
 *   renameGate(key, path, rect)              open the name box for a gate
 *   shortLabel(s, name)                      a channel's stain, or its name
 *   look()                                   { dotSize, depth } used in Gating
 * }
 */
export function createLayoutEditor(root, env) {
  // origin: page-to-sheet offset of the first copy; blocks: the copies on the
  // sheet; editMark: the plot open for editing ({ id, block }).
  // sel: the item whose settings are shown; multi: every selected item (Shift-
  // or Ctrl/⌘-click selects several).
  // copySel: plots selected in particular copies of a batch, as "<copy>:<item id>"
  // (copy 0 is the one being edited); exportScope: 'all', 'sel' or null (automatic).
  const ui = { layoutId: null, sel: null, multi: new Set(), copySel: new Set(), exportScope: null, zoom: 1, previewUrl: null, previewTimer: null, origin: null, blocks: null, editMark: null };
  // shut: the cards on the right folded away ('export', 'page', 'batch',
  // 'item', 'text'), remembered in this browser.
  ui.shut = new Set();
  try { ui.shut = new Set(JSON.parse(localStorage.getItem('freeflow.layoutCardsShut') || '[]')); } catch { /* none folded */ }
  const imageCache = new Map();
  const $ = (id) => root.querySelector(`#${id}`);

  const layouts = () => env.layouts();
  const current = () => layouts().find((l) => l.id === ui.layoutId) || layouts()[0] || null;
  const itemById = (id) => current()?.items.find((i) => i.id === id) || null;
  const selection = () => (ui.multi.size ? [...ui.multi] : ui.sel ? [ui.sel] : []).map(itemById).filter(Boolean);
  // Selects one item (or none).
  const pick = (id) => {
    ui.sel = id;
    ui.multi = new Set(id ? [id] : []);
    ui.copySel = new Set(id ? [`0:${id}`] : []);
    if (!id) ui.exportScope = null;
  };
  // Adds an item to the selection, or takes it out.
  const toggle = (id) => {
    const set = new Set(selection().map((i) => i.id));
    if (set.has(id)) set.delete(id); else set.add(id);
    ui.multi = set;
    ui.sel = set.has(id) ? id : [...set][0] ?? null;
    const key = `0:${id}`;
    if (set.has(id)) ui.copySel.add(key); else ui.copySel.delete(key);
  };
  // Selects a plot in one copy of a batch (with `add`, adding it or taking it out).
  const pickCopy = (block, id, add = false) => {
    const key = `${block}:${id}`;
    if (!add) ui.copySel = new Set([key]);
    else if (ui.copySel.has(key)) ui.copySel.delete(key); else ui.copySel.add(key);
    ui.multi = new Set([...ui.copySel].map((k) => k.split(':')[1]));
    ui.sel = ui.copySel.has(key) ? id : [...ui.multi][0] ?? null;
  };
  // The plots selected for export: in batch, the ones picked in each copy.
  const exportTargets = () => {
    const l = current();
    if (!l) return [];
    if (!l.batch) return selection().map((it) => ({ b: 0, it }));
    return [...ui.copySel].map((k) => { const [b, id] = k.split(':'); return { b: +b, it: itemById(id) }; }).filter((x) => x.it);
  };
  // Export the selection once two or more plots are picked, unless chosen otherwise.
  const exportScope = () => {
    const n = exportTargets().length;
    if (!n) return 'all';
    return ui.exportScope || (n >= 2 ? 'sel' : 'all');
  };
  const isGrid = (l) => l?.arrange === 'grid';
  // In grid mode, puts the plots back in their cells after any change.
  const tidy = (l) => {
    if (!isGrid(l)) return;
    if (!Number.isFinite(l.gridTop)) l.gridTop = titleTop(l);
    applyGrid(l);
  };

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
      sample: s.name, label: env.labelOf(s) || s.name, file: s.fileName, n: s.n, keywords: s.keywords,
      population: pop ? pop.name : '', parent: pop?.parent ? pop.parent.name : '',
      path: pop ? ['All Events', ...env.pathOf(pop)].join(' / ') : '',
      count: st ? st.count.toLocaleString('en-US') : '', freq: st ? st.freq : '', freqTotal: st ? st.freqTotal : '',
      x: view ? env.channelLabel(s, view.x) : '', y: view && view.type !== 'histogram' ? env.channelLabel(s, view.y) : '',
    };
  }

  function densityHref(s, pop, view, data, pw, ph, dot = 1, depth = 0) {
    const scale = 2;
    const bw = Math.max(8, Math.min(1200, Math.round(pw * scale)));
    const bh = Math.max(8, Math.min(1200, Math.round(ph * scale)));
    const key = `${env.cacheKey(s, pop, view)}|${bw}x${bh}|${dot}|${depth}`;
    let href = imageCache.get(key);
    if (!href) {
      const px = bivariatePixels({ xs: data.xs, ys: data.ys, idx: data.idx, type: view.type, dotRGB: [0, 0, 0], dotSize: dot * scale, depth }, bw, bh);
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
      return textSVG({ ...box, text: fillTokens(item.text, tokensFor(s, null, null)), fontSize: item.fontSize, bold: item.bold, italic: item.italic, color: item.color, font: item.font, align: item.align });
    }
    const s = sampleFor(item, pageSample);
    const base = { ...box, fontSize: item.fontSize, sizes: item.sizes, xTicks: [], yTicks: [], gates: [] };
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
    const { pw, ph } = plotInner(item.w, item.h, item.fontSize, !!title, item.sizes);
    return plotSVG({
      ...base,
      title,
      xLabel: item.xLabel ? fillTokens(item.xLabel, tk) : env.channelLabel(s, view.x),
      yLabel: hist ? (item.yLabel ? fillTokens(item.yLabel, tk) : '% of max') : (item.yLabel ? fillTokens(item.yLabel, tk) : env.channelLabel(s, view.y)),
      xTicks: data.xTicks, yTicks: data.yTicks, gates: data.gates,
      showGates: item.showGates !== false, showLabels: item.showLabels !== false, stats: statsOf(item), pctSign: item.pctSign !== false,
      histogram: hist ? data.histogram : null,
      image: hist ? null : { href: densityHref(s, pop, view, data, pw, ph, item.dotSize || 1, item.depth || 0) },
    });
  }

  // Which numbers a plot shows under its gate names. Older plots without the
  // setting show % of parent, or nothing if their labels were turned off.
  function statsOf(it) {
    return it.stats || (it.showLabels === false ? {} : { parent: true });
  }

  // Outlines for plots selected in batch copies other than the first (whose
  // own boxes show their selection).
  function copyMarks() {
    const z = ui.zoom;
    return [...ui.copySel].map((k) => {
      const [b, id] = k.split(':');
      const it = itemById(id), bl = ui.blocks?.[+b];
      if (+b === 0 || !it || !bl) return '';
      return `<div class="lay-copy-sel" style="left:${(it.x + bl.dx) * z}px;top:${(it.y + bl.dy) * z}px;width:${it.w * z}px;height:${it.h * z}px"></div>`;
    }).join('');
  }

  // A plot item's axes: its own, or else those its population was last shown on.
  function itemView(it, s) {
    if (it.view) return it.view;
    const pop = s && env.findByPath(s.root, it.path || []);
    return pop ? env.viewOf(pop) : { x: '', y: '', type: 'pseudo' };
  }

  // The full sheet: one page, or in batch mode one copy per sample in a grid.
  // The part of the page one batch copy takes: the items' bounding box with
  // a margin, or the whole page outside batch mode or with no items.
  function batchCell(layout) {
    if (!layout.batch || !layout.items.length) return { x0: 0, y0: 0, w: layout.width, h: layout.height };
    const pad = 16;
    const x0 = Math.max(0, Math.min(...layout.items.map((it) => it.x)) - pad);
    const y0 = Math.max(0, Math.min(...layout.items.map((it) => it.y)) - pad);
    const x1 = Math.max(...layout.items.map((it) => it.x + it.w)) + pad;
    const y1 = Math.max(...layout.items.map((it) => it.y + it.h)) + pad;
    return { x0, y0, w: x1 - x0, h: y1 - y0 };
  }

  // Columns and rows of a batch grid for n copies. A size left empty grows to
  // fit; when both are set and too small, the grid grows in the fill direction.
  function batchGrid(layout, n) {
    if (!layout.batch) return { cols: 1, rows: 1, byCol: false };
    n = Math.max(1, n);
    const byCol = layout.order === 'col';
    let cols = Math.max(0, Math.round(layout.columns || 0));
    let rows = Math.max(0, Math.round(layout.rows || 0));
    if (!cols && !rows) cols = 2;
    if (cols && !rows) rows = Math.ceil(n / cols);
    else if (rows && !cols) cols = Math.ceil(n / rows);
    else if (cols * rows < n) { if (byCol) cols = Math.ceil(n / rows); else rows = Math.ceil(n / cols); }
    // No empty columns (or rows) beyond the last copy.
    if (byCol) cols = Math.min(cols, Math.ceil(n / rows)); else rows = Math.min(rows, Math.ceil(n / cols));
    if (!byCol) cols = Math.min(cols, n); else rows = Math.min(rows, n);
    return { cols, rows, byCol };
  }

  function gridNote(l) {
    const n = env.batchSamples(l).length;
    const g = batchGrid(l, n);
    return `${n} cop${n === 1 ? 'y' : 'ies'} in ${g.cols} column${g.cols === 1 ? '' : 's'} × ${g.rows} row${g.rows === 1 ? '' : 's'}. Leave columns or rows empty to fit every sample. Double-click a plot in any copy to edit its gates for that sample.`;
  }

  // The sample ID shown above each copy of a batch: the file name or the
  // sample's name, with its text settings; null when it is off.
  function batchId(layout) {
    if (!layout.batch || (layout.idShow !== 'file' && layout.idShow !== 'name')) return null;
    const size = layout.idSize || 14;
    return {
      h: Math.round(size * 1.5),
      style: { fontSize: size, align: layout.idAlign || 'left', bold: layout.idBold !== false, italic: !!layout.idItalic, color: layout.idColor, font: layout.idFont },
      text: (s) => (layout.idShow === 'name' ? (env.labelOf(s) || s.name) : s.name),
    };
  }

  // The gating strategy of a page with exactly one plot: each gate from All
  // Events down to the plotted population, with the channels it was drawn on,
  // e.g. ["Cells (FSC-A / SSC-A)", "Singlets (FSC-H / FSC-A)"]. Null with no
  // plot or several (they may follow different gates).
  function strategySteps(layout) {
    const plots = layout.items.filter((x) => x.kind === 'plot');
    if (plots.length !== 1) return null;
    const it = plots[0];
    const s = sampleFor(it, layout.batch ? env.batchSamples(layout)[0] || null : pageSampleOf(layout));
    if (!s) return null;
    const steps = [];
    let p = s.root;
    for (const name of it.path || []) {
      p = p.children.find((c) => c.name === name);
      if (!p) break;
      const chans = p.gate ? (p.gate.type === 'range' ? [p.gate.x] : [p.gate.x, p.gate.y]) : [];
      steps.push(chans.length ? `${p.name} (${chans.map((n) => env.shortLabel(s, n)).join(' / ')})` : p.name);
    }
    return steps;
  }

  // The gating strategy as a band of text `w` wide, wrapped at the arrows;
  // null when it is off or there is nothing to show.
  function strategyBand(layout, w) {
    if (!layout.showStrategy) return null;
    const steps = strategySteps(layout);
    if (!steps?.length) return null;
    const fs = layout.strategySize || 12;
    // Roughly how many characters fit on a line (wider for bold and monospace).
    const ch = fs * ((layout.strategyFont === 'mono' ? 0.6 : 0.55) + (layout.strategyBold ? 0.05 : 0));
    const fit = Math.max(12, Math.floor((w - 32) / ch));
    const lines = [''];
    steps.forEach((st, i) => {
      const last = lines.length - 1;
      const piece = i ? ` → ${st}` : st;
      if (i && (lines[last] + piece).length > fit) lines.push(`→ ${st}`);
      else lines[last] += piece;
    });
    const h = Math.round(fs * (0.9 + 1.25 * lines.length));
    return { h, svg: (x, y) => textSVG({ x: x + 16, y: y + Math.round(fs * 0.3), w: w - 32, h, text: lines.join('\n'), fontSize: fs,
      align: layout.strategyAlign || 'left', bold: !!layout.strategyBold, italic: !!layout.strategyItalic, color: layout.strategyColor, font: layout.strategyFont }) };
  }

  // Only the selected plots (each from its own copy in a batch, with its
  // sample ID above it), cropped to fit, under the gating strategy if shown.
  function selectionSheet(layout, targets) {
    const sh = sheet(layout);
    const id = batchId(layout);
    const parts = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const { b, it } of targets) {
      const bl = sh.blocks[b];
      if (!bl) continue;
      const X = it.x + bl.dx, Y = it.y + bl.dy;
      let top = Y;
      if (id && bl.sample && it.kind === 'plot') {
        top = Y - id.h;
        parts.push(textSVG({ ...id.style, x: X, y: top, w: it.w, h: id.h, text: id.text(bl.sample) }));
      }
      parts.push(itemSVG(it, bl.sample, bl.dx, bl.dy));
      x0 = Math.min(x0, X); y0 = Math.min(y0, top); x1 = Math.max(x1, X + it.w); y1 = Math.max(y1, Y + it.h);
    }
    if (!parts.length) return sh;
    const m = 12;
    const band = strategyBand(layout, x1 - x0 + 2 * m);
    if (band) { y0 -= band.h; parts.push(band.svg(x0 - m, y0)); }
    const width = x1 - x0 + 2 * m, height = y1 - y0 + 2 * m;
    return { width, height, svg: pageSVG({ width, height, parts: [`<g transform="translate(${m - x0} ${m - y0})">${parts.join('')}</g>`] }) };
  }

  // What the export buttons and the preview use.
  function exportSheet(layout) {
    const targets = exportTargets();
    return exportScope() === 'sel' && targets.length ? selectionSheet(layout, targets) : sheet(layout);
  }

  function sheet(layout) {
    if (!layout) return { width: 800, height: 600, svg: pageSVG({ width: 800, height: 600, parts: [] }), blocks: [], origin: { dx: 0, dy: 0 }, cell: { x0: 0, y0: 0, w: 800, h: 600 }, top: 0 };
    // Batch copies skip compensation controls.
    const samples = layout.batch ? env.batchSamples(layout) : [pageSampleOf(layout)];
    const { cols, rows, byCol } = batchGrid(layout, samples.length);
    // In batch, each copy is only as big as the items on the page (plus a
    // margin), not the whole page.
    let cell = batchCell(layout);
    const id = batchId(layout);
    const idH = id ? id.h : 0;
    if (idH) cell = { ...cell, y0: cell.y0 - idH, h: cell.h + idH };
    const width = cell.w * cols;
    // The gating strategy, once, above everything.
    const band = strategyBand(layout, width);
    const top = band ? band.h : 0;
    const height = top + cell.h * rows;
    const parts = band ? [band.svg(0, 0)] : [];
    const blocks = [];
    samples.forEach((s, i) => {
      const c = byCol ? Math.floor(i / rows) : i % cols;
      const r = byCol ? i % rows : Math.floor(i / cols);
      const cx = c * cell.w, cy = top + r * cell.h;
      const dx = cx - cell.x0, dy = cy - cell.y0;
      blocks.push({ dx, dy, sample: s });
      if (layout.batch && r > 0) parts.push(`<line x1="${cx}" y1="${cy}" x2="${cx + cell.w}" y2="${cy}" stroke="#dddddd" stroke-width="0.5"/>`);
      if (id && s) parts.push(textSVG({ ...id.style, x: cx + 16, y: cy + 4, w: cell.w - 32, h: idH, text: id.text(s) }));
      for (const item of layout.items) parts.push(itemSVG(item, s, dx, dy));
    });
    return { width, height, svg: pageSVG({ width, height, parts }), blocks, origin: { dx: -cell.x0, dy: top - cell.y0 }, cell, top };
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
      if (!img || root.hidden || !img.closest('details')?.open) return;
      const sh = exportSheet(current());
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
    const selIds = new Set(selection().map((i) => i.id));
    $('lay-items').innerHTML = l ? l.items.map((it) => `<li><button class="lay-pick${selIds.has(it.id) ? ' is-sel' : ''}" data-act="pick-item" data-id="${it.id}">${it.kind === 'text' ? 'Text' : 'Plot'}: ${escH(it.kind === 'text' ? (it.text || '').split('\n')[0].slice(0, 40) : (it.path || []).slice(-1)[0] || 'All Events')}</button></li>`).join('')
      || '<li class="empty">Click or drag a population from Samples to add its plot.</li>' : '';
  }

  function renderStage() {
    const l = current();
    const stage = $('lay-stage');
    if (!l) { stage.innerHTML = '<p class="empty">Create a layout to start.</p>'; return; }
    const sh = sheet(l);
    const avail = Math.max(300, stage.clientWidth - 24);
    ui.zoom = Math.min(1, avail / sh.width);
    const z = ui.zoom;
    ui.origin = sh.origin;
    ui.blocks = sh.blocks;
    const o = sh.origin;
    // Outline the plot open for editing below, in whichever copy it is.
    const em = env.editing() && ui.editMark && l.items.find((x) => x.id === ui.editMark.id);
    const eb = em && sh.blocks[ui.editMark.block];
    const editMark = eb ? `<div class="lay-edit-mark" style="left:${(em.x + eb.dx) * z}px;top:${(em.y + eb.dy) * z}px;width:${em.w * z}px;height:${em.h * z}px"></div>` : '';
    const selIds = new Set(selection().map((i) => i.id));
    // A resize handle on a single selected item, unless the grid sets its size.
    const handle = (it) => selIds.size === 1 && selIds.has(it.id) && !(isGrid(l) && it.kind === 'plot');
    const overlays = l.items.map((it) => `<div class="lay-box${selIds.has(it.id) ? ' is-sel' : ''}" data-id="${it.id}" style="left:${(it.x + o.dx) * z}px;top:${(it.y + o.dy) * z}px;width:${it.w * z}px;height:${it.h * z}px">${handle(it) ? '<span class="lay-resize" data-act="resize" aria-hidden="true"></span>' : ''}</div>`).join('');
    // A channel menu over each plot's axis titles, in every copy of a batch:
    // click a title to change it (for every copy). Each menu holds only its
    // channel until it is opened (see fillAxisMenu), so big batches stay light.
    const axisHot = (ui.blocks || []).map((bl, b) => l.items.filter((it) => it.kind === 'plot').map((it) => {
      const s = sampleFor(it, bl.sample);
      if (!s) return '';
      const view = itemView(it, s);
      const spots = axisSpots({ x: it.x + bl.dx, y: it.y + bl.dy, w: it.w, h: it.h, fontSize: it.fontSize || 11, sizes: it.sizes, hasTitle: !!String(it.title ?? '').trim() });
      const spot = (axis, r) => `<label class="lay-axis-hot" title="Click to change the ${axis.toUpperCase()} channel${l.batch ? ' (in every copy)' : ''}" style="left:${r.x * z}px;top:${r.y * z}px;width:${r.w * z}px;height:${r.h * z}px"><select data-item="${it.id}" data-block="${b}" data-axis="${axis}" aria-label="${axis.toUpperCase()} channel"><option value="${escH(view[axis])}" selected>${escH(env.channelLabel(s, view[axis]))}</option></select></label>`;
      return spot('x', spots.x) + (view.type === 'histogram' ? '' : spot('y', spots.y));
    }).join('')).join('');
    // The grid's cells, faintly, while editing (not part of the figure).
    const cells = isGrid(l) ? gridCells(l).cells.map((c) => `<div class="lay-cell" style="left:${(c.x + o.dx) * z}px;top:${(c.y + o.dy) * z}px;width:${c.w * z}px;height:${c.h * z}px"></div>`).join('') : '';
    stage.innerHTML = `<div class="lay-sheet" style="width:${sh.width * z}px;height:${sh.height * z}px">
      <div class="lay-svg">${sh.svg}</div>
      ${l.batch ? `<div class="lay-block-hint" style="top:${sh.top * z}px;width:${sh.cell.w * z}px;height:${sh.cell.h * z}px"></div>` : ''}
      <div class="lay-overlay">${cells}${editMark}${copyMarks()}${overlays}${axisHot}</div></div>`;
    const svg = stage.querySelector('.lay-svg svg');
    svg.setAttribute('width', sh.width * z);
    svg.setAttribute('height', sh.height * z);
    schedulePreview();
  }

  // Fills an axis title's channel menu as it opens.
  function fillAxisMenu(sel) {
    if (sel.dataset.filled) return;
    const it = itemById(sel.dataset.item);
    const s = it && sampleFor(it, ui.blocks?.[+sel.dataset.block]?.sample || null);
    if (!s) return;
    const view = itemView(it, s);
    const cur = view[sel.dataset.axis];
    sel.innerHTML = env.menuChannels(s, [view.x, view.y]).map((c) => `<option value="${escH(c.name)}" ${c.name === cur ? 'selected' : ''}>${escH(c.label)}${c.uncomp ? ' (uncomp.)' : ''}</option>`).join('');
    sel.dataset.filled = '1';
  }

  const sliderText = (id, v) => (id.endsWith('depth') ? (+v).toFixed(1) : String(v));

  function pageOptions(l) {
    return PAGE_SIZES.map((p) => `<option value="${p.id}" ${l.size === p.id ? 'selected' : ''}>${p.label}</option>`).join('');
  }

  // The text settings of a plot: title, axis titles, sizes, and the numbers
  // shown with each gate.
  // `P` prefixes the ids: 'lp' for the selected plot, 'lb' for the batch card
  // (which sets every plot and leaves out the axis titles and the buttons).
  function plotTextHTML(it, view, s, P = 'lp') {
    const all = P === 'lb';
    const field = (id, label, input) => `<label class="field"><span>${label}</span>${input}</label>`;
    const num = (id, v, attrs = '') => `<input id="${id}" type="number" value="${+(+v).toFixed(1)}" ${attrs}>`;
    const txt = (id, v, ph = '') => `<input id="${id}" type="text" value="${escH(v ?? '')}" placeholder="${escH(ph)}" autocomplete="off">`;
    const check = (id, v, label) => `<label class="check check-small"><input id="${id}" type="checkbox" ${v ? 'checked' : ''}> ${label}</label>`;
    const z = plotSizes(it.fontSize || 11, it.sizes || {});
    const st = statsOf(it);
    const title = it.title ?? '';
    // The title is typed, or picked from a list (▾) of common titles and the
    // sample's own keywords, each shown with what it gives for this plot.
    const pop = s && env.findByPath(s.root, it.path || []);
    const tk = tokensFor(s, pop, view);
    const shown = (v) => { const t = fillTokens(v, tk); return t.length > 40 ? `${t.slice(0, 39)}…` : t; };
    const presets = [['{population}', 'Population'], ['{label}', 'Sample name'], ['{sample}', 'File name'],
      ['{label}: {population}', 'Sample name: population'], ['{sample}: {population}', 'File name: population'],
      ['{population}: {freq} of {parent}', 'Population: % of parent'], ['{population} ({count} events)', 'Population and count']];
    const kw = s?.keywords || {};
    const keys = Object.keys(kw).filter((k) => !k.startsWith('$') && !/^(P\d|SPILL|COMP)/i.test(k)).slice(0, 40);
    for (const k of ['$DATE', '$BTIM', '$CYT', '$SRC', '$OP', '$INST']) if (kw[k] !== undefined) keys.push(k);
    const opt = (v, name) => `<option value="${escH(v)}">${escH(name)}${v ? ` → ${escH(shown(v) || '(empty)')}` : ''}</option>`;
    const picker = `<select id="${P}-title-pick" class="combo-pick" aria-label="Choose a title" title="Choose a title">
        <option value="" selected disabled hidden>Choose</option>
        <optgroup label="Titles">${presets.map(([v, t]) => opt(v, t)).join('')}<option value="__none">None</option></optgroup>
        ${keys.length ? `<optgroup label="Keywords of this sample">${keys.map((k) => opt(`{${k}}`, k)).join('')}</optgroup>` : ''}
      </select>`;
    return `
        <div class="fields">
          ${field('', 'Title', `<span class="combo">${txt(`${P}-title`, title, 'No title')}${picker}</span>`)}
          ${all ? '' : `${field('', 'X axis title', txt(`${P}-xlabel`, it.xLabel, 'Channel name'))}
          ${field('', 'Y axis title', txt(`${P}-ylabel`, it.yLabel, view.type === 'histogram' ? '% of max' : 'Channel name'))}`}
          <p class="field-head">Sizes</p>
          <div class="field-pair">${field('', 'Title', num(`${P}-font`, z.title, 'min="4" max="48" step="0.5"'))}${field('', 'Axis titles', num(`${P}-axfs`, z.axis, 'min="4" max="48" step="0.5"'))}</div>
          <div class="field-pair">${field('', 'Axis numbers', num(`${P}-tickfs`, z.ticks, 'min="4" max="48" step="0.5"'))}${field('', 'Gate names', num(`${P}-gnfs`, z.gateName, 'min="4" max="48" step="0.5"'))}</div>
          <div class="field-pair">${field('', 'Gate numbers', num(`${P}-gvfs`, z.gateNum, 'min="4" max="48" step="0.5"'))}<span></span></div>
          <p class="field-head">With each gate</p>
          <div class="field-pair">${check(`${P}-labels`, it.showLabels !== false, 'Name')}${check(`${P}-st-count`, st.count, 'Count')}</div>
          <div class="field-pair">${check(`${P}-st-parent`, st.parent, '% of parent')}${check(`${P}-st-grand`, st.grand, '% of grandparent')}</div>
          ${check(`${P}-pct`, it.pctSign !== false, 'Show the % sign')}
          <div class="btn-row"><button class="btn btn-small" data-act="text-keep" data-src="${P}" title="Use these sizes and gate labels for every plot in every layout, and for new plots, for the rest of this session">Set for all plots &amp; keep for this session</button></div>
          <p class="muted small">Puts these sizes and gate labels on every plot in every layout; new plots start with them too. Titles stay as they are.</p>
        </div>
        <p class="muted small">Fill-ins for titles: {sample} {label} {population} {parent} {count} {freq} {freqTotal} {x} {y}, or any keyword in braces such as {$DATE}.</p>
`;
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
    // Each card folds away from its heading (see ui.shut).
    const fold = (key) => (ui.shut.has(key) ? '' : 'open');
    // A slider with its value beside it; the plots change when it is let go.
    const slider = (id, v, min, max, step, title = '') => `<span class="lay-slider"${title ? ` title="${title}"` : ''}><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${v}"><output for="${id}">${sliderText(id, v)}</output></span>`;
    const fontSelect = (id, v) => `<select id="${id}">${[['sans', 'Sans-serif (Arial)'], ['serif', 'Serif (Times)'], ['mono', 'Monospace (Courier)']].map(([k, t]) => `<option value="${k}" ${(v || 'sans') === k ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
    const tokensHelp = '<p class="muted small">Fill-ins: {sample} {label} {population} {parent} {count} {freq} {freqTotal} {x} {y}, or any keyword in braces, such as {$DATE} or {DONOR}. {label} is the name given to the sample in the Samples pane (or its file name).</p>';

    let itemHTML = '<p class="muted small">Click an item on the page to edit it. Drag to move it; drag its corner to resize it. Shift- or Ctrl/⌘-click to select several.</p>';
    const many = selection().length;
    if (many > 1) {
      itemHTML = `<p class="muted small">${many} items selected. Drag any of them to move them together, nudge them with the arrow keys, or press Delete to remove them.${isGrid(l) ? ' In grid mode plots keep to their cells; text moves freely.' : ''}</p>
        <div class="btn-row"><button class="btn btn-danger" data-act="del-item">Delete ${many} items</button></div>`;
    } else if (it?.kind === 'plot') {
      const s = sampleFor(it, pageSampleOf(l));
      const pops = [];
      if (s) {
        const walkP = (p, path) => { pops.push(path); p.children.forEach((c) => walkP(c, [...path, c.name])); };
        walkP(s.root, []);
      }
      const chans = s ? env.channels(s) : [];
      const view = it.view || { x: chans[0]?.name, y: chans[1]?.name, type: 'pseudo' };
      const menu = s ? env.menuChannels(s, [view.x, view.y]) : [];
      const chOpts = (sel) => menu.map((c) => `<option value="${escH(c.name)}" ${c.name === sel ? 'selected' : ''}>${escH(c.label)}${c.uncomp ? ' (uncomp.)' : ''}</option>`).join('');
      itemHTML = `
        <div class="fields">
          ${field('', 'Sample', `<select id="lp-sample"><option value="">${l.batch ? 'Each sample (batch)' : 'Page sample'}</option>${samples.map((x) => `<option value="${escH(env.sampleKey(x))}" ${it.sampleKey === env.sampleKey(x) ? 'selected' : ''}>${escH(x.name)}</option>`).join('')}</select>`)}
          ${field('', 'Population', `<select id="lp-path">${pops.map((p) => `<option value="${escH(JSON.stringify(p))}" ${JSON.stringify(p) === JSON.stringify(it.path) ? 'selected' : ''}>${escH(['All Events', ...p].join(' / '))}</option>`).join('')}</select>`)}
          ${field('', 'Plot type', `<select id="lp-type">${[['pseudo', 'Pseudocolor'], ['dot', 'Dot'], ['histogram', 'Histogram']].map(([v, t]) => `<option value="${v}" ${view.type === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`)}
          ${field('', 'X channel', `<select id="lp-x">${chOpts(view.x)}</select>`)}
          ${view.type === 'histogram' ? '' : field('', 'Y channel', `<select id="lp-y">${chOpts(view.y)}</select>`)}
          ${view.type === 'histogram' ? '' : field('', 'Dot size', slider('lp-dot', it.dotSize || 1, 1, 6, 1))}
          ${view.type === 'pseudo' ? field('', 'Colour depth', slider('lp-depth', it.depth || 0, 0, 1, 0.1, '0 as designed; up to 1 for deeper colours, for plots that look pale')) : ''}
          ${view.type !== 'histogram' && !l.batch && l.items.filter((x) => x.kind === 'plot').length > 1 ? '<div class="btn-row"><button class="btn btn-small" data-act="look-all" title="Give every plot on this page this dot size and colour depth">Same dot size &amp; colour depth for every plot</button></div>' : ''}
          ${isGrid(l) ? '<p class="muted small">Size and place are set by the grid (Page → Arrange).</p>' : `<div class="field-pair">${field('', 'Width', num('lp-w', it.w, 'min="80" step="4"'))}${field('', 'Height', num('lp-h', it.h, 'min="80" step="4"'))}</div>`}
          ${check('lp-gates', it.showGates !== false, 'Show gates')}
        </div>
        <div class="btn-row"><button class="btn" data-act="copy-item">Copy plot as image</button><button class="btn" data-act="dup-item">Duplicate</button><button class="btn btn-danger" data-act="del-item">Delete</button></div>
      </details>
      <details class="card" data-card="text" ${fold('text')}>
        <summary class="card-head"><span class="eyebrow">Plot text</span></summary>
        ${plotTextHTML(it, view, s)}`;
    } else if (it?.kind === 'text') {
      itemHTML = `
        <div class="fields">
          <label class="field field-stack"><span>Text</span><textarea id="lt-text" rows="3">${escH(it.text)}</textarea></label>
          ${field('', 'Font size', num('lt-font', it.fontSize, 'min="6" max="96" step="1"'))}
          ${field('', 'Align', `<select id="lt-align">${['left', 'center', 'right'].map((a) => `<option ${it.align === a ? 'selected' : ''}>${a}</option>`).join('')}</select>`)}
          <div class="field-pair">${check('lt-bold', it.bold, 'Bold')}${check('lt-italic', it.italic, 'Italic')}</div>
          ${field('', 'Font', fontSelect('lt-family', it.font))}
          ${field('', 'Colour', `<input id="lt-color" type="color" value="${escH(/^#[0-9a-f]{6}$/i.test(it.color || '') ? it.color : '#000000')}">`)}
          <div class="field-pair">${field('', 'Width', num('lt-w', it.w, 'min="20" step="4"'))}${field('', 'Height', num('lt-h', it.h, 'min="12" step="4"'))}</div>
        </div>
        ${tokensHelp}
        <div class="btn-row"><button class="btn" data-act="dup-item">Duplicate</button><button class="btn btn-danger" data-act="del-item">Delete</button></div>`;
    }

    // Export first, so it is always at hand.
    el.innerHTML = `
      <details class="card" data-card="export" ${fold('export')}>
        <summary class="card-head"><span class="eyebrow">Export</span></summary>
        ${(() => {
          const n = exportTargets().length;
          const scope = exportScope();
          return `<div class="fields"><label class="field"><span>What</span><select id="lay-export-scope">
            <option value="all" ${scope === 'all' ? 'selected' : ''}>${l.batch ? 'Entire batch' : 'Entire page'}</option>
            <option value="sel" ${scope === 'sel' ? 'selected' : ''} ${n ? '' : 'disabled'}>Selected ${l.batch ? 'plot' : 'item'}${n === 1 ? '' : 's'}${n ? ` (${n})` : ''}</option>
          </select></label></div>`;
        })()}
        <div class="btn-row">
          <button class="btn btn-primary" data-act="svg">Download SVG</button>
          <button class="btn" data-act="png">Download PNG</button>
          <button class="btn" data-act="copy">Copy as image</button>
        </div>
        <p class="muted small">SVG keeps text, axes and gates editable in Illustrator, Inkscape or PowerPoint. Right-click the preview to copy it.</p>
        <img id="lay-preview" class="lay-preview" alt="Preview of the layout">
      </details>
      <details class="card" data-card="page" ${fold('page')}>
        <summary class="card-head"><span class="eyebrow">Page</span></summary>
        <div class="fields">
          ${field('', 'Name', txt('lpg-name', l.name))}
          ${field('', 'Size', `<select id="lpg-size">${pageOptions(l)}</select>`)}
          ${l.size === 'custom' ? `<div class="field-pair">${field('', 'Width', num('lpg-w', l.width, 'min="200" step="8"'))}${field('', 'Height', num('lpg-h', l.height, 'min="200" step="8"'))}</div>` : ''}
          ${field('', 'Arrange', `<select id="lpg-arrange"><option value="free" ${isGrid(l) ? '' : 'selected'}>Free</option><option value="grid" ${isGrid(l) ? 'selected' : ''}>Snap to grid</option></select>`)}
          ${isGrid(l) ? `<div class="field-pair">${field('', 'Columns', num('lpg-gcols', l.gridCols || 1, 'min="1" max="12" step="1"'))}${field('', 'Rows', num('lpg-grows', l.gridRows || 1, 'min="1" max="12" step="1"'))}</div>
          ${field('', 'Grid starts at', num('lpg-gtop', Number.isFinite(l.gridTop) ? l.gridTop : titleTop(l), 'min="0" step="8"'))}
          <p class="muted small">Plots fill the cells in order. Drop a new plot on a cell, or drag a plot to another cell, and the others move along; arrow keys move the selected plot one cell. Rows are added when the plots don't fit. Text floats over the page and never moves the grid; "Grid starts at" leaves room for a title.</p>` : ''}
          ${l.batch ? '' : field('', 'Sample', `<select id="lpg-sample"><option value="">Sample open in gating</option>${samples.map((x) => `<option value="${escH(env.sampleKey(x))}" ${l.sampleKey === env.sampleKey(x) ? 'selected' : ''}>${escH(x.name)}</option>`).join('')}</select>`)}
          ${(() => {
            // Only for a page with one plot: several plots may follow different gates.
            const plots = l.items.filter((x) => x.kind === 'plot').length;
            const ok = plots === 1;
            const steps = ok ? strategySteps(l) : null;
            const off = ok ? '' : 'disabled';
            return `<div class="field-pair"><label class="check check-small${ok ? '' : ' is-off'}" title="${ok ? 'A line above the figure with each gate down to the plotted population, and the channels it was drawn on' : 'Needs exactly one plot on the page'}"><input id="lpg-strategy" type="checkbox" ${ok && l.showStrategy ? 'checked' : ''} ${off}> Show gating strategy</label>${field('', 'Size', num('lpg-stratsize', l.strategySize || 12, `min="6" max="48" step="0.5" title="Text size of the gating strategy" ${off}`))}</div>
          ${!ok ? `<p class="muted small">Needs exactly one plot on the page (there ${plots === 0 ? 'are none' : `are ${plots}`})${l.batch ? '' : '; batch it to repeat it for every sample'}.</p>`
            : l.showStrategy ? `
          <div class="field-pair">${field('', 'Font', fontSelect('lpg-stratfont', l.strategyFont))}${field('', 'Align', `<select id="lpg-stratalign">${[['left', 'Left'], ['center', 'Centred'], ['right', 'Right']].map(([v, t]) => `<option value="${v}" ${(l.strategyAlign || 'left') === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`)}</div>
          <div class="field-pair">${check('lpg-stratbold', l.strategyBold, 'Bold')}${check('lpg-stratitalic', l.strategyItalic, 'Italic')}</div>
          ${field('', 'Colour', `<input id="lpg-stratcolor" type="color" value="${escH(/^#[0-9a-f]{6}$/i.test(l.strategyColor || '') ? l.strategyColor : '#000000')}">`)}
          <p class="muted small">${steps?.length ? 'Each gate from All Events down to the plotted population, with the channels it was drawn on. Shown once, above the figure.' : 'The plot shows All Events, so there are no gates to list.'}</p>` : ''}`;
          })()}
          ${check('lpg-batch', l.batch, `Batch: repeat for every sample (${env.batchSamples(l).length})`)}
          ${l.batch ? field('', 'Repeat for', `<select id="lpg-group"><option value="">All samples (not controls)</option>${env.folders().map((g) => `<option value="${escH(g.id)}" ${l.batchGroup === g.id ? 'selected' : ''}>${escH(g.name)}</option>`).join('')}</select>`) : ''}
          ${l.batch ? `<div class="field-pair">${field('', 'Columns', `<input id="lpg-cols" type="number" min="0" max="24" step="1" value="${l.columns || ''}" placeholder="Auto">`)}${field('', 'Rows', `<input id="lpg-rows" type="number" min="0" max="24" step="1" value="${l.rows || ''}" placeholder="Auto">`)}</div>
          ${field('', 'Fill order', `<select id="lpg-order"><option value="row" ${l.order !== 'col' ? 'selected' : ''}>Across, then down</option><option value="col" ${l.order === 'col' ? 'selected' : ''}>Down, then across</option></select>`)}
          <p id="lpg-grid" class="muted small">${gridNote(l)}</p>
          ${field('', 'Sample ID', `<select id="lpg-id">${[['none', 'None'], ['file', 'File name'], ['name', 'Name (or file name)']].map(([v, t]) => `<option value="${v}" ${(l.idShow || 'none') === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`)}
          ${l.idShow === 'file' || l.idShow === 'name' ? `
          ${field('', 'Align', `<select id="lpg-idalign">${[['left', 'Left'], ['center', 'Centred'], ['right', 'Right']].map(([v, t]) => `<option value="${v}" ${(l.idAlign || 'left') === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`)}
          <div class="field-pair">${field('', 'Size', num('lpg-idsize', l.idSize || 14, 'min="6" max="72" step="1"'))}${field('', 'Font', fontSelect('lpg-idfont', l.idFont))}</div>
          <div class="field-pair">${check('lpg-idbold', l.idBold !== false, 'Bold')}${check('lpg-iditalic', l.idItalic, 'Italic')}</div>
          ${field('', 'Colour', `<input id="lpg-idcolor" type="color" value="${escH(/^#[0-9a-f]{6}$/i.test(l.idColor || '') ? l.idColor : '#000000')}">`)}
          <p class="muted small">Shown above each copy. "Name" is the name given to the sample in the Samples pane.</p>` : ''}` : ''}
        </div>
      </details>
      ${l.batch && l.items.some((x) => x.kind === 'plot') ? (() => {
        const ref = l.items.find((x) => x.kind === 'plot');
        const ps = sampleFor(ref, pageSampleOf(l));
        return `<details class="card" data-card="batch" ${fold('batch')}>
        <summary class="card-head"><span class="eyebrow">All plots in the batch</span></summary>
        <p class="muted small">Changes here apply to every plot, in every copy. Shown: the first plot's settings.</p>
        <div class="fields">
          ${field('', 'Dot size', slider('lb-dot', ref.dotSize || 1, 1, 6, 1))}
          ${field('', 'Colour depth', slider('lb-depth', ref.depth || 0, 0, 1, 0.1, '0 as designed; up to 1 for deeper colours, for plots that look pale (pseudocolor plots)'))}
        </div>
        ${plotTextHTML(ref, itemView(ref, ps), ps, 'lb')}
      </details>`;
      })() : ''}
      <details class="card" data-card="item" ${fold('item')}>
        <summary class="card-head"><span class="eyebrow">${many > 1 ? 'Items' : it ? (it.kind === 'text' ? 'Text' : 'Plot') : 'Item'}</span></summary>
        ${itemHTML}
      </details>`;
  }

  // ---------------------------------------------------------------- samples sidebar

  // Samples start collapsed except the one open in Gating.
  ui.seen = new Set();
  ui.closed = new Set(); // "s:<key>" for samples, "p:<key>:<path>" for populations

  // The samples of the folder picked in the Folders pane, in that folder's
  // order, with the names given to them.
  function renderSamplesSide() {
    const el = $('lay-samples');
    const samples = env.folderSamples();
    $('lay-samples-title').textContent = env.folderName() === 'All samples' ? 'Samples' : env.folderName();
    if (!env.samples().length) { el.innerHTML = '<li class="empty">Open samples to add their plots here.</li>'; return; }
    if (!samples.length) { el.innerHTML = '<li class="empty">No samples in this folder.</li>'; return; }
    const active = env.activeSample();
    for (const s of samples) {
      const key = env.sampleKey(s);
      if (!ui.seen.has(key)) { ui.seen.add(key); if (s !== active) ui.closed.add(`s:${key}`); }
    }
    const top = el.scrollTop;
    el.innerHTML = samples.map((s, i) => {
      const key = env.sampleKey(s);
      const label = env.labelOf(s);
      const shut = ui.closed.has(`s:${key}`);
      const rows = [];
      const visit = (p, depth) => {
        const path = env.pathOf(p);
        const pkey = `p:${key}:${JSON.stringify(path)}`;
        const pshut = ui.closed.has(pkey);
        const st = env.stats(s, p);
        const twisty = p.children.length
          ? `<button class="twisty" data-act="ls-pop-twisty" data-key="${escH(pkey)}" aria-expanded="${!pshut}" aria-label="${pshut ? 'Expand' : 'Collapse'} ${escH(p.name)}">${pshut ? '▸' : '▾'}</button>`
          : '<span class="twisty-space"></span>';
        rows.push(`<li class="pop-row lay-pop" style="--depth:${depth}" draggable="true" data-sample="${escH(key)}" data-path="${escH(JSON.stringify(path))}">${twisty}
          <button class="pop-pick" data-act="ls-add" title="Add ${escH(p.name)} to the page">
            <span class="pop-name">${escH(p.name)}</span><span class="pop-stats"><span class="pop-pct">${p.parent ? escH(st.freq) : ''}</span></span>
          </button>${p.gate ? `<span class="row-tools"><button class="row-edit" data-act="ls-rename" aria-label="Rename ${escH(p.name)}" title="Rename">✎</button></span>` : ''}</li>`);
        if (!pshut) p.children.forEach((c) => visit(c, depth + 1));
      };
      if (!shut) visit(s.root, 0);
      return `<li class="ws-sample${s === active ? ' is-active' : ''}">
        <div class="sample-row" data-sample="${escH(key)}">
          <button class="twisty" data-act="ls-sample-twisty" aria-expanded="${!shut}" aria-label="${shut ? 'Show' : 'Hide'} populations of ${escH(s.name)}">${shut ? '▸' : '▾'}</button>
          <input class="order-box" type="text" inputmode="numeric" value="${i + 1}" data-sample="${escH(key)}" aria-label="Position of ${escH(s.name)} in ${escH(env.folderName())}" title="Position in this folder only. Type a number to move it.">
          <button class="sample-pick" data-act="ls-sample-twisty"><span class="sample-name">${escH(s.name)}</span>
            <span class="sample-meta">${s.n.toLocaleString('en-US')} events${s.isControl ? ' · control' : ''}</span></button>
        </div>
        <div class="label-row"><input class="label-box" type="text" value="${escH(label)}" data-sample="${escH(key)}" placeholder="Name for figures ({label})" aria-label="Name for ${escH(s.name)}" autocomplete="off"></div>
        ${shut ? '' : `<ul class="tree">${rows.join('')}</ul>`}
      </li>`;
    }).join('');
    el.scrollTop = top;
  }

  function addFromSidebar(key, path, at = null) {
    const s = env.samples().find((x) => env.sampleKey(x) === key);
    const pop = s && env.findByPath(s.root, path);
    if (!pop) return;
    const l = ensureLayout();
    // A plot from the page's own sample follows the page (and every sample in
    // batch mode); one from another sample stays on that sample.
    const pinned = !l.batch && s !== pageSampleOf(l) ? key : null;
    addPlot(s, pop, env.viewOf(pop), { at, sampleKey: pinned });
    render();
    env.toast(`Added ${pop.name}${pinned ? ` (${s.name})` : ''} to ${l.name}.`);
  }

  function render() {
    if (!current() && layouts().length) ui.layoutId = layouts()[0].id;
    if (current() && !ui.layoutId) ui.layoutId = current().id;
    renderSamplesSide();
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

  // `at` places the plot's centre at a page position; `sampleKey` pins it to
  // one sample (null follows the page's sample, or each sample in batch).
  function addPlot(s, pop, view, { at = null, sampleKey = null } = {}) {
    env.checkpoint();
    const l = ensureLayout();
    const w = 300, h = 300;
    const pos = at
      ? { x: snap(Math.max(0, Math.min(l.width - w, at.x - w / 2))), y: snap(Math.max(0, Math.min(l.height - h, at.y - h / 2))) }
      : placeFor(l, w, h);
    const item = {
      id: newId('i'), kind: 'plot', ...pos, w, h, sampleKey, path: s ? env.pathOf(pop) : [],
      view: view ? { ...view } : null, title: '{population}', xLabel: '', yLabel: '', fontSize: 11, showGates: true, showLabels: true,
    };
    // The dot size and colour depth used in Gating, then the text settings
    // kept with "Set for all plots".
    const look = env.look();
    if (look.dotSize > 1) item.dotSize = look.dotSize;
    if (look.depth > 0) item.depth = look.depth;
    const d = env.plotDefaults();
    if (d) applyDefaults(item, d);
    l.items.push(item);
    // In grid mode the new plot goes into the cell it was dropped on (or
    // after the others), and the rest move along.
    if (isGrid(l)) {
      if (at) movePlot(l, item, cellAt(l, at.x, at.y));
      applyGrid(l);
    }
    pick(item.id);
    env.changed();
    return { layout: l, item };
  }

  // Text settings kept for the session ({ fontSize, sizes, stats, pctSign,
  // showLabels }; sessions saved before gate labels were kept have sizes only).
  function applyDefaults(x, d) {
    x.fontSize = d.fontSize || 11;
    if (d.sizes) x.sizes = { ...d.sizes }; else delete x.sizes;
    if (d.stats) x.stats = { ...d.stats };
    if (d.pctSign !== undefined) x.pctSign = d.pctSign;
    if (d.showLabels !== undefined) x.showLabels = d.showLabels;
  }

  // A text item; `label` makes a name label ({label}: each sample's name from
  // the Samples pane, filled in for every copy in batch). In grid mode text
  // floats over the page, in the middle, without moving the grid.
  function addText({ label = false } = {}) {
    const l = ensureLayout();
    env.checkpoint();
    const w = label ? 200 : 320, h = label ? 28 : 40;
    const at = isGrid(l) ? { x: snap((l.width - w) / 2), y: snap((l.height - h) / 2) } : placeFor(l, w, h);
    const item = label
      ? { id: newId('i'), kind: 'text', ...at, w, h, text: '{label}', fontSize: 16, bold: true, align: 'left', color: '#000000' }
      : { id: newId('i'), kind: 'text', ...at, w, h, text: '{sample}', fontSize: 18, bold: true, align: 'left' };
    l.items.push(item);
    pick(item.id);
    env.changed();
    render();
  }

  // One text setting of a plot (from the plot's card or the batch card).
  function setPlotText(x, key, val, n) {
    const sizeKey = { axfs: 'axis', tickfs: 'ticks', gnfs: 'gateName', gvfs: 'gateNum' }[key];
    if (key === 'title-pick') x.title = val === '__none' ? '' : val;
    else if (key === 'title') x.title = val;
    else if (key === 'xlabel') x.xLabel = val;
    else if (key === 'ylabel') x.yLabel = val;
    else if (key === 'font') { if (n >= 4) x.fontSize = n; }
    else if (sizeKey) { if (n >= 4) x.sizes = { ...(x.sizes || {}), [sizeKey]: n }; }
    else if (key === 'labels') x.showLabels = val;
    else if (key.startsWith('st-')) x.stats = { ...statsOf(x), [key.slice(3)]: val };
    else if (key === 'pct') x.pctSign = val;
  }

  function onPropInput(e) {
    const l = current();
    if (!l) return;
    const t = e.target;
    if (t.id === 'lay-export-scope') { ui.exportScope = t.value; schedulePreview(); return; }
    // Sliders show their value as they move and change the plots when let go.
    if (t.type === 'range') {
      t.nextElementSibling.textContent = sliderText(t.id, t.value);
      if (e.type === 'input') return;
    }
    // One undo step per field being edited, not per keystroke.
    env.checkpoint(`${t.id}:${ui.sel}`);
    const it = itemById(ui.sel);
    const val = t.type === 'checkbox' ? t.checked : t.value;
    const n = parseFloat(val);
    const tm = t.id.match(/^(lp|lb)-(title-pick|title|xlabel|ylabel|font|axfs|tickfs|gnfs|gvfs|labels|st-count|st-parent|st-grand|pct)$/);
    if (tm) {
      const targets = tm[1] === 'lb' ? l.items.filter((x) => x.kind === 'plot') : it?.kind === 'plot' ? [it] : [];
      const key = tm[2];
      if (key === 'title-pick' && !val) return;
      for (const x of targets) setPlotText(x, key, val, n);
      return changed({ props: key === 'title-pick' });
    }
    switch (t.id) {
      case 'lpg-name': l.name = val || 'Layout'; return changed();
      case 'lpg-arrange': {
        l.arrange = val === 'grid' ? 'grid' : 'free';
        if (isGrid(l) && !Number.isFinite(l.gridTop)) l.gridTop = titleTop(l);
        if (isGrid(l) && !l.gridCols) ({ cols: l.gridCols, rows: l.gridRows } = defaultGrid(l));
        tidy(l);
        return changed({ props: true });
      }
      case 'lpg-gcols': if (n >= 1) { l.gridCols = Math.round(n); tidy(l); changed(); } return;
      case 'lpg-grows': if (n >= 1) { l.gridRows = Math.round(n); tidy(l); changed(); } return;
      case 'lpg-gtop': if (n >= 0 && n < l.height - 60) { l.gridTop = Math.round(n); tidy(l); changed(); } return;
      case 'lpg-size': {
        l.size = val;
        const p = PAGE_SIZES.find((x) => x.id === val);
        if (p?.w) { l.width = p.w; l.height = p.h; }
        tidy(l);
        return changed({ props: true });
      }
      case 'lpg-w': if (n >= 200) { l.width = n; tidy(l); changed(); } return;
      case 'lpg-h': if (n >= 200) { l.height = n; tidy(l); changed(); } return;
      case 'lpg-sample': l.sampleKey = val || null; return changed({ props: true });
      case 'lpg-batch': l.batch = val; return changed({ props: true });
      case 'lpg-strategy': l.showStrategy = val; return changed({ props: true });
      case 'lb-dot': case 'lb-depth':
        for (const x of l.items) {
          if (x.kind !== 'plot') continue;
          if (t.id === 'lb-dot') x.dotSize = Math.round(n); else x.depth = n;
        }
        return changed();
      case 'lpg-stratsize': if (n >= 6) { l.strategySize = n; changed(); } return;
      case 'lpg-stratfont': l.strategyFont = val; return changed();
      case 'lpg-stratalign': l.strategyAlign = val; return changed();
      case 'lpg-stratbold': l.strategyBold = val; return changed();
      case 'lpg-stratitalic': l.strategyItalic = val; return changed();
      case 'lpg-stratcolor': l.strategyColor = val; return changed();
      case 'lpg-group': l.batchGroup = val || null; return changed({ props: true });
      case 'lpg-cols': l.columns = n >= 1 ? Math.round(n) : 0; $('lpg-grid').textContent = gridNote(l); return changed();
      case 'lpg-rows': l.rows = n >= 1 ? Math.round(n) : 0; $('lpg-grid').textContent = gridNote(l); return changed();
      case 'lpg-order': l.order = val === 'col' ? 'col' : 'row'; return changed({ props: true });
      case 'lpg-id': l.idShow = val; return changed({ props: true });
      case 'lpg-idalign': l.idAlign = val; return changed();
      case 'lpg-idsize': if (n >= 6) { l.idSize = n; changed(); } return;
      case 'lpg-idfont': l.idFont = val; return changed();
      case 'lpg-idbold': l.idBold = val; return changed();
      case 'lpg-iditalic': l.idItalic = val; return changed();
      case 'lpg-idcolor': l.idColor = val; return changed();
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
        case 'lp-dot': if (n >= 1 && n <= 6) { it.dotSize = Math.round(n); changed(); } return;
        case 'lp-depth': if (n >= 0 && n <= 1) { it.depth = n; changed(); } return;
        case 'lp-w': if (n >= 80) { it.w = n; changed(); } return;
        case 'lp-h': if (n >= 80) { it.h = n; changed(); } return;
        case 'lp-gates': it.showGates = val; return changed();
        default: return;
      }
    }
    switch (t.id) {
      case 'lt-text': it.text = val; return changed();
      case 'lt-font': if (n >= 6) { it.fontSize = n; changed(); } return;
      case 'lt-align': it.align = val; return changed();
      case 'lt-bold': it.bold = val; return changed();
      case 'lt-italic': it.italic = val; return changed();
      case 'lt-color': it.color = val; return changed();
      case 'lt-family': it.font = val; return changed();
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
    if (['new-layout', 'del-item', 'dup-item'].includes(act) || (act === 'del-layout' && b.dataset.confirm === '1')) env.checkpoint();
    if (act === 'new-layout') {
      const nl = newLayout(`Layout ${layouts().length + 1}`);
      layouts().push(nl);
      ui.layoutId = nl.id;
      pick(null);
      env.changed();
      return render();
    }
    if (act === 'pick-layout') { ui.layoutId = b.dataset.id; pick(null); return render(); }
    if (act === 'pick-item') {
      if (e.shiftKey || e.ctrlKey || e.metaKey) toggle(b.dataset.id); else pick(b.dataset.id);
      return render();
    }
    if (act === 'add-text') return addText();
    if (act === 'add-label') return addText({ label: true });
    if (act === 'ls-rename') {
      const row = b.closest('.lay-pop');
      return env.renameGate(row.dataset.sample, JSON.parse(row.dataset.path), row.querySelector('.pop-name').getBoundingClientRect());
    }
    if (act === 'ls-add') {
      const row = b.closest('.lay-pop');
      return addFromSidebar(row.dataset.sample, JSON.parse(row.dataset.path));
    }
    if (act === 'ls-sample-twisty') {
      const k = `s:${b.closest('.sample-row').dataset.sample}`;
      if (ui.closed.has(k)) ui.closed.delete(k); else ui.closed.add(k);
      return renderSamplesSide();
    }
    if (act === 'ls-pop-twisty') {
      const k = b.dataset.key;
      if (ui.closed.has(k)) ui.closed.delete(k); else ui.closed.add(k);
      return renderSamplesSide();
    }
    if (act === 'ls-expand' || act === 'ls-collapse') {
      for (const s of env.samples()) {
        const k = `s:${env.sampleKey(s)}`;
        if (act === 'ls-expand') ui.closed.delete(k); else ui.closed.add(k);
      }
      if (act === 'ls-expand') for (const k of [...ui.closed]) if (k.startsWith('p:')) ui.closed.delete(k);
      return renderSamplesSide();
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
      pick(null);
      env.changed();
      return render();
    }
    if (!l) return;
    const it = itemById(ui.sel);
    if (act === 'del-item' && it) return deleteSelected(l);
    if (act === 'dup-item' && it) {
      const copy = { ...JSON.parse(JSON.stringify(it)), id: newId('i'), ...placeFor(l, it.w, it.h) };
      l.items.push(copy);
      if (isGrid(l) && copy.kind === 'plot') movePlot(l, copy, l.items.filter((x) => x.kind === 'plot').indexOf(it) + 1);
      tidy(l);
      pick(copy.id);
      env.changed();
      return render();
    }
    if (act === 'copy-item' && it) return copyImage(singleItemSheet(it));
    if (act === 'look-all' && it?.kind === 'plot') {
      env.checkpoint();
      for (const x of l.items) if (x.kind === 'plot') Object.assign(x, { dotSize: it.dotSize || 1, depth: it.depth || 0 });
      env.changed();
      env.toast('Every plot on this page has this dot size and colour depth.');
      return render();
    }
    if (act === 'text-keep') {
      // The sizes and gate labels of the selected plot (or, from the batch
      // card, the first plot) on every plot in every layout, and the default
      // for new ones for the rest of the session.
      const ref = b.dataset.src === 'lb' ? l.items.find((x) => x.kind === 'plot') : it?.kind === 'plot' ? it : null;
      if (!ref) return;
      env.checkpoint();
      const d = { fontSize: ref.fontSize || 11, sizes: ref.sizes ? { ...ref.sizes } : null, stats: { ...statsOf(ref) }, pctSign: ref.pctSign !== false, showLabels: ref.showLabels !== false };
      for (const lay of layouts()) {
        for (const x of lay.items) if (x.kind === 'plot') applyDefaults(x, d);
      }
      env.setPlotDefaults(d);
      env.changed();
      env.toast('Text sizes and gate labels set for every plot; new plots will start with them.');
      return render();
    }
    const sh = () => exportSheet(l);
    const name = `${fileBase(l)}${exportScope() === 'sel' ? '-selected' : ''}`;
    if (act === 'svg') return save(`${name}.svg`, sh().svg, 'image/svg+xml');
    if (act === 'png') {
      const x = sh();
      try { return save(`${name}.png`, await svgToPngBlob(x.svg, x.width, x.height, 2), 'image/png'); } catch (err) { return env.toast(err.message, true); }
    }
    if (act === 'copy') return copyImage(sh());
  }

  // Dragging and resizing items on the page.
  let drag = null;
  let lastDown = { id: null, t: 0 }; // "<copy>:<item id>" of the last press, for double-clicks

  // The plot item under a pointer event on the sheet, and which batch copy.
  function plotAt(sheetEl, e) {
    const l = current();
    if (!l || !ui.blocks) return null;
    const r = sheetEl.getBoundingClientRect();
    const X = (e.clientX - r.left) / ui.zoom, Y = (e.clientY - r.top) / ui.zoom;
    for (let b = 0; b < ui.blocks.length; b++) {
      const x = X - ui.blocks[b].dx, y = Y - ui.blocks[b].dy;
      const it = l.items.find((i) => i.kind === 'plot' && x >= i.x && x <= i.x + i.w && y >= i.y && y <= i.y + i.h);
      if (it) return { it, block: b };
    }
    return null;
  }

  // Opens a plot for editing, for the sample of the given copy (batch) or
  // the page's sample.
  function openEditor(it, block) {
    const l = current();
    const pageSample = l.batch ? ui.blocks?.[block]?.sample : pageSampleOf(l);
    const s = sampleFor(it, pageSample);
    if (!s) return;
    ui.editMark = { id: it.id, block };
    env.editPlot(it, s);
    renderStage();
  }

  function onPointerDown(e) {
    if (e.target.closest('.lay-axis-hot')) return; // a channel menu opens instead
    const box = e.target.closest('.lay-box');
    const stage = $('lay-stage');
    if (!box) {
      const sheetEl = e.target.closest('.lay-sheet');
      if (!sheetEl) return;
      // In batch, the other copies are part of the picture: a double-click on
      // a plot there opens it for that copy's sample.
      const hit = plotAt(sheetEl, e);
      const now = Date.now();
      if (hit && lastDown.id === `${hit.block}:${hit.it.id}` && now - lastDown.t < 400) {
        lastDown = { id: null, t: 0 };
        openEditor(hit.it, hit.block);
        return;
      }
      lastDown = hit ? { id: `${hit.block}:${hit.it.id}`, t: now } : { id: null, t: 0 };
      const add = e.shiftKey || e.ctrlKey || e.metaKey;
      // In batch, a click on a plot in any copy selects it there.
      if (hit && current().batch) {
        pickCopy(hit.block, hit.it.id, add);
        render();
        return;
      }
      // Dragging on the page draws a box that selects the items it touches
      // (with Shift or Ctrl/⌘, adding to the selection).
      marquee = { x0: e.clientX, y0: e.clientY, add, base: add ? [...ui.copySel] : [], moved: false };
      stage.setPointerCapture?.(e.pointerId);
      if (!add && (ui.sel || ui.multi.size)) { pick(null); render(); }
      return;
    }
    const it = itemById(box.dataset.id);
    if (!it) return;
    e.preventDefault();
    // A double-click on a plot opens it for editing its gates.
    const now = Date.now();
    if (it.kind === 'plot' && lastDown.id === `0:${it.id}` && now - lastDown.t < 400 && !e.target.closest('[data-act="resize"]')) {
      lastDown = { id: null, t: 0 };
      openEditor(it, 0);
      return;
    }
    // Shift- or Ctrl/⌘-click adds to the selection or takes away from it.
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      lastDown = { id: null, t: 0 };
      toggle(it.id);
      render();
      return;
    }
    lastDown = { id: `0:${it.id}`, t: now };
    const l = current();
    if (!selection().some((x) => x.id === it.id)) { pick(it.id); render(); } else if (ui.sel !== it.id) { ui.sel = it.id; renderProps(); }
    const resize = !!e.target.closest('[data-act="resize"]');
    // A plot in grid mode is moved between cells; everything else selected
    // moves together (plots in grid mode stay in their cells).
    const gridPlot = isGrid(l) && it.kind === 'plot' && !resize;
    const group = resize ? [it] : selection().filter((x) => !(isGrid(l) && x.kind === 'plot'));
    drag = { it, resize, gridPlot, sx: e.clientX, sy: e.clientY, ow: it.w, oh: it.h, moved: false, items: group.map((x) => ({ it: x, ox: x.x, oy: x.y })) };
    stage.setPointerCapture?.(e.pointerId);
  }
  let marquee = null;
  function onMarqueeMove(e) {
    const m = marquee;
    if (!m.moved && Math.hypot(e.clientX - m.x0, e.clientY - m.y0) < 4) return;
    m.moved = true;
    const sheetEl = root.querySelector('.lay-sheet');
    if (!sheetEl) return;
    const r = sheetEl.getBoundingClientRect();
    const x1 = Math.min(m.x0, e.clientX), x2 = Math.max(m.x0, e.clientX);
    const y1 = Math.min(m.y0, e.clientY), y2 = Math.max(m.y0, e.clientY);
    let el = sheetEl.querySelector('.lay-marquee');
    if (!el) { el = document.createElement('div'); el.className = 'lay-marquee'; sheetEl.querySelector('.lay-overlay').append(el); }
    Object.assign(el.style, { left: `${x1 - r.left}px`, top: `${y1 - r.top}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });
    // Items the box touches, in every copy of a batch (sheet units).
    const z = ui.zoom;
    const X1 = (x1 - r.left) / z, X2 = (x2 - r.left) / z, Y1 = (y1 - r.top) / z, Y2 = (y2 - r.top) / z;
    const keys = new Set(m.base);
    (ui.blocks || []).forEach((bl, b) => {
      for (const it of current().items) {
        if (it.x + bl.dx < X2 && it.x + it.w + bl.dx > X1 && it.y + bl.dy < Y2 && it.y + it.h + bl.dy > Y1) keys.add(`${b}:${it.id}`);
      }
    });
    ui.copySel = keys;
    const ids = new Set([...keys].map((k) => k.split(':')[1]));
    ui.multi = ids;
    ui.sel = [...ids][0] || null;
    root.querySelectorAll('.lay-box').forEach((b) => b.classList.toggle('is-sel', ids.has(b.dataset.id)));
    root.querySelectorAll('.lay-copy-sel').forEach((n) => n.remove());
    root.querySelector('.lay-overlay')?.insertAdjacentHTML('afterbegin', copyMarks());
  }

  function onPointerMove(e) {
    if (marquee) { onMarqueeMove(e); return; }
    if (!drag) return;
    const l = current();
    const dx = (e.clientX - drag.sx) / ui.zoom, dy = (e.clientY - drag.sy) / ui.zoom;
    if (!drag.moved && Math.hypot(dx, dy) < 2) return;
    if (!drag.moved) env.checkpoint();
    drag.moved = true;
    const { it } = drag;
    const z = ui.zoom;
    const o = ui.origin || { dx: 0, dy: 0 };
    if (drag.gridPlot) {
      // The plot goes to the cell under the pointer; the others reflow.
      const r = root.querySelector('.lay-sheet').getBoundingClientRect();
      const idx = cellAt(l, (e.clientX - r.left) / z - o.dx, (e.clientY - r.top) / z - o.dy);
      if (idx !== l.items.filter((x) => x.kind === 'plot').indexOf(it)) {
        movePlot(l, it, idx);
        applyGrid(l);
        renderStage();
      }
      return;
    }
    if (drag.resize) {
      it.w = Math.max(it.kind === 'text' ? 20 : 120, snap(drag.ow + dx));
      it.h = Math.max(it.kind === 'text' ? 12 : 120, snap(drag.oh + dy));
    } else {
      for (const m of drag.items) {
        m.it.x = Math.max(0, Math.min(l.width - 20, snap(m.ox + dx)));
        m.it.y = Math.max(0, Math.min(l.height - 12, snap(m.oy + dy)));
      }
    }
    for (const x of drag.resize ? [it] : drag.items.map((m) => m.it)) {
      const box = root.querySelector(`.lay-box[data-id="${x.id}"]`);
      if (box) Object.assign(box.style, { left: `${(x.x + o.dx) * z}px`, top: `${(x.y + o.dy) * z}px`, width: `${x.w * z}px`, height: `${x.h * z}px` });
    }
    renderSoon();
  }
  function onPointerUp() {
    if (marquee) {
      const moved = marquee.moved;
      marquee = null;
      if (moved) render();
      return;
    }
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) { tidy(current()); env.changed(); render(); }
  }

  // Removes every selected item from the page.
  function deleteSelected(l) {
    const gone = selection();
    l.items = l.items.filter((x) => !gone.includes(x));
    pick(null);
    for (const x of gone) env.itemRemoved(x);
    tidy(l);
    env.changed();
    render();
  }

  function onKey(e) {
    if (root.hidden || e.target.matches('input, textarea, select') || env.editing()) return;
    const sel = selection();
    if (!sel.length) return;
    const l = current();
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      env.checkpoint();
      deleteSelected(l);
      return;
    }
    const step = e.shiftKey ? 16 : GRID;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      env.checkpoint('nudge');
      if (isGrid(l) && sel.length === 1 && sel[0].kind === 'plot') {
        // In grid mode a plot steps to the next cell over.
        const { cols } = gridCells(l);
        const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key];
        movePlot(l, sel[0], l.items.filter((x) => x.kind === 'plot').indexOf(sel[0]) + d);
      } else {
        for (const x of sel) {
          if (isGrid(l) && x.kind === 'plot') continue;
          x.x = Math.max(0, x.x + moves[e.key][0]);
          x.y = Math.max(0, x.y + moves[e.key][1]);
        }
      }
      tidy(l);
      env.changed();
      render();
    }
    if (e.key === 'Escape') { pick(null); render(); }
  }

  root.addEventListener('click', onClick);
  // A card folded or opened.
  root.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d.matches?.('#lay-props details[data-card]')) return;
    const key = d.dataset.card;
    if (d.open === !ui.shut.has(key)) return;
    if (d.open) ui.shut.delete(key); else ui.shut.add(key);
    try { localStorage.setItem('freeflow.layoutCardsShut', JSON.stringify([...ui.shut])); } catch { /* not kept */ }
    if (d.open && key === 'export') schedulePreview();
  }, true);
  // Axis title menus get their channels just before they open.
  const axisMenu = (e) => { const sel = e.target.closest?.('.lay-axis-hot select'); if (sel) fillAxisMenu(sel); };
  root.addEventListener('pointerdown', axisMenu, true);
  root.addEventListener('focusin', axisMenu);
  root.addEventListener('input', (e) => { if (e.target.closest('#lay-props')) onPropInput(e); });
  root.addEventListener('change', (e) => {
    const t = e.target;
    // A channel picked from an axis title on the page.
    const hot = t.closest('.lay-axis-hot');
    if (hot) {
      const it = itemById(t.dataset.item);
      const s = it && sampleFor(it, ui.blocks?.[+t.dataset.block || 0]?.sample || pageSampleOf(current()));
      if (!it) return;
      env.checkpoint();
      it.view = { ...itemView(it, s), [t.dataset.axis]: t.value };
      changed({ props: true });
      return;
    }
    // Order and names of the folder's samples.
    if (t.type === 'range' && t.closest('#lay-props')) onPropInput(e);
    if (t.matches('#lay-samples .order-box')) env.setOrder(t.dataset.sample, t.value);
    if (t.matches('#lay-samples .label-box')) env.setLabel(t.dataset.sample, t.value);
  });
  root.addEventListener('keydown', (e) => {
    if (!e.target.matches('#lay-samples .order-box, #lay-samples .label-box')) return;
    if (e.key === 'Enter') e.target.blur();
    if (e.key === 'Escape') renderSamplesSide();
  });
  root.addEventListener('pointerdown', onPointerDown);

  // Drag a population from the samples sidebar onto the page.
  let dragged = null;
  root.addEventListener('dragstart', (e) => {
    const row = e.target.closest?.('.lay-pop');
    if (!row) return;
    dragged = { key: row.dataset.sample, path: JSON.parse(row.dataset.path) };
    e.dataTransfer.setData('text/plain', row.querySelector('.pop-name').textContent);
    e.dataTransfer.effectAllowed = 'copy';
  });
  root.addEventListener('dragend', () => { dragged = null; $('lay-stage').classList.remove('is-drop-target'); });
  root.addEventListener('dragover', (e) => {
    if (!dragged || !e.target.closest('#lay-stage')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    $('lay-stage').classList.add('is-drop-target');
  });
  root.addEventListener('dragleave', (e) => { if (!e.relatedTarget || !$('lay-stage').contains(e.relatedTarget)) $('lay-stage').classList.remove('is-drop-target'); });
  root.addEventListener('drop', (e) => {
    if (!dragged) return;
    e.preventDefault();
    e.stopPropagation();
    $('lay-stage').classList.remove('is-drop-target');
    const sheetEl = root.querySelector('.lay-sheet');
    const src = dragged;
    dragged = null;
    if (!sheetEl || !e.target.closest('#lay-stage')) return;
    const r = sheetEl.getBoundingClientRect();
    const l = current() || ensureLayout();
    const o = ui.origin || { dx: 0, dy: 0 };
    const at = { x: Math.min(l.width, (e.clientX - r.left) / ui.zoom - o.dx), y: Math.min(l.height, (e.clientY - r.top) / ui.zoom - o.dy) };
    addFromSidebar(src.key, src.path, at);
  });
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  document.addEventListener('keydown', onKey);
  // Redrawn when the stage changes width (the sheet is scaled to fit it), and
  // not otherwise: a redraw would close a channel menu that is open.
  let stageW = 0;
  new ResizeObserver(() => {
    if (root.hidden) return;
    const w = $('lay-stage').clientWidth;
    if (w === stageW) return;
    stageW = w;
    renderStage();
  }).observe(root);

  return {
    render,
    addPlot: (s, pop, view) => { const r = addPlot(s, pop, view); return r; },
    select: (layoutId, itemId) => { ui.layoutId = layoutId; pick(itemId); },
    currentName: () => current()?.name || '',
    invalidate: () => imageCache.clear(),
  };
}
