"""Opt-in PDFium geometry check against measured preview ranges. No OCR."""
import argparse
import json
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--pdf', default='tmp/font-regression/full-export.pdf')
parser.add_argument('--geometry', default='tmp/font-regression/selection-geometry.json')
parser.add_argument('--pdfium-path', help='Optional local pypdfium2 package directory')
parser.add_argument('--overlay', help='Optional PNG of page 1 with actual selection boxes')
args = parser.parse_args()
if args.pdfium_path:
    sys.path.insert(0, args.pdfium_path)
import pypdfium2 as pdfium

expected = json.loads(Path(args.geometry).read_text(encoding='utf-8'))
pdf = pdfium.PdfDocument(args.pdf)
assert len(pdf) == len(expected) == 22
checked = 0
maximum_error = 0
for page_index, source in enumerate(expected):
    page = pdf[page_index]
    textpage = page.get_textpage()
    actual = [(textpage.get_text_range(i, 1), textpage.get_charbox(i, loose=True))
              for i in range(textpage.count_chars())]
    cursor = 0
    for fragment in source['texts']:
        assert len(fragment['characterBoxes']) == len(fragment['text'])
        for character, box in zip(fragment['text'], fragment['characterBoxes']):
            if box['width'] <= 0 or box['height'] <= 0:
                continue
            # PDFium can generate whitespace between positioned fragments.
            while cursor < len(actual) and actual[cursor][0].isspace() and actual[cursor][0] != character:
                cursor += 1
            assert cursor < len(actual), f'Page {page_index + 1}: missing {character!r}'
            code, rectangle = actual[cursor]
            assert code == character, f'Page {page_index + 1}: expected {character!r}, got {code!r} at {cursor}'
            wanted = (box['x'] * .75, (source['height'] - box['y'] - box['height']) * .75,
                      (box['x'] + box['width']) * .75, (source['height'] - box['y']) * .75)
            error = max(abs(a - b) for a, b in zip(rectangle, wanted))
            maximum_error = max(maximum_error, error)
            # PDFium rounds the embedded outline's ascent at its internal
            # glyph resolution. Permit <1 pt vertically, not positional/width
            # drift or font-substitution-dependent line expansion.
            assert max(abs(rectangle[j] - wanted[j]) for j in (0, 1)) < .02, f'Page {page_index + 1}, {character!r}: position mismatch {rectangle} != {wanted}'
            # Per-glyph TrueType widths are quantized, then PDFium rounds
            # outline bounds again to 1/1000 em. Require subpixel agreement.
            assert abs(rectangle[2]-wanted[2]) < .1, f'Page {page_index + 1}, {character!r}: width mismatch {rectangle} != {wanted}'
            assert error < 1, f'Page {page_index + 1}, {character!r}: box mismatch {rectangle} != {wanted}'
            checked += 1
            cursor += 1
    textpage.close()
    page.close()
print(f'PASS: {checked} character selection boxes across 22 pages match preview ranges; max error {maximum_error:.4f} pt')
if args.overlay:
    from PIL import Image, ImageDraw
    page = pdf[0]
    image = page.render(scale=1.5).to_pil().convert('RGBA')
    overlay = Image.new('RGBA', image.size)
    draw = ImageDraw.Draw(overlay)
    textpage = page.get_textpage()
    height = page.get_height()
    for i in range(textpage.count_chars()):
        left, bottom, right, top = textpage.get_charbox(i, loose=True)
        draw.rectangle((left * 1.5, (height - top) * 1.5, right * 1.5, (height - bottom) * 1.5),
                       fill=(30, 120, 255, 65), outline=(30, 100, 255, 90))
    Image.alpha_composite(image, overlay).convert('RGB').save(args.overlay)
