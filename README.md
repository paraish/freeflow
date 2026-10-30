<img src="assets/logo.svg" width="72" alt="FreeFlow logo: a droplet holding a density plot">

# FreeFlow

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23650055.svg)](https://doi.org/10.5281/zenodo.23650055)


A free, open-source tool for flow cytometry analysis and figure generation, running in the
browser: open FCS files, compensate, gate, compare statistics across samples and build
figures. Files are read locally in your browser and are never uploaded.

**Status: Phase 1 (gating core).** Built for conventional (non-spectral) cytometers.

## New: group gating

**Gate many related samples at once, then fine-tune each one.** Open **Group gating**, pick a
folder of samples (for example, every tube from one experiment), and draw your gates once on
one sample. They are applied to every sample in the folder straight away, and every sample is
tiled below so you can check them all at a glance.

**Then adjust any single sample's gate in its own tile.** Where one sample's population has
shifted, drag or reshape its gate right in the tile. Only that sample changes, it is marked
"adjusted", and the gates beneath it stay in the folder and recalculate from it. Later changes
made for the whole folder leave adjusted samples alone, and **Reset** gives a sample the
folder's gates back.

How it works:

- Folders sit above the samples on the left. One sample is shown large; below it, every
  sample in the folder shows the same population on the same axes. Click a tile, anywhere
  including on a gate, or a sample on the left to show it large (a tile keeps the axes you
  were looking at); dragging a gate in a tile adjusts it for that sample instead.
- Gates drawn on the large plot are added to every sample in the folder, nested under the
  population that is open. Moving, reshaping, renaming or deleting a gate there changes it
  for the whole folder.
- In a tile, gates can be moved and reshaped for that sample only; new gates are drawn on
  the large plot. Double-click a gate to open that population on every sample.
- The Samples pane shows every population. Gates that aren't the folder's are greyed: open
  one to start folder gates under it.

## Use it

Use it at **https://paraish.github.io/freeflow/**, or open `dist/freeflow.html` in any
modern browser (download it, then double-click it); it is a single self-contained file.
It opens on a welcome screen: open FCS files, open a folder (with its .wsp workspace, if it has one), or
**Try sample data** (three synthetic samples with gates and an example figure, removable
with one click).

### What works now

- **FCS files**: FCS 2.0, 3.0, 3.1 and 3.2, with float, double and integer data, either byte
  order, log-amplified integer channels (`$PnE`), and supplemental text segments.
  Drop files anywhere on the page or use **Open FCS files**.
- **Compensation**: the acquisition matrix (`$SPILLOVER`, `SPILL`, `$SPILL`) is read and
  applied automatically, creating `Comp-` parameters. **Hide uncompensated** (beside the Compensation
  button) leaves the raw detector channels out of the channel menus (plot axes, axis titles,
  layouts and statistics); a plot already using one keeps it. The matrix can be edited per sample,
  switched off, reset, or applied to all samples.
- **Compensation from single-stain controls** (Compensation → Calculate from controls):
  - Finds the unstained control and one single-stain control per fluorochrome automatically,
    from file and tube names (BD FACSDiva's "FITC Stained Control", "Unstained Control",
    names with the fluorochrome or marker) and from which detector each control is brightest
    in. It warns when a control's name and data disagree. Every assignment can be changed.
  - Spillover = (median of bright positives − median of negatives) in each detector ÷ the
    same in the stain's own detector, on uncompensated data. Negatives come from the
    unstained control, or from each control's dim events if there is none. You can measure on
    a gated population (e.g. Singlets) instead of all events.
  - Shows the matrix, events used and warnings (too few positives, weak separation, missing
    controls) before you apply it to all samples except the controls, all samples, or one.
  - Checked on synthetic controls made with a known matrix: every value is recovered within
    0.15 percentage points.
  - Controls are marked in the sample list and left out of batch layouts.

  - linear (min/max)
  - log (decades)
  - **Biex** (the widely used lookup-table biexponential, the default for fluorescence): top of
    scale, positive decades, width basis (−1 to −1000), extra negative decades. Ported from
    FlowKit and checked against its implementation (see `NOTICE`), so plots and polygon gates
    match other software that reads .wsp workspaces.
  - Logicle (Parks et al. 2006): T, W, M, A
  - arcsinh (cofactor, min, max)

  Sliders redraw live. **Estimate width from this sample** sets the width from the spread of
  the negative events (Parks et al. 2006). A detector's raw and compensated channels share
  one axis setting.
- **Plots**: pseudocolor density, dot, and histogram. Click an axis title to pick its channel
  (or use the X and Y menus above the plot). **Dot size** (beside the plot types) makes each
  event bigger, and **Colour depth** deepens the pseudocolor colours (same colour scale) for
  plots that look pale, such as small populations; figures in Layout have their own Dot size
  and Colour depth sliders, and new layout plots start with the ones set here.
- **Gates**: rectangle, polygon, quadrant, range. A name box opens as soon as a gate is drawn
  (Enter to keep the name, Esc to keep the default). Hover a gate in the trees for ✎ (rename)
  and × (delete, with the gates under it; click twice to confirm, Ctrl/⌘+Z to undo). Move gates, drag their corners, rename,
  delete, with **Undo** and **Redo** buttons in the header (Ctrl/⌘+Z, Ctrl/⌘+Shift+Z or Ctrl+Y). Rectangle edges drawn at the plot border stay open-ended, so
  off-scale events are kept. Double-click a gate to open that population.
  Drag a gate's label box (its name and %) to move it out of the way; it keeps that place on
  that sample, in Group gating tiles and in Layout figures.
  A gate stays visible and editable when the plot shows its two channels the other way round
  (for example APC vs FITC for a FITC vs APC gate): it is drawn mirrored, and moving it there
  changes the same gate.
- **Population tree** with counts and % of parent.
- **Folders** (leftmost column): non-exclusive groups of samples. **All samples**,
  **Compensation controls** (recognised from names like "Stained Control" or "Unstained", plus
  controls picked in the compensation calculator) and **Non-control samples** (everything
  else) are built in. The bar at the bottom of the
  pane makes a folder in one step: a name (blank gives Group 1, Group 2, …) and, optionally,
  text that file names must contain, with a live count of matches, then **+** or Enter. A folder
  made with a filter keeps adding matching files opened later. Clicking a folder shows its samples in the Samples
  column. Drag a sample onto a folder to add it, use − to take it out (the sample stays open),
  drag a gate onto a folder to copy it to every sample in it, and repeat a batch layout over one
  folder. Folders are saved in analysis bundles, shared workspaces and .wsp files (as sample
  groups), and .wsp sample groups open as folders.
- **Folder gates**: drag a gate onto a folder and it becomes that folder's gate. Every sample in
  the folder gets a linked copy (marked with a blue dot after its name), including samples added to the
  folder later. Moving or reshaping it on one sample changes that sample only: its copy is
  marked "adjusted", stays in the same place in the tree, and the gates under it stay linked and
  recalculate from it. The gate panel offers **Use the folder's gate** (undo the adjustment) and
  **Apply this gate to the whole folder**. Under each folder in the Folders pane, × on a gate asks
  whether to **Delete gate for all samples** or **Delete only the grouping** (each sample keeps
  its copy as an ordinary gate), and ✎ renames it in every sample of the folder (in every view).
  Renaming a folder gate from one sample's tree does the same, and the name box says so. The folder gates listed there can be selected (click; Ctrl/⌘-click or
  Shift-click for several) and dragged onto a sample's name (copied to the same place in that
  sample), onto any population (copied under it), onto another folder (they become that
  folder's gates too), or onto another folder gate (they become its sub-gates, in every sample
  of that folder; gates from the sample trees can be dropped there too). Delete or Backspace deletes the
  selected folder gates (with their sub-gates) from every sample in their folders, in one step
  that Ctrl/⌘+Z undoes. A quadrant gate always goes as its set of four, when selected, copied or
  deleted. Folder gates and adjustments are kept in bundles and shared
  workspaces; .wsp files carry each sample's full gates plus the folder memberships.
