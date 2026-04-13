"""Generate 4 tray icon variants for ForgetMeNot from the flower mark.

Design: keep the flower petals untouched, replace the center with a clean
status-colored disk + subtle glow. Geometric placement (centered circle)
rather than color-sampling so the shape stays crisp and never leaks onto
the petals.

Status colors:
    healthy  #7aa2f7 blue
    degraded #facc15 yellow
    error    #ef4444 red
    paused   #71717a gray

Usage:  python generate.py
Outputs: healthy.ico, degraded.ico, error.ico, paused.ico
"""

from pathlib import Path
from PIL import Image, ImageColor, ImageDraw, ImageFilter

ICON_SIZES = [(16, 16), (32, 32), (48, 48), (64, 64), (256, 256)]
ROOT = Path(__file__).resolve().parent

# Work at high resolution then downsample for each icon size — this keeps
# the blur/antialiasing smooth at every target size.
WORK_CANVAS = 512

# Center disk: % of the canvas width. Tuned so it reads clearly at 16×16
# (where the disk becomes ~4px) while not dominating at larger sizes.
CENTER_RADIUS_RATIO = 0.14

# Glow extends slightly beyond the disk — tight enough to stay on the
# center, not bloom across the flower.
GLOW_RADIUS_RATIO = 0.22
GLOW_BLUR_RATIO = 0.045
GLOW_ALPHA = 110  # 0-255

# Highlight dot on the center disk for a slight 3D feel.
HIGHLIGHT_OFFSET_RATIO = (-0.035, -0.040)
HIGHLIGHT_RADIUS_RATIO = 0.055
HIGHLIGHT_ALPHA = 95

STATUS_COLORS = {
    "healthy":  "#7aa2f7",
    "degraded": "#facc15",
    "error":    "#ef4444",
    "paused":   "#71717a",
}


def load_flower(canvas: int) -> Image.Image:
    """Load the source flower and upscale to the work canvas."""
    src = Image.open(ROOT / "flower.png").convert("RGBA")
    return src.resize((canvas, canvas), Image.Resampling.LANCZOS)


def make_icon(status_hex: str, canvas: int = WORK_CANVAS) -> Image.Image:
    """Build one icon variant by layering on top of the flower."""
    flower = load_flower(canvas)
    cx, cy = canvas // 2, canvas // 2
    rgb = ImageColor.getrgb(status_hex)

    # ── Glow layer: soft halo centered on the disk, clipped tight.
    glow = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_r = int(canvas * GLOW_RADIUS_RATIO)
    glow_draw.ellipse(
        (cx - glow_r, cy - glow_r, cx + glow_r, cy + glow_r),
        fill=(*rgb, GLOW_ALPHA),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(canvas * GLOW_BLUR_RATIO))

    # ── Center disk: crisp filled circle in status color.
    disk = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    disk_draw = ImageDraw.Draw(disk)
    disk_r = int(canvas * CENTER_RADIUS_RATIO)
    disk_draw.ellipse(
        (cx - disk_r, cy - disk_r, cx + disk_r, cy + disk_r),
        fill=(*rgb, 255),
    )

    # ── Highlight: small bright dot for a tactile/glossy feel.
    highlight = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    hl_draw = ImageDraw.Draw(highlight)
    hx = cx + int(canvas * HIGHLIGHT_OFFSET_RATIO[0])
    hy = cy + int(canvas * HIGHLIGHT_OFFSET_RATIO[1])
    hr = int(canvas * HIGHLIGHT_RADIUS_RATIO)
    hl_draw.ellipse(
        (hx - hr, hy - hr, hx + hr, hy + hr),
        fill=(255, 255, 255, HIGHLIGHT_ALPHA),
    )
    highlight = highlight.filter(ImageFilter.GaussianBlur(canvas * 0.012))

    # ── Compose: flower → glow → disk → highlight
    out = Image.alpha_composite(flower, glow)
    out = Image.alpha_composite(out, disk)
    out = Image.alpha_composite(out, highlight)
    return out


def save_ico(img: Image.Image, path: Path) -> None:
    """Save as multi-resolution ICO, rendering each size from the source
    at the target resolution (Pillow does this with `sizes=`)."""
    img.save(path, sizes=ICON_SIZES)


def save_preview(img: Image.Image, name: str) -> None:
    """Save a 128px PNG next to the ICO for quick eyeballing."""
    preview = img.resize((128, 128), Image.Resampling.LANCZOS)
    preview.save(ROOT / f"{name}-preview.png")


for name, status_hex in STATUS_COLORS.items():
    icon = make_icon(status_hex)
    save_ico(icon, ROOT / f"{name}.ico")
    save_preview(icon, name)
    print(f"Wrote {name}.ico")
