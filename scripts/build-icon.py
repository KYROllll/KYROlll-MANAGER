#!/usr/bin/env python3
"""Generate the KYROlll macOS app icon from the authentic flower emblem."""
import os
import subprocess
import sys
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src", "assets", "kyrolll-flower.png")
BUILD = os.path.join(ROOT, "build")
ICON_PNG = os.path.join(BUILD, "icon.png")
ICONSET = os.path.join(BUILD, "icon.iconset")
ICNS = os.path.join(BUILD, "icon.icns")

SIZE = 1024
RADIUS = 224  # ~22.4% corner radius, macOS-style squircle-ish rounding

def make_icon(size):
    # Load the transparent emblem and composite it over the black icon tile.
    src = Image.open(SRC).convert("RGBA")
    if src.size != (SIZE, SIZE):
        src = src.resize((SIZE, SIZE), Image.LANCZOS)
    rgba = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 255))
    rgba.paste(src, (0, 0), src)

    # Build squircle/rounded-rect mask.
    mask = Image.new("L", (SIZE, SIZE), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=RADIUS, fill=255)
    rgba.putalpha(mask)
    if size != SIZE:
        rgba = rgba.resize((size, size), Image.LANCZOS)
    return rgba

def main():
    os.makedirs(BUILD, exist_ok=True)
    icon = make_icon(SIZE)
    icon.save(ICON_PNG, "PNG")
    print(f"wrote {ICON_PNG}")

    # Generate an .iconset with all standard macOS sizes.
    os.makedirs(ICONSET, exist_ok=True)
    sizes = [16, 32, 64, 128, 256, 512, 1024]
    for s in sizes:
        img = make_icon(s)
        img.save(os.path.join(ICONSET, f"icon_{s}x{s}.png"), "PNG")
        if s <= 512:
            img2 = make_icon(s * 2)
            img2.save(os.path.join(ICONSET, f"icon_{s}x{s}@2x.png"), "PNG")
    print(f"wrote {ICONSET}")

    # Build .icns on macOS.
    if sys.platform == "darwin":
        try:
            subprocess.run(["iconutil", "-c", "icns", ICONSET, "-o", ICNS], check=True)
            print(f"wrote {ICNS}")
        except Exception as e:
            print(f"iconutil failed: {e}", file=sys.stderr)

if __name__ == "__main__":
    main()
