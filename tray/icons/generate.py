"""Generate 4 colored-circle ICO icons for the ForgetMeNot tray.

Usage:  python generate.py
Outputs: healthy.ico, degraded.ico, error.ico, paused.ico
"""

from PIL import Image, ImageDraw

ICON_SIZES = [(16, 16), (32, 32), (48, 48), (64, 64), (256, 256)]

COLORS = {
    "healthy":  ((34, 197, 94),   "Green — runtime ok"),
    "degraded": ((250, 204, 21),  "Yellow — degraded"),
    "error":    ((239, 68, 68),   "Red — error"),
    "paused":   ((113, 113, 122), "Gray — paused"),
}


def make_icon(color):
    """Return an Image with a filled circle in the given RGB color."""
    # Largest size as canvas; ICO can hold multiple
    size = ICON_SIZES[-1][0]
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # 20% margin so the circle reads cleanly even at 16px
    margin = size // 5
    draw.ellipse(
        (margin, margin, size - margin, size - margin),
        fill=color + (255,),
    )
    return img


for name, (rgb, _desc) in COLORS.items():
    img = make_icon(rgb)
    out = f"{name}.ico"
    img.save(out, sizes=ICON_SIZES)
    print(f"Wrote {out}")
