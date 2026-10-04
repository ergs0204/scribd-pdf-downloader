"""Opt-in visual QA for PNGs rendered by pdftoppm; writes only ignored tmp files."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / "tmp" / "font-regression"
pages = sorted(root.glob("page-*.png"))
for start in range(0, len(pages), 6):
    sheet = Image.new("RGB", (2000, 1800), "#ddd")
    draw = ImageDraw.Draw(sheet)
    for index, path in enumerate(pages[start:start + 6]):
        x, y = (index % 2) * 1000, (index // 2) * 600
        draw.text((x + 10, y + 5), path.stem, fill="black")
        with Image.open(path) as page:
            sheet.paste(page, (x, y + 25))
    sheet.save(root / f"sheet-{start // 6 + 1}.png")
