# Changelog

All notable changes to this project are documented here.

## 1.4.4 - 2026-10-05

- Fixed copied gibberish from supported Scribd scrambled subset fonts: supplied font cmap/glyph-order metadata now recovers a unique document-specific ASCII permutation. No OCR, external recognition service, or hardcoded document key.
- Kept original encoded strings for visual rendering and wrote decoded Unicode into the separate invisible PDF copy layer.
- Fixed selection bounds using measured per-character preview ranges and a tiny embedded geometry-only font for the invisible layer, preventing viewer fallback fonts from expanding or shifting highlights. Visible Scribd fonts/images are unchanged.
- Fixed extra spaces such as `Pre pare d b y` in older PDF.js viewers. Character widths now use font advance metrics at a stable em scale; incompatible widths use separate reusable subsets, and collapsed spaces retain sensible nominal metrics. Verified with PDF.js 3 and 6, PDFium, and pypdf.
- Added bounded SFNT cmap format 4/12 parsing; ambiguous, conflicting, unsupported, and private-use mappings fail closed instead of yielding guessed text.
- Added popup counts for decoded pages and warnings for unresolved custom-font fragments.
- Verified readable headings, paragraphs, and numeric sequences in the complete 22-page `507619928/B-tree-dbms` export. All rendered image streams are unchanged; normal and cold/zoomed PDFs match exactly. Unresolved symbol glyphs remain visual-only.
- Added decoder/parser regressions and an opt-in real-PDF text/appearance verification command.

## 1.4.3 - 2026-10-04

- Fixed the remaining visible gibberish in documents such as `507619928/B-tree-dbms`: the export job now carries the font-family rules that Scribd generates from `docManager.addFont(...)`, not just the font files.
- Discovers the document font stylesheet from built-in metadata even before the live preview loads it. No OCR or external font substitution.
- Removes live-preview zoom from export coordinates and preserves source font sizes, letter spacing, and word spacing.
- Cleans up offscreen layout nodes even when font loading fails.
- Verified the complete 22-page document through the real preparation/render/PDF pipeline with six workers. Cold-start/zoomed and normal exports are byte-identical; all pages were visually inspected.
- Added preparation-path regression tests and an opt-in browser integration runner, alongside the existing queue and timeout tests.

## 1.4.2 - 2026-10-04

- Fixed garbled or missing English on previews that use Scribd's document-specific embedded fonts.
- Added explicit font loading before page rasterization and switched font-bearing pages to a DOM canvas that shares the loaded browser font set.
- Avoided exposing Scribd's font-encoded glyph strings as incorrect selectable Unicode when the source does not provide a real Unicode mapping.
- Added regression coverage for stylesheet discovery, relative font URLs, font readiness, DOM-canvas selection, and encoded text layers.

## 1.4.1 - 2026-09-28

- Fixed downloads that could remain stuck at `Rendering 0 / N pages` when a Scribd asset response stalled.
- Added the official same-origin embedded-preview flow as a fallback for Scribd document pages.
- Reused page DOM already rendered by Scribd to avoid unnecessary page-data requests.
- Added bounded page/image downloads, image-decode timeouts, and regression coverage for stalled assets.
- Kept the Download button locked with immediate preparation feedback, preventing repeat clicks while the page list and token are loading.
- Added a deduplicated FIFO document queue so different previews can be added during a download and rendered one at a time.

## 1.4.0 - 2026-09-28

- Added a custom violet-and-blue extension logo selected from six concepts.
- Added optimized transparent PNG icons at 16, 32, 48, and 128 pixels.
- Added the logo to the extension manifest, toolbar action, and README hero.

## 1.3.1 - 2026-09-28

- Documented and surfaced support for previews opened through `scribdvdownloader.com`.
- Clarified that embedded-preview support does not require additional access to the outer website.

## 1.3.0 - 2026-09-28

- Added official `scribd.com/doc/...` and `scribd.com/document/...` support.
- Replaced the separate visible progress tab with a hidden offscreen renderer.
- Added persistent global progress in the toolbar popup.
- Preserved Scribd-provided Unicode text layers in generated PDFs.
- Added automatic detection of embedded Scribd previews.
- Added concurrent page loading, retry handling, and clipped sprite reconstruction.

## 1.2.0 - 2026-09-28

- Added selectable Unicode text-layer support using Scribd's built-in text data.
- Added text/vector page rendering without OCR.

## 1.1.0 - 2026-09-28

- Added a toolbar download button and automatic iframe detection.
- Removed the need for manual scrolling.

## 1.0.0 - 2026-09-28

- Initial image-page reconstruction and PDF export.
