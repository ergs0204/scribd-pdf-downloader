"""Opt-in check for the real browser-export output; requires pypdf."""
import argparse
from pathlib import Path
from pypdf import PdfReader

parser = argparse.ArgumentParser()
parser.add_argument("--pdf", default="tmp/font-regression/full-export.pdf")
parser.add_argument("--visual-reference", help="Optional pre-text-layer PDF for JPEG equality")
args = parser.parse_args()
reader = PdfReader(args.pdf)
assert len(reader.pages) == 22, "Incomplete document"
texts = [page.extract_text() for page in reader.pages]
assert all(text.strip() for text in texts), "A page lost its preview text"
assert "Prepared by" in texts[1], "Viewer-style spacing broke the author heading"
assert "Hamid ali Dana" in texts[1]
assert "From Gilgit Baltistan" in texts[1]
assert "B+ Trees" in texts[0], "Heading did not decode correctly"
assert "What is b+ tree" in texts[2], "Page 3 did not decode correctly"
assert "A B+ tree is a data structure" in texts[2], "Body text did not decode correctly"
assert "C+ [rnns" not in texts[0], "Encoded source leaked into copy layer"
assert "_jet ls c+ trnn" not in texts[2], "Encoded source leaked into copy layer"
assert "Data records are only stored in the leaves." in texts[3]
for index in range(6, 13):
    assert "==2,4,7,10,17,21,28" in texts[index], f"Page {index + 1} numeric sequence corrupted"
assert "Deletion Process:" in texts[13]
assert "Thank you" in texts[21]
if args.visual_reference:
    reference = PdfReader(args.visual_reference)
    assert len(reference.pages) == len(reader.pages)
    for index, (page, old) in enumerate(zip(reader.pages, reference.pages), 1):
        assert page["/Resources"]["/XObject"]["/Im0"].get_data() == old["/Resources"]["/XObject"]["/Im0"].get_data(), f"Page {index} appearance changed"
print("PASS: 22/22 pages have extractable text; English headings and body text decode correctly")
if args.visual_reference:
    print("PASS: all 22 rendered page images are byte-identical to the visual reference")
