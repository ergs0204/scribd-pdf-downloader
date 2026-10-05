# Regression tests

Run the offline tests with Node.js:

```sh
node --test tests/*.test.cjs
```

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