- **Folders and samples sidebar**: in Gating and Group gating, the Folders pane and the
  folder's samples share one sidebar at the far left, about a fifth of the window wide. It
  stays in view (beside the statistics table too) and scrolls on its own: down, and sideways
  when names are long (numbers and row buttons stay at its right edge).
- **Samples pane**: every sample with its own gating tree, each collapsible (per sample,
  per population, or **Expand all** / **Collapse all**). It scrolls separately from the
  active sample's **Populations** column, so you can drag between any two trees. Clicking a
  population in any sample's tree opens it.
  - **Order**: samples are listed in the order they were run, from the time stamps in the
    files (`$DATE` and `$BTIM`, or `$BEGINDATETIME`); files without one go last, by name. The
    box beside each sample is its position: type a number to move it. Each folder keeps its own
    order, so the same sample can be first in one folder and last in another; **Run order**
    puts a folder back in run order. Group gating tiles and batch layouts follow the folder's
    order.
  - **Name**: the box under each sample gives it a name for figures (for example a code such as
    WT-1). Layouts show it with `{label}` (or the **Add name label** button), filling in each
    sample's own name in batch; the statistics table gets a Name column.
  - **Selecting several**: Ctrl/⌘-click or Shift-click samples, then drag any of them onto a
    folder to add them all, or use a row's − / × or the Delete key on all of them at once.
  - **Delete / Backspace** with samples selected does what their row button does: in a folder
    you made it takes them out of the folder; elsewhere it closes them (press twice to
    confirm). Your files are never changed.
