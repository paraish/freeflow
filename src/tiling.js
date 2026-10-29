// "Snap to grid" arrangement of a layout page: plots fill a grid of cells
// in their order on the page (left to right, then down). Text items stay
// where they are; titles near the top of the page keep the grid below them.
//
// A layout in grid mode has arrange: 'grid', gridCols, gridRows and gridTop
// (where the grid starts). Rows grow when there are more plots than cells.
// Text added later floats over the page and does not move the grid.

export const GRID_MARGIN = 24;
export const GRID_GAP = 12;

const plotsOf = (layout) => layout.items.filter((it) => it.kind === 'plot');

// Where the grid starts: the layout's own setting, or else below any text in
// the top quarter of the page (titles).
function gridTop(layout) {
  return Number.isFinite(layout.gridTop) ? layout.gridTop : titleTop(layout);
}

export function titleTop(layout) {
  let top = GRID_MARGIN;
  for (const it of layout.items) {
    if (it.kind === 'text' && it.y < layout.height / 4) top = Math.max(top, it.y + it.h + GRID_GAP);
  }
  return top;
}

// The grid's cells, in plot order. Cells are square (flow plots are), as
// big as the columns and rows allow, in a block centred across the page.
export function gridCells(layout) {
  const plots = plotsOf(layout);
  const cols = Math.max(1, Math.round(layout.gridCols || 1));
  const rows = Math.max(1, Math.round(layout.gridRows || 1), Math.ceil(plots.length / cols));
  const top = gridTop(layout);
  const w = (layout.width - 2 * GRID_MARGIN - (cols - 1) * GRID_GAP) / cols;
  const h = (layout.height - top - GRID_MARGIN - (rows - 1) * GRID_GAP) / rows;
  const size = Math.max(40, Math.floor(Math.min(w, h)));
  const left = Math.round((layout.width - (cols * size + (cols - 1) * GRID_GAP)) / 2);
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) cells.push({ x: left + c * (size + GRID_GAP), y: Math.round(top + r * (size + GRID_GAP)), w: size, h: size });
  }
  return { cols, rows, top, cells };
}

// Columns and rows to start with: up to three columns, and as many rows of
// square cells as fit on the page (at least enough for every plot).
export function defaultGrid(layout) {
  const n = plotsOf(layout).length;
  const cols = Math.max(1, Math.min(3, n));
  const w = (layout.width - 2 * GRID_MARGIN - (cols - 1) * GRID_GAP) / cols;
  const fit = Math.floor((layout.height - gridTop(layout) - GRID_MARGIN + GRID_GAP) / (w + GRID_GAP));
  return { cols, rows: Math.max(1, Math.ceil(n / cols), fit) };
}

// Puts every plot in its cell.
export function applyGrid(layout) {
  const { cells } = gridCells(layout);
  plotsOf(layout).forEach((it, i) => Object.assign(it, cells[i]));
}

// The cell nearest a page position.
export function cellAt(layout, x, y) {
  const { cells } = gridCells(layout);
  let best = 0, bestD = Infinity;
  cells.forEach((c, i) => {
    const d = Math.hypot(x - (c.x + c.w / 2), y - (c.y + c.h / 2));
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

// Moves a plot to a position in the plot order (other plots shift along),
// keeping text items where they are in the list.
export function movePlot(layout, item, index) {
  const plots = plotsOf(layout).filter((p) => p !== item);
  index = Math.max(0, Math.min(plots.length, index));
  plots.splice(index, 0, item);
  let k = 0;
  layout.items = layout.items.map((it) => (it.kind === 'plot' ? plots[k++] : it));
}
