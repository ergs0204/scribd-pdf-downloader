"""Generate numeric vector signatures from local reference fonts, not font files.

Uses fontTools only at development time. Runtime has no OCR/network dependency.
Font outlines are sampled by winding number on a 16x24 grid; profiles store only
occupancy bits and a rounded aspect ratio, never drawable outlines or hinting.
"""
import argparse
import base64
import json
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.basePen import BasePen

FONT_NAMES = ['times.ttf', 'timesi.ttf', 'timesbi.ttf', 'arial.ttf', 'arialbd.ttf',
    'ariali.ttf', 'arialbi.ttf', 'verdana.ttf', 'verdanab.ttf', 'verdanai.ttf',
    'verdanaz.ttf', 'georgia.ttf', 'georgiab.ttf', 'georgiai.ttf', 'georgiaz.ttf',
    'cambria.ttc', 'calibri.ttf', 'calibrib.ttf', 'constan.ttf', 'constanb.ttf',
    'bookos.ttf', 'bookosb.ttf', 'GARA.TTF', 'GARABD.TTF', 'CENTURY.TTF',
    'SCHLBK.TTF', 'SCHLBKB.TTF']

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
    def _curveToOne(self, *_): raise ValueError('Only TrueType reference fonts supported')
    def _closePath(self):
        self.contours.append(self.current)
        self.current = []
    def _endPath(self): self._closePath()

def signature(font, glyph):
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
        rows.append(sum(1 << col for col in range(16)
                        if sum(sign for x,sign in crossings if x <= (col+.5)/16)))
    packed = b''.join(row.to_bytes(2, 'little') for row in rows)
    return round(dx/dy*1000), base64.b64encode(packed).decode('ascii')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--font-dir', default='C:/Windows/Fonts')
    parser.add_argument('--output', default='glyph-fingerprints.js')
    args = parser.parse_args()
    entries = {}
    for name in FONT_NAMES:
        path = Path(args.font_dir) / name
        if not path.exists(): continue
        font = TTFont(path, fontNumber=0)
        for code,glyph in font.getBestCmap().items():
            if not (0x21 <= code <= 0x17f or 0x2010 <= code <= 0x206f or code == 0x27a5): continue
            result = signature(font, glyph)
            if result: entries.setdefault(code, set()).add(result)
        font.close()
    data = {str(code): sorted(profiles) for code,profiles in sorted(entries.items())}
    prefix = '// Numeric glyph signatures only; generated with scripts/generate-glyph-fingerprints.py.\n'
    Path(args.output).write_text(prefix + 'globalThis.SPDF_GLYPH_FINGERPRINTS=' + json.dumps(data,separators=(',',':')) + ';\n', encoding='utf8')
    print(f'{len(data)} characters, {sum(map(len,data.values()))} distinct signatures')

if __name__ == '__main__': main()
