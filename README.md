<div align="center">

<img src="assets/logo-512.png" alt="Scribd Preview to PDF logo" width="128">

# Scribd Preview to PDF

**One-click PDF export for Scribd pages you can already access.**

[![Release](https://img.shields.io/github/v/release/ergs0204/scribd-pdf-downloader?display_name=tag&sort=semver)](../../releases/latest)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)](#installation)
[![Edge Compatible](https://img.shields.io/badge/Edge-Compatible-0078D7?logo=microsoftedge&logoColor=white)](#installation)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy_Me_a_Coffee-Support-FFDD00?logo=buymeacoffee&logoColor=000)](https://buymeacoffee.com/ergs02046)

No scrolling. No copied tokens. No OCR service. Open a document, click the extension, and follow the live progress.

[Download the latest release](../../releases/latest) · [Report a bug](../../issues/new)

</div>

> [!IMPORTANT]
> This is a personal-use tool. It is not affiliated with, endorsed by, or supported by Scribd. Use it only for documents you are authorized to access and save, and respect copyright law and Scribd's terms.

## Features

- **One-click export** - Start from the extension popup.
- **Official Scribd pages** - Supports both `/document/...` and legacy `/doc/...` URLs.
- **Embedded previews** - Detects Scribd previews inside other websites, including [scribdvdownloader.com](https://scribdvdownloader.com/).
- **No manual scrolling** - Reads Scribd's complete built-in page manifest directly.
- **Background rendering** - A hidden extension document keeps working after the popup closes.
- **Global progress** - Reopen the popup at any time to see rendered pages, selectable-text pages, failures, assembly, and save status.
- **Concurrent downloads** - Six workers fetch pages with bounded retries.
- **Sprite reconstruction** - Reassembles Scribd's clipped page-image sprites at their correct positions.
- **Selectable text when available** - Preserves Scribd's own Unicode text layer without external OCR.
- **Exact page order and dimensions** - Uses the source manifest rather than guessing from scroll position.
- **Local processing** - Page reconstruction and PDF assembly happen in your browser.

## Requirements

- Google Chrome or Microsoft Edge with Manifest V3 extension support
- A Scribd document or preview that is accessible in your current browser session
- Enough memory for the final PDF; very large image-heavy books can require substantial RAM

## Installation

### Recommended: GitHub Release

1. Open [Releases](../../releases/latest).
2. Download `scribd-preview-to-pdf-extension-v1.4.0.zip`.
3. Extract the ZIP to a permanent folder. Do not load the ZIP itself.
4. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
5. Enable **Developer mode**.
6. Click **Load unpacked** and select the extracted `scribd-preview-to-pdf` folder.
7. Pin **Scribd Preview to PDF** to the browser toolbar.

### From source

```bash
git clone https://github.com/ergs0204/scribd-pdf-downloader.git
```

Then load the cloned folder as an unpacked extension. No build step or package installation is required.

## Usage

1. Open one of these:
   - `https://www.scribd.com/document/<id>/<title>`
   - `https://www.scribd.com/doc/<id>/<title>`
   - [scribdvdownloader.com](https://scribdvdownloader.com/) after it opens the document preview
   - Any other website containing a Scribd preview frame
2. Wait until the document page or preview is visible.
3. Click the extension icon.
4. Click **Download all pages as PDF**.
5. Close or reopen the popup whenever you like. Rendering continues in the hidden extension document.
6. When assembly finishes, choose where to save the PDF.

No page-by-page scrolling is required.

## What the progress states mean

| State | Meaning |
| --- | --- |
| Finding | Detecting an official Scribd document or embedded preview |
| Preparing | Reading the page manifest and requesting a fresh token through the current Scribd session |
| Rendering | Fetching and reconstructing pages with six concurrent workers |
| Assembling | Building the ordered PDF and Unicode text map |
| Saving | Opening the browser's normal Save dialog |
| Complete | The download has started |

The popup also reports how many pages contain Scribd-provided selectable text.

## How it works

1. **Document detection** - Finds an official Scribd `/doc/` or `/document/` page, or an `/embeds/.../content` frame.
2. **Manifest parsing** - Reads each `docManager.addPage(...)` entry. This exposes every authorized page without scrolling.
3. **Session token refresh** - Uses Scribd's CSRF and document-token endpoints in your existing browser session.
4. **Concurrent page loading** - Fetches JSONP page descriptions and their authorized assets with retries.
5. **Page reconstruction** - Draws each clipped image sprite into its correct page coordinates.
6. **Built-in text preservation** - Reads Scribd's positioned `text_layer` when present and writes an invisible Unicode mapping into the PDF for selection and copying.
7. **Local PDF assembly** - Creates the final PDF in a hidden extension document and hands it to the browser download manager.

The extension does not create a headless Scribd session, scrape your cookies, upload documents to another service, or run OCR.

## Text and image behavior

Scribd documents are not all stored the same way:

| Scribd page data | PDF result |
| --- | --- |
| Scanned image or image sprites only | Visually reconstructed image page; text is not selectable |
| Image plus Scribd text layer | Reconstructed image with selectable built-in text overlay |
| Scribd text/vector layer | Text rendered visually with a selectable Unicode layer |

If Scribd does not provide text for a scanned page, this extension does not invent it. Use a separate OCR tool afterward if you personally need searchable scans.

## Permissions and privacy

| Permission | Why it is needed |
| --- | --- |
| `www.scribd.com` | Detect the document, read the authorized manifest, and refresh the page token |
| `html.scribdassets.com` | Fetch authorized page descriptions, images, and fonts |
| Downloads | Save the completed PDF |
| Tabs / webNavigation / scripting | Find official pages and cross-origin embedded previews |
| Offscreen | Keep rendering after the popup closes without opening a separate progress tab |
| Storage | Keep global progress available when the popup is reopened |

No analytics, advertising SDK, external API, or telemetry is included.

## Limitations

- Only pages authorized by Scribd for the active browser session can be requested.
- Signed asset tokens expire; start each export from a live document page.
- Very large documents are assembled in browser memory and may exceed available RAM.
- Scribd's custom fonts and unusual vertical or mathematical layouts may render differently from the source.
- Selectable text quality depends entirely on Scribd's built-in text order and Unicode data.
- Site changes can break manifest or token parsing; open an issue with non-sensitive reproduction details if that happens.

## Troubleshooting

### "No supported Scribd document was detected"

- Confirm the URL starts with `https://www.scribd.com/doc/` or `https://www.scribd.com/document/`.
- On [scribdvdownloader.com](https://scribdvdownloader.com/) or another third-party site, wait until the embedded Scribd preview appears.
- Reload the page after installing or updating the extension.
- Confirm the installed extension version matches the latest release.

### The popup closes

That is fine. Rendering continues in the hidden extension document. Click the extension icon again to restore the current global progress.

### A page fails repeatedly

- Keep the Scribd tab open.
- Confirm the document is still accessible in the current session.
- Reload the page and begin a new export so the extension receives a fresh signed token.

### Text cannot be selected

That page is probably image-only. Selectable text is added only when Scribd supplies a built-in `text_layer`; this project intentionally does not run OCR.

## Development

The extension is plain Manifest V3 JavaScript with no build system and no runtime dependencies.

```text
scribd-preview-to-pdf/
├── manifest.json       Extension metadata and permissions
├── popup.*             Start button and persistent global progress
├── content.js          Official-page/embed manifest and token reader
├── background.js       Job state, offscreen renderer, and downloads
├── builder.*           Page reconstruction and PDF/text-layer writer
└── README.md
```

After editing, reload the unpacked extension from `chrome://extensions` and test both an official document URL and an embedded preview.

## Contributing

This started as a small personal utility, so rough edges are expected. Focused bug reports and small pull requests are welcome. Never include Scribd cookies, CSRF tokens, signed asset URLs, or copyrighted page data in an issue.

## Support

If this quick personal tool saves you time, you can [buy me a coffee](https://buymeacoffee.com/ergs02046). Support is appreciated but never required.

## License

Released under the [MIT License](LICENSE).

## Disclaimer

This software is provided for personal and educational use. It is a convenience tool for exporting material that Scribd already makes available to your current browser session. It does not grant access to restricted pages, remove DRM, or confer permission to reproduce or distribute documents. You are solely responsible for using it lawfully and respecting authors, publishers, copyright, and platform terms.

---

<div align="center">

Built with Codex, tested against official and embedded Scribd page manifests, and shared as-is for personal use.

</div>
