"""Generate numeric vector signatures from local reference fonts, not font files.

Uses fontTools only at development time. Runtime has no OCR/network dependency.
Font outlines are sampled by winding number on a 16x24 grid; profiles store only
occupancy bits and a rounded aspect ratio, never drawable outlines or hinting.
"""
import argparse
import base64
import json
import unicodedata
from pathlib import Path
from fontTools.ttLib import TTFont, TTCollection
from fontTools.pens.basePen import BasePen

FONT_NAMES = ['times.ttf', 'timesbd.ttf', 'timesi.ttf', 'timesbi.ttf', 'arial.ttf', 'arialbd.ttf',
    'ariali.ttf', 'arialbi.ttf', 'verdana.ttf', 'verdanab.ttf', 'verdanai.ttf',
    'verdanaz.ttf', 'georgia.ttf', 'georgiab.ttf', 'georgiai.ttf', 'georgiaz.ttf',
    'cambria.ttc', 'calibri.ttf', 'calibrib.ttf', 'constan.ttf', 'constanb.ttf',
    'bookos.ttf', 'bookosb.ttf', 'GARA.TTF', 'GARABD.TTF', 'CENTURY.TTF',
    'SCHLBK.TTF', 'SCHLBKB.TTF', 'comic.ttf', 'comicbd.ttf', 'comici.ttf',
    'comicz.ttf', 'cour.ttf', 'courbd.ttf', 'couri.ttf', 'courbi.ttf',
    'calibrii.ttf', 'calibriz.ttf', 'cambriab.ttf', 'cambriai.ttf', 'cambriaz.ttf',
    'segoeui.ttf', 'sylfaen.ttf', 'ebrima.ttf', 'LeelawUI.ttf', 'Nirmala.ttc',
    'msjh.ttc', 'msyh.ttc', 'msgothic.ttc', 'malgun.ttf', 'mingliub.ttc']

class FlatPen(BasePen):
    def __init__(self, glyphset):
        super().__init__(glyphset)
        self.contours = []
        self.current = []
    def _moveTo(self, point): self.current = [point]
    def _lineTo(self, point): self.current.append(point)
    def _qCurveToOne(self, control, end):
        start = self.current[-1]
        for i in range(1, 13):
            t = i / 12
            u = 1 - t
            self.current.append((u*u*start[0]+2*u*t*control[0]+t*t*end[0],
                                 u*u*start[1]+2*u*t*control[1]+t*t*end[1]))
    def _curveToOne(self, first, second, end):
        start = self.current[-1]
        for i in range(1, 13):
            t = i / 12
            u = 1 - t
            self.current.append(tuple(u*u*u*start[j] + 3*u*u*t*first[j]
                                      + 3*u*t*t*second[j] + t*t*t*end[j] for j in (0, 1)))
    def _closePath(self):
        self.contours.append(self.current)
        self.current = []
    def _endPath(self): self._closePath()

def signature(font, glyph, glyphset=None):
    if glyphset is None:
        glyphset = font.getGlyphSet()
    pen = FlatPen(glyphset)
    glyphset[glyph].draw(pen)
    points = [p for contour in pen.contours for p in contour]
    if not points: return None
    xmin, xmax = min(x for x, _ in points), max(x for x, _ in points)
    ymin, ymax = min(y for _, y in points), max(y for _, y in points)
    dx, dy = xmax-xmin, ymax-ymin
    if dx <= 0 or dy <= 0: return None
    contours = [[((x-xmin)/dx, (y-ymin)/dy) for x,y in contour] for contour in pen.contours]
    rows = []
    for row in range(24):
        y = (row+.5)/24
        crossings = []
        for contour in contours:
            for p,q in zip(contour, contour[1:]+contour[:1]):
                if p[1] <= y < q[1] or q[1] <= y < p[1]:
                    crossings.append((p[0]+(y-p[1])*(q[0]-p[0])/(q[1]-p[1]), 1 if q[1]>p[1] else -1))
        crossings.sort()
        cursor = winding = bits = 0
        for col in range(16):
            while cursor < len(crossings) and crossings[cursor][0] <= (col+.5)/16:
                winding += crossings[cursor][1]
                cursor += 1
            if winding:
                bits |= 1 << col
        rows.append(bits)
    packed = b''.join(row.to_bytes(2, 'little') for row in rows)
    return round(dx/dy*1000), base64.b64encode(packed).decode('ascii')

def printable(code):
    return 0 <= code <= 0x10ffff and unicodedata.category(chr(code))[0] not in {'C', 'Z'}

