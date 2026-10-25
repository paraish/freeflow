# FreeFlow

Flow cytometry analysis in the browser: open FCS files, compensate, draw gates on
transformed axes, and compare population statistics across samples. Files are read
locally in your browser and are never uploaded.

**Status: Phase 1 (gating core).** Built for conventional (non-spectral) cytometers.

## Use it

Open `dist/freeflow.html` in any modern browser (download it, then double-click it).
It is a single self-contained file. It opens with three synthetic example samples
so you can try everything before loading your own data. Opening your own files
replaces the examples.

### What works now

- **FCS files**: FCS 2.0, 3.0, 3.1 and 3.2, with float, double and integer data, either byte
  order, log-amplified integer channels (`$PnE`), and supplemental text segments.
  Drop files anywhere on the page or use **Open FCS files**.
- **Compensation**: the acquisition matrix (`$SPILLOVER`, `SPILL`, `$SPILL`) is read and
  applied automatically, creating `Comp-` parameters. The matrix can be edited per sample,
  switched off, reset, or applied to all samples.
- **Axis scaling** per parameter:
  - linear (min/max)
  - log (decades)
  - biexponential (Logicle): top of scale **T**, positive decades **M**, linear width **W**,
    extra negative decades **A**
  - arcsinh (cofactor, min, max)

  Sliders redraw live. **Estimate width from this sample** sets W from the spread of the
  negative events (Parks et al. 2006).
- **Plots**: pseudocolor density, dot, and histogram.
- **Gates**: rectangle, polygon, quadrant, range. Move gates, drag their corners, rename,
  delete, undo (Ctrl/⌘+Z). Rectangle edges drawn at the plot border stay open-ended, so
  off-scale events are kept. Double-click a gate to open that population.
- **Population tree** with counts and % of parent.
- **Samples column**: every sample with its own gating tree, each collapsible (per sample,
  per population, or **Expand all** / **Collapse all**). It scrolls separately from the
  active sample's **Populations** column, so you can drag between any two trees. Clicking a
  population in any sample's tree opens it.
- **Copying gates between populations**:
  - Drag a gate onto any population, in the same sample or any other sample's tree, to
    copy it (with its sub-gates) there. Quadrant gates travel as their set of four.
  - Select several gates with Ctrl/⌘-click (toggle) or Shift-click (range), then drag any
    of them to copy them all together. A gate whose parent is also selected comes along
    with its parent rather than being copied twice. Esc clears the selection.
  - Drop gates on a sample's name to copy each one to the same place in that sample's tree.
  - Or press Ctrl/⌘+C (or **Copy gate**), open any population in any sample, and press
    Ctrl/⌘+V (or **Paste**). Ctrl/⌘+C copies the multi-selection if there is one.
  - **Copy to all samples** and **Copy tree to all** copy to every other sample. In these
    and in drops on a sample's name, a population with the same name is updated, not
    duplicated.
- **Statistics**: per-population median, mean and CV for every channel, and a
  samples × populations table (frequency of parent, frequency of total, count, median or
  mean of a chosen channel). **Copy table** puts it on the clipboard for Excel or Sheets.
- **Keywords**: browse and filter every keyword in each file.

### Keyboard

| Key | Action |
| --- | --- |
| V / R / P / Q / G | Select, rectangle, polygon, quadrant, range tools |
| Enter or double-click | Close a polygon |
| Ctrl/⌘-click, Shift-click | Select several gates in a tree |
| Esc | Cancel drawing / clear selection / deselect |
| Delete / Backspace | Delete the selected gate |
| Ctrl/⌘ + C, Ctrl/⌘ + V | Copy the selected gate, paste it into the population being viewed |
| Ctrl/⌘ + Z | Undo |

## Roadmap

- **Phase 2**: compute compensation from single-stain controls (auto-detected from
  keywords and filenames), sample groups, gates linked across a group, save and reopen workspaces.
- **Phase 3**: layout editor and batch reports, annotations built from file keywords and
  sample- or group-level values, table editor with CSV/Excel export.
- **Phase 4**: FlowJo `.wsp` import, Boolean gates, derived parameters, contour/zebra plots,
  dimensionality reduction.

## Accuracy notes

- The biexponential axis is the published Logicle transform (Parks, Roederer & Moore,
  *Cytometry A* 2006; Moore & Parks 2012). FlowJo's biex is close to it but not identical,
  so plots can look slightly different. Population frequencies from axis-aligned gates
  (rectangle, range, quadrant) do not depend on the axis transform at all.
- Polygon gates are evaluated in display space, so changing an axis transform after
  drawing a polygon changes which events it contains, as in FlowJo.
- Off-scale events are drawn pinned to the plot edge and are counted by gates that touch
  that edge.

## Development

```sh
npm install
npm test        # unit tests: Logicle, FCS parsing, compensation, gating
npm run build   # writes dist/freeflow.html
```

Source is plain ES modules in `src/`, bundled into one HTML file by `scripts/build.mjs`.

| File | Contents |
| --- | --- |
| `src/fcs.js` | FCS reader and FCS 3.1 writer |
| `src/logicle.js` | Logicle transform |
| `src/transforms.js` | Axis transforms and tick placement |
| `src/compensation.js` | Matrix inversion and compensation |
| `src/gating.js` | Gate evaluation, population tree, statistics |
| `src/plot.js` | Canvas rendering |
| `src/synth.js` | Synthetic example data |
| `src/app.js` | Interface and state |
