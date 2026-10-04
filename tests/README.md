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
Completion must show 22 pages and `containsFontFamilyRules: true`.
The PDF is saved to the ignored `tmp/font-regression/full-export.pdf`.

Repeat with `?cold=1&zoom=1` to omit the live font link and reproduce the live
preview's zoom. The resulting PDF's SHA-256 must match the normal export.
Stop the server after testing; it binds only to loopback.

For visual inspection, render all pages with Poppler:

```sh
pdftoppm -scale-to 1000 -png tmp/font-regression/full-export.pdf tmp/font-regression/page
python tests/contact-sheet.py
```

The optional contact sheet step requires Pillow. Inspect every sheet; successful
completion alone cannot detect wrong font glyphs or layout problems.