def coverage_report(entries, faces):
    codes = sorted(map(int, entries))
    ranges = []
    for code in codes:
        if ranges and code == ranges[-1][1] + 1:
            ranges[-1][1] = code
        else:
            ranges.append([code, code])
    blocks = {
        'Latin': [(0x21,0x24f),(0x1e00,0x1eff)], 'Greek': [(0x370,0x3ff),(0x1f00,0x1fff)],
        'Cyrillic': [(0x400,0x52f)], 'Armenian': [(0x530,0x58f)], 'Hebrew': [(0x590,0x5ff)],
        'Arabic': [(0x600,0x6ff),(0x750,0x77f),(0x8a0,0x8ff),(0xfb50,0xfdff),(0xfe70,0xfeff)],
        'Devanagari': [(0x900,0x97f)], 'Bengali': [(0x980,0x9ff)], 'Gurmukhi': [(0xa00,0xa7f)],
        'Gujarati': [(0xa80,0xaff)], 'Oriya': [(0xb00,0xb7f)], 'Tamil': [(0xb80,0xbff)],
        'Telugu': [(0xc00,0xc7f)], 'Kannada': [(0xc80,0xcff)], 'Malayalam': [(0xd00,0xd7f)],
        'Sinhala': [(0xd80,0xdff)], 'Thai': [(0xe00,0xe7f)], 'Lao': [(0xe80,0xeff)],
        'Tibetan': [(0xf00,0xfff)], 'Myanmar': [(0x1000,0x109f),(0xa9e0,0xa9ff),(0xaa60,0xaa7f)],
        'Georgian': [(0x10a0,0x10ff),(0x1c90,0x1cbf),(0x2d00,0x2d2f)],
        'Ethiopic': [(0x1200,0x139f)], 'Cherokee': [(0x13a0,0x13ff),(0xab70,0xabbf)],
        'Khmer': [(0x1780,0x17ff)], 'Mongolian': [(0x1800,0x18af)],
        'Japanese kana': [(0x3040,0x30ff),(0x31f0,0x31ff)],
        'CJK ideographs': [(0x3400,0x4dbf),(0x4e00,0x9fff),(0xf900,0xfaff),(0x20000,0x323af)],
        'Bopomofo': [(0x3100,0x312f),(0x31a0,0x31bf)],
        'Korean Hangul': [(0x1100,0x11ff),(0x3130,0x318f),(0xac00,0xd7af)],
        'Mathematics': [(0x2100,0x22ff),(0x27c0,0x27ef),(0x2980,0x2aff),(0x1d400,0x1d7ff)]}
    return {'description': 'Reference glyph coverage, not a guarantee of language or font decoding.',
            'characters': len(codes), 'profiles': sum(map(len, entries.values())), 'fontFaces': faces,
            'scriptBlockCharacterCounts': {name: sum(any(lo <= code <= hi for lo,hi in spans) for code in codes)
                                          for name,spans in blocks.items()}, 'unicodeRanges': ranges}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--font-dir', default='C:/Windows/Fonts')
    parser.add_argument('--output', default='glyph-fingerprints.js')
    parser.add_argument('--font', action='append', help='Additional local font file; repeat for multiple files')
    parser.add_argument('--all-local-fonts', action='store_true', help='Scan every TTF/TTC/OTF/OTC in --font-dir (can be slow and produce a large database)')
    parser.add_argument('--coverage-output', default='assets/reference-coverage.json')
    parser.add_argument('--coverage-only', action='store_true', help='Rebuild metadata from --output without rasterizing; use the original font options')
    args = parser.parse_args()
    entries = {}
    if args.coverage_only:
        entries = json.loads(Path(args.output).read_text(encoding='utf8').split('=',1)[1].strip().removesuffix(';'))
    faces = []
    paths = list(dict.fromkeys([Path(args.font_dir)/name for name in FONT_NAMES] + [Path(p) for p in args.font or []]))
    if args.all_local_fonts:
        paths = list(dict.fromkeys(paths + sorted(path for path in Path(args.font_dir).iterdir()
                                                if path.suffix.lower() in {'.ttf','.ttc','.otf','.otc'})))
    for path in paths:
        if not path.exists(): continue
        count = 1
        if path.suffix.lower() in {'.ttc','.otc'}:
            collection = TTCollection(path, lazy=True)
            count = len(collection.fonts)
            collection.close()
        caches = {}
        for face in range(count):
            if args.coverage_only:
                faces.append(f'{path.name}#{face}')
                continue
            font = TTFont(path, fontNumber=face, lazy=True)
            try:
                glyphset = font.getGlyphSet()
                # Collection faces often share exactly the same outline tables.
                table_key = tuple((tag,font.reader.tables[tag].offset) for tag in ('glyf','loca','CFF ','CFF2') if tag in font)
                cache = caches.setdefault(table_key, {})
                for code,glyph in (font.getBestCmap() or {}).items():
                    if not printable(code): continue
                    glyph_id = font.getGlyphID(glyph)
                    if glyph_id not in cache:
                        cache[glyph_id] = signature(font, glyph, glyphset)
                    result = cache[glyph_id]
                    if result: entries.setdefault(code, set()).add(result)
                faces.append(f'{path.name}#{face}')
            finally:
                font.close()
        print(f'Read {path.name} ({count} faces); {len(entries)} characters covered', flush=True)
    data = {str(code): sorted(profiles) for code,profiles in sorted(entries.items())}
    prefix = '// Numeric glyph signatures only; generated with scripts/generate-glyph-fingerprints.py.\n'
    if not args.coverage_only:
        Path(args.output).write_text(prefix + 'globalThis.SPDF_GLYPH_FINGERPRINTS=' + json.dumps(data,separators=(',',':')) + ';\n', encoding='utf8')
    Path(args.coverage_output).write_text(json.dumps(coverage_report(data, faces), ensure_ascii=False, indent=2)+'\n', encoding='utf8')
    print(f'{len(data)} characters, {sum(map(len,data.values()))} distinct signatures')

if __name__ == '__main__': main()
