# Changelog

All notable changes to this project are documented here.

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
