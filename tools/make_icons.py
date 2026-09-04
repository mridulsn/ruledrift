# -*- coding: ascii -*-
"""Generate Ruledrift app icons. Pure PIL, no external art.

The mark is three tiles: two identical, one that has drifted - which is the
whole game in one glyph.
"""
import os
import math
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")
BG = (11, 14, 20, 255)
ACCENT = (77, 214, 193, 255)
ACCENT2 = (122, 162, 255, 255)
MUTED = (38, 45, 59, 255)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(4))


def rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def polygon_points(cx, cy, r, sides, rotation=0.0):
    pts = []
    for i in range(sides):
        a = rotation + (i / float(sides)) * 2 * math.pi - math.pi / 2
        pts.append((cx + math.cos(a) * r, cy + math.sin(a) * r))
    return pts


def draw_icon(size, maskable=False):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Background plate. Maskable icons need the art inside the safe circle,
    # so the whole composition shrinks rather than getting cropped by Android.
    if maskable:
        rounded(d, (0, 0, size, size), 0, BG)
        inset = size * 0.22
    else:
        rounded(d, (0, 0, size, size), int(size * 0.22), BG)
        inset = size * 0.16

    usable = size - inset * 2
    cell = usable / 3.0
    cy = size / 2.0
    r = cell * 0.34

    # Two settled tiles, then one that has drifted: different shape, different
    # colour, lifted out of line.
    for i in range(3):
        cx = inset + cell * (i + 0.5)
        if i < 2:
            d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=MUTED)
            d.ellipse((cx - r * 0.26, cy - r * 0.26, cx + r * 0.26, cy + r * 0.26), fill=BG)
        else:
            lift = cell * 0.20
            col = lerp(ACCENT, ACCENT2, 0.35)
            pts = polygon_points(cx, cy - lift, r * 1.18, 4, math.pi / 4)
            d.polygon(pts, fill=col)
            d.ellipse(
                (cx - r * 0.22, cy - lift - r * 0.22, cx + r * 0.22, cy - lift + r * 0.22),
                fill=BG,
            )

    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in (192, 512):
        draw_icon(size).save(os.path.join(OUT, "icon-%d.png" % size))
    draw_icon(512, maskable=True).save(os.path.join(OUT, "icon-maskable-512.png"))
    draw_icon(180).save(os.path.join(OUT, "apple-touch-icon.png"))
    print("wrote icons to", os.path.normpath(OUT))


if __name__ == "__main__":
    main()
