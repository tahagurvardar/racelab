"""Generate exact D2-C optical masters. Requires Pillow; no resampling of small icons."""
from pathlib import Path
from io import BytesIO
import struct
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src-tauri" / "icons"
MASTERS = {
    16: [(1, 4), (14, 4), (14, 12), (8, 12), (8, 9), (1, 9)],
    20: [(2, 6), (18, 6), (18, 16), (11, 16), (11, 13), (2, 13)],
    24: [(2, 7), (21, 7), (21, 19), (12, 19), (12, 15), (2, 15)],
    32: [(3, 9), (27, 9), (27, 24), (16, 24), (16, 19), (3, 19)],
}
PATHS = {
    16: "M1 4H14V12H8V9H1Z",
    20: "M2 6H18V16H11V13H2Z",
    24: "M2 7H21V19H12V15H2Z",
    32: "M3 9H27V24H16V19H3Z",
}


def render(size):
    points = MASTERS.get(size)
    if points is None:
        points = [(round(x * size / 80), round(y * size / 80)) for x, y in
                  [(0, 15), (80, 15), (80, 65), (44, 65), (44, 49), (0, 49)]]
    image = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(image)
    # Pixel centers inside the polygon; raster edges match SVG half-open geometry.
    for y in range(size):
        crossings = []
        for index, (x1, y1) in enumerate(points):
            x2, y2 = points[(index + 1) % len(points)]
            if (y1 <= y + .5 < y2) or (y2 <= y + .5 < y1):
                crossings.append(x1 + (y + .5 - y1) * (x2 - x1) / (y2 - y1))
        crossings.sort()
        for left, right in zip(crossings[::2], crossings[1::2]):
            draw.rectangle((int(left), y, int(right) - 1, y), fill=(241, 244, 245, 255))
    return image


for size in MASTERS:
    (OUT / f"mark-{size}.svg").write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}" shape-rendering="crispEdges"><path fill="#F1F4F5" d="{PATHS[size]}"/></svg>\n', encoding="utf-8")
for name, size in [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256), ("icon.png", 256)]:
    render(size).save(OUT / name)
(OUT / "icon.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><path fill="#F1F4F5" d="M0 15H80V65H44V49H0Z"/></svg>\n', encoding="utf-8")
# Pack each independently generated frame. Pillow's ICO saving normally downsamples
# the largest frame; that would lose the locked 16px optical master.
frames = []
for size in [16, 20, 24, 32, 48, 64, 128, 256]:
    buffer = BytesIO()
    render(size).save(buffer, format="PNG")
    frames.append((size, buffer.getvalue()))
offset = 6 + 16 * len(frames)
entries = []
for size, data in frames:
    entries.append(struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset))
    offset += len(data)
(OUT / "icon.ico").write_bytes(struct.pack("<HHH", 0, 1, len(frames)) + b"".join(entries) + b"".join(data for _, data in frames))
public = ROOT / "public"
public.mkdir(exist_ok=True)
(public / "favicon.svg").write_bytes((OUT / "mark-16.svg").read_bytes())
