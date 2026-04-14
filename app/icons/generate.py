"""Generate tray icon variants + the exe brand icon for ForgetMeNot.

Design: keep the flower petals untouched, replace the center with a clean
status-colored disk + subtle glow. Geometric placement (centered circle)
rather than color-sampling so the shape stays crisp and never leaks onto
the petals.

Status colors (runtime tray icon, swapped by health state):
    healthy  #facc15 yellow   (all subsystems up)
    degraded #f97316 orange   (partial — deliberately distinct from yellow
                               so "healthy but with a warning" never reads
                               as "all fine" at a glance)
    error    #ef4444 red
    paused   #71717a gray
    loading  #7aa2f7 blue     (used while the runtime is starting or the
                               bundle is being fetched — swapped in by the
                               tray, produced below as loading.ico)

Brand icon (embedded in the exe as its File Explorer / taskbar / Alt-Tab
icon — static, not status-dependent):
    forgetmenot.ico — the neutral flower mark, no status disk

Usage:  python generate.py
Outputs: loading.ico, healthy.ico, degraded.ico, error.ico, paused.ico, forgetmenot.ico
"""

from pathlib import Path
from PIL import Image, ImageColor, ImageDraw, ImageFilter

ICON_SIZES = [(16, 16), (32, 32), (48, 48), (64, 64), (256, 256)]

# Sizes too small to read the face cleanly. At 16/32 the face just becomes
# noise — eyes blur to a smudge, the mouth disappears. These resolutions
# get the no-face variant so the icon stays crisp at tray size.
NO_FACE_SIZES = {(16, 16), (32, 32)}

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

# Tiny face — two dot eyes and a short horizontal mouth line. Sized to
# read at 48px+ and gracefully disappear at 16px (where anti-aliasing
# just blurs it into the center disk rather than making noise). The
# face is drawn in near-black against whatever the disk color is so it
# stays legible across all status variants.
FACE_COLOR = (24, 24, 26)  # near-black, matches tray background tones
EYE_RADIUS_RATIO = 0.018          # each eye dot
EYE_OFFSET_X_RATIO = 0.035        # horizontal distance from center
EYE_OFFSET_Y_RATIO = -0.015       # slightly above center
MOUTH_HALF_WIDTH_RATIO = 0.028    # horizontal span of mouth line
MOUTH_OFFSET_Y_RATIO = 0.028      # below center
MOUTH_THICKNESS_RATIO = 0.012     # line weight

STATUS_COLORS = {
    "healthy":  "#facc15",
    "degraded": "#f97316",
    "error":    "#ef4444",
    "paused":   "#71717a",
    "loading":  "#7aa2f7",
}


def load_flower(canvas: int) -> Image.Image:
    """Load the source flower and upscale to the work canvas."""
    src = Image.open(ROOT / "flower.png").convert("RGBA")
    return src.resize((canvas, canvas), Image.Resampling.LANCZOS)


def draw_face(canvas: int, cx: int, cy: int) -> Image.Image:
    """Render the two-eyes-and-mouth face on a transparent layer."""
    face = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    face_draw = ImageDraw.Draw(face)
    eye_r = max(1, int(canvas * EYE_RADIUS_RATIO))
    eye_dx = int(canvas * EYE_OFFSET_X_RATIO)
    eye_dy = int(canvas * EYE_OFFSET_Y_RATIO)
    for sign in (-1, 1):
        ex, ey = cx + sign * eye_dx, cy + eye_dy
        face_draw.ellipse((ex - eye_r, ey - eye_r, ex + eye_r, ey + eye_r), fill=(*FACE_COLOR, 255))
    mouth_hw = int(canvas * MOUTH_HALF_WIDTH_RATIO)
    mouth_y = cy + int(canvas * MOUTH_OFFSET_Y_RATIO)
    mouth_w = max(1, int(canvas * MOUTH_THICKNESS_RATIO))
    face_draw.line(
        (cx - mouth_hw, mouth_y, cx + mouth_hw, mouth_y),
        fill=(*FACE_COLOR, 255), width=mouth_w,
    )
    return face


def make_icon(status_hex: str, canvas: int = WORK_CANVAS, with_face: bool = True) -> Image.Image:
    """Build one icon variant by layering on top of the flower.

    `with_face=False` returns the same composition without the eyes/mouth —
    used for the small-resolution slots in the .ico where the face would
    just smear into noise.
    """
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

    # ── Compose: flower → glow → disk → highlight (→ face if requested).
    # Face sits on top of the highlight so the highlight doesn't wash out
    # one eye and turn the icon into a glossy cyclops.
    out = Image.alpha_composite(flower, glow)
    out = Image.alpha_composite(out, disk)
    out = Image.alpha_composite(out, highlight)
    if with_face:
        out = Image.alpha_composite(out, draw_face(canvas, cx, cy))
    return out


def save_ico_split(face_img: Image.Image, no_face_img: Image.Image, path: Path) -> None:
    """Save a multi-resolution ICO that uses the no-face render at small
    sizes and the with-face render at large sizes.

    Pillow's ICO writer matches frames in `[primary] + append_images`
    against requested sizes — anything not matched gets downscaled from
    the primary. We pre-render both variants at every target size so PIL
    never has to downscale and pick the wrong source for a slot.
    """
    frames = []
    primary = None
    for size in sorted(set(ICON_SIZES)):
        src = no_face_img if size in NO_FACE_SIZES else face_img
        frame = src.resize(size, Image.Resampling.LANCZOS)
        if primary is None:
            primary = frame
        else:
            frames.append(frame)
    primary.save(path, sizes=ICON_SIZES, append_images=frames)


def save_preview(img: Image.Image, name: str) -> None:
    """Save a 128px PNG next to the ICO for quick eyeballing."""
    preview = img.resize((128, 128), Image.Resampling.LANCZOS)
    preview.save(ROOT / f"{name}-preview.png")


for name, status_hex in STATUS_COLORS.items():
    icon_face = make_icon(status_hex, with_face=True)
    icon_plain = make_icon(status_hex, with_face=False)
    save_ico_split(icon_face, icon_plain, ROOT / f"{name}.ico")
    save_preview(icon_face, name)
    print(f"Wrote {name}.ico")


# ── Brand icon: the neutral flower used as the exe's File Explorer /
# taskbar / Alt-Tab icon. Same face-on-large / face-off-small treatment as
# status variants so the icon stays crisp at every Windows surface.
brand_cx, brand_cy = WORK_CANVAS // 2, WORK_CANVAS // 2
brand_plain = load_flower(WORK_CANVAS)
brand_face = Image.alpha_composite(brand_plain, draw_face(WORK_CANVAS, brand_cx, brand_cy))
save_ico_split(brand_face, brand_plain, ROOT / "forgetmenot.ico")
print("Wrote forgetmenot.ico")