- **Copying gates between populations**:
  - Drag a gate onto any population, in the same sample or any other sample's tree, to
    copy it (with its sub-gates) there. If that population already has a gate with the same
    name, the dragged gate replaces it (Undo brings the old one back). Quadrant gates travel as their set of four.
  - Select several gates with Ctrl/⌘-click (toggle) or Shift-click (range), then drag any
    of them to copy them all together. A gate whose parent is also selected comes along
    with its parent rather than being copied twice. Esc clears the selection.
  - Drop gates on a sample's name to copy each one to the same place in that sample's tree.
  - Or press Ctrl/⌘+C (or **Copy gate**), open any population in any sample, and press
    Ctrl/⌘+V (or **Paste**). Ctrl/⌘+C copies the multi-selection if there is one.
  - **Copy to all samples** and **Copy tree to all** copy to every other sample. In these
    and in drops on a sample's name, a population with the same name is updated, not
    duplicated.
- **Settings pane**: the axis, transform and gate settings on the right of the Gating view.
  **Hide settings** folds it away to give the plot more room, and the choice is remembered.
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
| Delete / Backspace | Delete the selected gate, or the selected samples (see Samples column) |
| Ctrl/⌘ + C, Ctrl/⌘ + V | Copy the selected gate, paste it into the population being viewed |
| Ctrl/⌘ + Z | Undo |
| Ctrl/⌘ + Shift + Z, Ctrl + Y | Redo |

## Layouts and figures

Switch to **Layout** (top bar) to arrange figures. On the left are the **Folders** and, below
them, the picked folder's samples in that folder's order and with their names, each with its
populations: click a population to add its plot, or drag it to where you want it on the page. A plot taken from another sample stays on that
sample; one from the page's sample follows the page (and every sample in batch mode). In
Gating, **Add to layout** places the plot you are looking at.

- Drag items to move them, drag the corner to resize, arrow keys to nudge (Shift for bigger
  steps), Delete to remove. Shift- or Ctrl/⌘-click (on the page or in **On this page**), or drag a
  box on an empty part of the page, to select several items to move, nudge or delete together.
