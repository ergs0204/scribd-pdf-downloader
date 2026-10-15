# Regression tests

Run the offline tests with Node.js:

```sh
node --test tests/*.test.cjs
```

`audit-regressions.test.cjs` covers session progress restoration after worker
restarts, serialized/retryable offscreen creation, sticky popup preparation
errors, and PDF blob cleanup on failed and successful saves. Other focused
regressions cover geometry-backed decoder precedence, CSS-painted page
rejection, and reuse of repeated character-width font subsets. These tests use
isolated synthetic browser-API/DOM fixtures and do not request user documents.

## Opt-in real-document export

This harness runs the actual `prepareJob -> runJob -> makePdf` path in Chrome,
with six workers. Only networking and the browser Save dialog are replaced by
a loopback server. It is not a substitute for testing extension installation,
popup UI, or offscreen service-worker lifecycle.

It requires Python with `requests`, network access to Scribd, and an accessible
normal preview of document `507619928`. It does not execute Scribd's scripts or
retain source responses/tokens on disk. Do not commit downloaded document data.

```sh
python tests/browser-export-server.py
```

Open `http://127.0.0.1:8766/document/507619928/B-tree-dbms` in Chrome.
Completion must show 22 pages, `containsFontFamilyRules: true`, and
`decodedTextPages: 22`. Two pages contain unresolved symbol-font fragments;
their visual appearance is retained while the unresolved symbols are omitted
from copying. This must not remove the readable body text on those pages.
The PDF is saved to the ignored `tmp/font-regression/full-export.pdf`.

Repeat with `?cold=1&zoom=1` to omit the live font link and reproduce the live
preview's zoom. The resulting PDF's SHA-256 must match the normal export.
Stop the server after testing; it binds only to loopback.

For other public document URLs, pass `--url` and optionally `--port`:

```sh
python tests/browser-export-server.py --url https://www.scribd.com/document/492478137/tkanki-zwierz%C4%99ce --port 8767
```

Open the same document path on `http://127.0.0.1:8767`. Add
`?page=4` to check only page 4 of this older scrambled-font document. Its visible
export must include all 92 source text fragments and the lower paragraphs;
the local signature fallback must add readable Polish text to the copy layer.
The page's `data-fragment-count` records the actual extracted fragment count.
Results for other documents are saved under ignored `tmp/regression-<id>/`.
Without `page`, every manifest page is exported. `expectedTextPages` overrides
the copy-layer page-count assertion; it does not change the PDF or decoder.

Check actual copied Unicode with Python and `pypdf`:

```sh
python tests/verify-copy-layer.py
```

This checks all pages have text, decoded headings/body sentences, numeric
sequences, and absence of the encoded source headings. With an existing
appearance-only PDF, add `--visual-reference /path/to/reference.pdf` to require
every page's JPEG stream to remain byte-identical. Do not commit these PDFs.

The export runner also writes ignored `selection-geometry.json` with source
character ranges. With `pypdfium2` installed, compare the actual PDFium
(Chromium PDF engine) selection rectangles against all source character boxes:

```sh
python tests/verify-selection-geometry.py
```

An optional `--overlay tmp/font-regression/selection-overlay.png` writes a
visual selection overlay for page 1 (requires Pillow). Positions and widths
must agree within 0.02 pt; quantized outline widths must agree within 0.1 pt,
and PDFium outline rounding is allowed less than 1 pt of ascent difference.
No OCR is used.

Older PDF.js 3 viewers have different space-inference rules than PDF.js 6.
With a CommonJS PDF.js build installed outside the extension, verify its
copy output (the old aligned PDF fails this test with `Pre pare d b y`):

```sh
node tests/verify-pdfjs-copy.cjs tmp/font-regression/full-export.pdf /path/to/pdfjs-dist/build/pdf.js
```

For fast PDF-writer iterations, the saved geometry and an existing PDF can
be replayed without network access. Only its original JPEG streams are reused:

```sh
node tests/rebuild-text-layer.cjs tmp/font-regression/aligned-normal.pdf tmp/font-regression/selection-geometry.json tmp/font-regression/full-export.pdf
```

After any writer fix, also rerun the live browser pipeline before release.

For visual inspection, render all pages with Poppler:

```sh
pdftoppm -scale-to 1000 -png tmp/font-regression/full-export.pdf tmp/font-regression/page
python tests/contact-sheet.py
```

The optional contact sheet step requires Pillow. Inspect every sheet; successful
completion alone cannot detect wrong font glyphs or layout problems.

## Older shuffled-font fallback

`outline-decoder.test.cjs` uses synthetic vector contours, not Scribd page data or
copyrighted font files. It covers normalization, shuffled glyph IDs with multiple
keys, bounds checks, insufficient/contradictory evidence, and malformed profiles.

With the affected document's font CSS saved locally outside Git, run:

```sh
node tests/verify-older-font-copy.cjs /path/to/local-font.css
```

This opt-in check exercises the real decoder against `492478137`'s supplied fonts
and asserts readable Polish headings, diacritics, body phrases, and punctuation.
Do not commit the source CSS/font fixture. For a new export of that document,
the browser runner expects 10 decoded text pages for a full export. The one
unresolved arrow glyph can remain visual-only.

Regenerate compact reference signatures from legally available local fonts with
`python scripts/generate-glyph-fingerprints.py --font-dir /path/to/fonts` (requires
fontTools at development time only). The generated JavaScript contains numeric
occupancy signatures and aspect ratios, not font files or drawable outlines.
