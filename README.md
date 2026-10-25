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
  - **Biex** (FlowJo's biexponential, the default for fluorescence): top of scale, positive
    decades, width basis (−1 to −1000), extra negative decades. This is a port of
    FlowJo's own lookup-table algorithm, checked against FlowKit's implementation, so plots and
    polygon gates match FlowJo.
  - Logicle (Parks et al. 2006): T, W, M, A
  - arcsinh (cofactor, min, max)

  Sliders redraw live. **Estimate width from this sample** sets the width from the spread of
  the negative events (Parks et al. 2006). A detector's raw and compensated channels share
  one axis setting.
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

## Layouts and figures

Switch to **Layout** (top bar) to arrange figures. In Gating, **Add to layout** places the plot
you are looking at on the current layout.

- Drag items to move them, drag the corner to resize, arrow keys to nudge (Shift for bigger
  steps), Delete to remove.
- Per plot: sample, population, plot type (pseudocolor, dot, histogram), X and Y channels,
  title, axis labels, font size, width and height, gates and gate labels on or off.
- Text items and titles take fill-ins: `{sample}`, `{population}`, `{parent}`, `{count}`,
  `{freq}` (of parent), `{freqTotal}`, `{x}`, `{y}`, `{n}`, and any keyword of the sample in
  braces, such as `{$DATE}` or `{DONOR}` (including keywords added in FlowJo).
- **Batch** repeats the page for every sample, in a grid with a chosen number of copies per
  row; each copy fills in its own sample's numbers and keywords.
- Export: **Download SVG** (vector axes, ticks, text, gates and histograms, editable in
  Illustrator, Inkscape or PowerPoint; density clouds embedded as images), **Download PNG**,
  **Copy as image**, **Copy plot as image** for one plot, and a preview image you can
  right-click to copy.
- Page sizes: Letter and A4 (portrait or landscape), 16:9 slide, or custom.
- Layouts are kept with shared workspaces. They are not part of the .wsp file, since FlowJo's
  layout format is different.

## FlowJo workspaces (.wsp)

- **Save & share → Download .wsp** writes a FlowJo 10 workspace with every open sample's
  gates, axis settings, compensation matrix and keywords. On claude.ai the file is saved
  inside a .zip (the hosted page can only save certain file types); unzip it before opening it
  in FlowJo. Opened from `dist/freeflow.html`, it saves the .wsp directly.
- **Open folder** opens a folder of FCS files containing exactly one .wsp, applies the
  workspace and connects each of its samples to an FCS file by file name (then by `$FIL`),
  checking event counts. A folder with no .wsp, or more than one, is refused with an
  explanation. Dropping a folder on the page does the same. **Open FCS files** also accepts a
  .wsp (or the saved .zip) picked together with FCS files.
- Imported from FlowJo: rectangle, polygon, ellipse (converted to a polygon, as FlowJo does
  internally), range and quadrant gates; linear, log, biex, Logicle and ArcSinh axes;
  compensation matrices (any prefix); custom keywords; plot axes per population. Not yet
  imported (reported by name when skipped): Boolean gates, exclusion ("outside") gates,
  spectral unmixing matrices, derived parameters.
- Checked with [FlowKit](https://github.com/whitews/FlowKit), an independent reader of
  FlowJo 10 workspaces: `npm run check:flowjo` exports the example samples with every gate
  and axis type, has FlowKit gate the FCS files from the .wsp, and compares counts. All 33
  populations match exactly. (Needs Python with `pip install flowkit`.) FlowJo itself has
  not been run on these files yet; please report anything it does differently.

## Working together

Share the FreeFlow page from its **Share** menu on claude.ai (as Contributor or Editor), then
use **Save & share → Share** to publish the current analysis as a shared workspace. Anyone
who opens the page can open it and sees changes live: gates, axis settings and compensation
sync as people edit; each person keeps their own plot views. FCS data is not uploaded: each
person opens their own copy of the files, matched by file name and event count, and the panel
lists files they still need to open. Viewers with view-only access can see but not change a
shared workspace. When two people change the same sample at the same moment, the later
change wins.

## Roadmap

- **Phase 2**: compute compensation from single-stain controls (auto-detected from
  keywords and filenames), sample groups, gates linked across a group.
- **Phase 3**: sample- and group-level annotations you type in, table editor with CSV/Excel
  export, histogram overlays in layouts.
- **Phase 4**: Boolean and exclusion gates, derived parameters, contour/zebra plots,
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
npm test        # unit tests: transforms, FCS, compensation, gating, .wsp, zip, sync
npm run check:flowjo   # .wsp round trip through FlowKit (needs Python + flowkit)
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
| `src/biex.js` | FlowJo biex transform |
| `src/model.js` | Samples: channels, compensation, gating context |
| `src/wsp.js` | FlowJo workspace export and import |
| `src/zip.js` | Zip reading and writing |
| `src/share.js` | Live shared workspaces |
| `src/figure.js` | Figures as SVG |
| `src/layout.js` | Layout editor |
| `src/app.js` | Interface and state |