- Click a plot's axis title on the page to pick its channel; in batch this works on any copy,
  and the change applies to that plot in every copy.
- The sample order and names can be edited in the Layout sidebar too, as in the Samples pane,
  and ✎ beside a gate there renames it.
- **Arrange**: **Free** (items go where you put them) or **Snap to grid**, with a number of
  columns and rows. In grid mode the plots fill square cells in order, below any title at the
  top of the page. Drop a new plot on a cell, or drag a plot to another cell, and the others
  move along; arrow keys move the selected plot one cell. Rows are added when the plots don't
  fit. Text floats over the page and never moves the grid; **Grid starts at** leaves room for a
  title.
- **Undo** and **Redo** (top bar, or Ctrl/⌘+Z and Ctrl/⌘+Shift+Z) work in Layout too.
- **Add name label** places a text item showing `{label}`, each sample's name from the Samples
  pane (or its file name if it has none); in batch every copy shows its own sample's name. Text
  items have font (sans-serif, serif or monospace), size, alignment, bold, italic and colour.
- **Double-click a plot** to edit its gates without leaving the layout: it opens below the
  page with the gating tools. Draw new gates (a name box opens), move and reshape gates,
  double-click a gate to rename it, Delete to remove it, and change the axes; the figure
  updates as you go. Esc or **Done** closes it.
- Per plot: sample, population, plot type (pseudocolor, dot, histogram), X and Y channels,
  **Dot size** and **Colour depth** sliders (the plot changes when you let go; **Same dot size &
  colour depth for every plot** copies them to the rest of the page), width and height, gates
  on or off.
- **Plot text** (its own card): the title, typed or picked from its ▾ list (population, sample
  name, file name, combinations, % of parent, count, or any of the sample's keywords such as
  donor or condition, each shown with what it gives for that plot), axis titles, and separate sizes for the title, axis titles, axis
  numbers, gate names and gate numbers. Each gate can show its name, count, % of parent and %
  of grandparent, with or without the % sign; turning the name off (Q1, say) keeps the numbers. **Set for all plots & keep for this session**
  puts the sizes and gate label choices on every plot in every layout, and new plots start with
  them for the rest of the session (it is saved with the work). Titles are left as they are.
- **Show gating strategy** (Page card) adds a line above the figure with each gate from All
  Events down to the plotted population and the channels it was drawn on, for example
  `Cells (FSC-A / SSC-A) → Singlets (FSC-A / FSC-H) → T cells (CD3 / CD19)`. It needs exactly
  one plot on the page (it is greyed out otherwise); in batch it is shown once, above all the
  copies. Its size (beside the checkbox), font, alignment, bold, italic and colour can be set.
- Text items and titles take fill-ins: `{sample}`, `{label}`, `{population}`, `{parent}`, `{count}`,
  `{freq}` (of parent), `{freqTotal}`, `{x}`, `{y}`, `{n}`, and any keyword of the sample in
  braces, such as `{$DATE}` or `{DONOR}` (including keywords added in other software and saved in the .wsp).
- **Batch** repeats the page for every sample of a folder (**Repeat for**: the non-control
  samples by default, all samples including controls, any folder of yours, or the compensation
  controls; it can be picked before Batch is turned on), in a grid: set the number of **Columns** and/or
  **Rows** (leave one empty to fit every sample) and the **Fill order** (across, then down; or
  down, then across). Each copy fills in its own sample's numbers and keywords. **Sample ID**
  shows the file name, or the sample's name, above each copy, with its own alignment, size,
  font, bold, italic and colour.
  Double-click a plot in any copy to edit its gates for that copy's sample (the plot being
  edited is outlined).
  - **All plots in the batch**: Dot size and Colour depth, and the same title, size and gate
    label settings as a single plot's, applied to every plot in every copy, with its own **Set
    for all plots & keep for this session**.
  - Click a plot in any copy to select it (Shift- or Ctrl/⌘-click, or drag a box, for several).
  - **Export → What**: **Entire batch** (the default) or **Selected plots**, which saves only
    the selected plots, each with its sample ID, cropped to fit. It switches to the selection by
    itself when two or more plots are selected. Each copy is only as big as
  the items on the page (plus a small margin), so a half-filled page gives compact copies.
