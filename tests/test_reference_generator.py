"""Offline generator checks; no local font files or document data required."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('reference_generator', Path(__file__).resolve().parents[1]/'scripts/generate-glyph-fingerprints.py')
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)

class ReferenceGeneratorTests(unittest.TestCase):
    def test_unicode_filter_does_not_limit_language_or_plane(self):
        for character in 'éЖאشकก中あ한𠀀':
            self.assertTrue(generator.printable(ord(character)))
        for code in (0, 0x20, 0xa0, 0xd800, 0xe000, 0xf0000, 0x110000):
            self.assertFalse(generator.printable(code))

    def test_supplied_glyphset_and_winding_rasterization(self):
        class Rectangle:
            def draw(self, pen):
                pen.moveTo((0,0));pen.lineTo((16,0));pen.lineTo((16,24));pen.lineTo((0,24));pen.closePath()
        aspect, packed = generator.signature(None, 'rectangle', {'rectangle': Rectangle()})
        self.assertEqual(aspect,667)
        self.assertEqual(generator.base64.b64decode(packed), b'\xff'*48)

    def test_coverage_reports_actual_missing_scripts_and_exact_ranges(self):
        report = generator.coverage_report({0x41:[1],0x42:[2],0x4e00:[3],0x20000:[4]},['fixture#0'])
        self.assertEqual(report['unicodeRanges'],[[0x41,0x42],[0x4e00,0x4e00],[0x20000,0x20000]])
        self.assertEqual(report['scriptBlockCharacterCounts']['CJK ideographs'],2)
        self.assertEqual(report['scriptBlockCharacterCounts']['Arabic'],0)
        self.assertEqual(generator.coverage_report({'65':[1],'66':[2]},[])['unicodeRanges'],[[65,66]])

if __name__=='__main__':
    unittest.main()