- The cards on the right (Export, Page, the plot or text settings, Plot text, All plots in the
  batch) each fold away from their heading; the browser remembers which are folded. The column
  stays in view and scrolls on its own, so the page stays in sight while you reach a setting.
- Export (the first card on the right): **Download SVG** (vector axes, ticks, text, gates and histograms, editable in
  Illustrator, Inkscape or PowerPoint; density clouds embedded as images), **Download PNG**,
  **Copy as image**, **Copy plot as image** for one plot, and a preview image you can
  right-click to copy.
- Page sizes: Letter and A4 (portrait or landscape), 16:9 slide, or custom.
- Layouts are kept with shared workspaces and analysis bundles. They are not part of the .wsp
  file, which has no standard layout format.

## Your session is kept in this browser

FreeFlow saves your session in the browser's own storage every 15 seconds when something has
changed (and when you switch away from the tab): the FCS files, gates, compensation, axis
settings, folders and layouts. Reload the page or reopen it later in the same browser and it
picks up where you left off, with a note saying so. **New session** (top right, shown while
anything is open; click it twice to confirm) closes everything and forgets the saved copy, as
does **Start a new session** in that note. Your files are never changed; save a bundle first
to keep the work. The data stays on your computer, in this browser
only. Sample data and opened share links are not kept this way. For a copy you can move or
send, use an analysis bundle.

## Analysis bundles

**Save & share → Download bundle (.zip)** packs everything needed to continue an analysis
somewhere else: the original FCS files (byte for byte), a .wsp workspace with the gates, axis
settings and compensation, FreeFlow's layouts (`freeflow.json`) and a read-me. Whoever receives
it opens the .zip in FreeFlow with **Open FCS files** (or unzips it and uses **Open folder**), or
unzips it and opens the .wsp in other analysis software. FCS data is compressed where the browser supports it.

## Share links (bring your own storage)

**Save & share → Share a link** uploads the analysis bundle to storage *you* control and gives you
a link like `https://paraish.github.io/freeflow/#open=<address of the bundle>`. Whoever opens it
sees where the analysis is stored, and on **Open shared analysis** FreeFlow downloads the bundle
straight from your storage into their browser. FreeFlow itself stores nothing.

Built-in storage options (settings are kept only in your browser):

| Option | Free tier | Notes |
| --- | --- | --- |
| Supabase Storage | 1 GB, files up to 50 MB | Public bucket plus an upload policy; setup steps are in the app |
| S3-compatible: Cloudflare R2, Backblaze B2, Amazon S3, MinIO | R2 and B2: 10 GB | Public bucket with a CORS rule; requests are signed in the browser (AWS Signature V4) |
| Upload it yourself | — | Paste the address of a bundle on Dropbox, Zenodo or a lab server; Google Drive cannot work |

Anyone with a link can download the data, so share links only for data you may share, and
delete the file from your storage to withdraw a link. Creating links works on the public site
(the claude.ai version cannot contact outside services). The storage service has to allow
downloads from other sites (CORS); if it does not, FreeFlow says so and offers the file for
manual download.

**Adding a storage service** takes one module in `src/storage/` exporting
`{ id, label, summary, fields, help, upload(blob, filename, settings, onProgress) }`, where
`upload` returns the bundle's public address, then one line in `src/storage/index.js`.

## Workspaces (.wsp)

- **Save & share → Download .wsp only** writes a .wsp workspace (version 10 format) with every open sample's
  gates, axis settings, compensation matrix and keywords. On claude.ai the file is saved
  inside a .zip (the hosted page can only save certain file types); unzip it before opening it
  in other software. Opened from `dist/freeflow.html`, it saves the .wsp directly.
- **Open folder** opens a folder of FCS files. If it holds one .wsp, the workspace is applied
  and each of its samples is connected to an FCS file by file name (then by `$FIL`),
  checking event counts. A folder with no .wsp just opens its FCS files; one with more than
  one .wsp is refused with an explanation. Dropping a folder on the page does the same. **Open FCS files** also accepts a
  .wsp (or the saved .zip) picked together with FCS files.
- Imported from .wsp workspaces: rectangle, polygon, ellipse (converted to a polygon), range
  and quadrant gates; linear, log, biex, Logicle and ArcSinh axes;
  compensation matrices (any prefix); custom keywords; plot axes per population. Not yet
  imported (reported by name when skipped): Boolean gates, exclusion ("outside") gates,
  spectral unmixing matrices, derived parameters.
- Checked with [FlowKit](https://github.com/whitews/FlowKit), an independent open-source reader
  of .wsp workspaces: `npm run check:wsp` exports the example samples with every gate
  and axis type, has FlowKit gate the FCS files from the .wsp, and compares counts. All 33
  populations match exactly. (Needs Python with `pip install flowkit`.) Please report any
  .wsp file that opens differently in other software.

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

- **Phase 2**: sample groups, gates linked across a group.
- **Phase 3**: sample- and group-level annotations you type in, table editor with CSV/Excel
  export, histogram overlays in layouts.
- **Phase 4**: Boolean and exclusion gates, derived parameters, contour/zebra plots,
  dimensionality reduction.

## Accuracy notes

- The default fluorescence axis is the lookup-table biex transform used in .wsp workspaces;
  FreeFlow's port matches FlowKit's to within 10⁻⁶. The Logicle option is the published
  transform (Parks, Roederer & Moore, *Cytometry A* 2006; Moore & Parks 2012). Population
  frequencies from axis-aligned gates (rectangle, range, quadrant) do not depend on the axis
  transform at all.
- Polygon gates are evaluated in display space, so changing an axis transform after
  drawing a polygon changes which events it contains, as in other cytometry software.
- Off-scale events are drawn pinned to the plot edge and are counted by gates that touch
  that edge.

## Development

```sh
npm install
npm test        # unit tests: transforms, FCS, compensation, gating, .wsp, zip, sync
npm run check:wsp      # .wsp round trip through FlowKit (needs Python + flowkit)
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
| `src/biex.js` | Biex transform |
| `src/compcalc.js` | Compensation from single-stain controls |
| `src/model.js` | Samples: channels, compensation, gating context |
| `src/wsp.js` | .wsp workspace export and import |
| `src/zip.js` | Zip reading and writing |
| `src/share.js` | Live shared workspaces |
| `src/links.js` | Share links |
| `src/storage/` | Storage options for share links |
| `src/figure.js` | Figures as SVG |
| `src/layout.js` | Layout editor |
| `src/app.js` | Interface and state |

## How to cite

If FreeFlow contributed to your work, please cite it:

> Misra, Paraish S. (2026). FreeFlow: a free, open-source tool for flow cytometry analysis
> and figure generation (Version 0.1.0) [Computer software]. https://doi.org/10.5281/zenodo.23650055

In author-initial styles: Misra PS (Vancouver) or Misra, P. S. (APA).

GitHub's **Cite this repository** button (from `CITATION.cff`) gives APA and BibTeX.

Developed by Paraish S. Misra with AI-assisted programming (Claude, Anthropic).

## License

FreeFlow is free software under the GNU Affero General Public License v3 (`LICENSE`), with an
additional term under section 7(b): copies and modified versions must keep the author
attribution and the "How to cite" notice in the app's footer. See `NOTICE`, which also credits
FlowKit (BSD 3-Clause) and cytolib (AGPL-3.0), the sources of the biex transform.

For research use only, not for diagnostic procedures. Provided as is, without warranty.
FreeFlow is not affiliated with or endorsed by BD Biosciences or FlowJo.
