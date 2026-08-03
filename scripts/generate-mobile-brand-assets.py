from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "apps" / "mobile" / "assets"

BG = (5, 7, 6, 255)
PANEL = (14, 18, 15, 255)
PANEL_2 = (18, 25, 20, 255)
GREEN = (47, 230, 168, 255)
GREEN_DARK = (24, 117, 87, 255)
RED = (255, 88, 92, 255)
RED_DARK = (130, 38, 42, 255)
GOLD = (245, 201, 74, 255)
WHITE = (238, 246, 241, 255)
MUTED = (128, 144, 136, 255)


def font(size: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial Bold.ttf" if bold else "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def rounded_rect(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], radius: int, fill, outline=None, width: int = 1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def make_mark(size: int, transparent: bool = False) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0) if transparent else BG)
    draw = ImageDraw.Draw(image)
    scale = size / 1024

    def s(value: int) -> int:
        return round(value * scale)

    if not transparent:
        rounded_rect(draw, (s(64), s(64), s(960), s(960)), s(210), fill=PANEL, outline=(31, 48, 39, 255), width=s(5))

    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse((s(210), s(190), s(814), s(794)), fill=(47, 230, 168, 42))
    glow_draw.ellipse((s(300), s(270), s(724), s(694)), fill=(255, 88, 92, 30))
    image.alpha_composite(glow.filter(ImageFilter.GaussianBlur(s(36))))

    draw = ImageDraw.Draw(image)
    draw.ellipse((s(232), s(210), s(792), s(770)), fill=(8, 42, 31, 255), outline=(31, 105, 75, 255), width=s(10))
    draw.ellipse((s(304), s(282), s(720), s(698)), fill=(22, 33, 26, 255), outline=(45, 62, 52, 255), width=s(5))

    # Candlestick badge, clean and non-bird-like.
    draw.line((s(320), s(650), s(704), s(650)), fill=(224, 232, 226, 255), width=s(16))
    draw.line((s(382), s(352), s(382), s(672)), fill=GREEN, width=s(32))
    rounded_rect(draw, (s(326), s(438), s(438), s(578)), s(26), fill=GREEN)
    draw.line((s(512), s(292), s(512), s(618)), fill=WHITE, width=s(28))
    rounded_rect(draw, (s(456), s(388), s(568), s(524)), s(26), fill=WHITE)
    draw.line((s(642), s(330), s(642), s(690)), fill=RED, width=s(32))
    rounded_rect(draw, (s(586), s(486), s(698), s(610)), s(26), fill=RED)

    # Market movement line: green recovery after a red dip.
    draw.line((s(270), s(396), s(360), s(456), s(466), s(410)), fill=RED, width=s(24), joint="curve")
    draw.line((s(466), s(410), s(580), s(350), s(730), s(404)), fill=GREEN, width=s(24), joint="curve")
    draw.ellipse((s(448), s(392), s(484), s(428)), fill=WHITE)
    draw.ellipse((s(712), s(386), s(748), s(422)), fill=GREEN)

    # Compact XAU label under the candle group.
    rounded_rect(draw, (s(406), s(738), s(618), s(804)), s(33), fill=(20, 26, 22, 255), outline=(52, 72, 61, 255), width=s(4))
    draw.text((s(512), s(771)), "XAU", fill=WHITE, font=font(s(38), True), anchor="mm")

    return image


def make_logo() -> Image.Image:
    image = Image.new("RGBA", (920, 260), (0, 0, 0, 0))
    mark = make_mark(208, transparent=True)
    image.alpha_composite(mark, (24, 26))
    draw = ImageDraw.Draw(image)
    draw.text((260, 72), "XAUUSD", fill=WHITE, font=font(68, True), anchor="la")
    draw.text((260, 142), "SIGNAL", fill=GREEN, font=font(42, True), anchor="la")
    draw.line((260, 200, 705, 200), fill=(48, 66, 56, 255), width=3)
    draw.line((260, 200, 365, 200), fill=GREEN, width=5)
    draw.line((368, 200, 470, 200), fill=RED, width=5)
    draw.text((260, 222), "NY SESSION INDICATORS", fill=MUTED, font=font(22, True), anchor="la")
    return image


def make_splash() -> Image.Image:
    image = Image.new("RGBA", (1242, 2436), BG)
    glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse((170, 570, 1072, 1472), fill=(47, 230, 168, 36))
    glow_draw.ellipse((335, 730, 907, 1302), fill=(255, 88, 92, 24))
    image.alpha_composite(glow.filter(ImageFilter.GaussianBlur(70)))
    mark = make_mark(520, transparent=True)
    image.alpha_composite(mark, ((1242 - 520) // 2, 740))
    draw = ImageDraw.Draw(image)
    draw.text((621, 1350), "XAUUSD SIGNAL", fill=WHITE, font=font(72, True), anchor="mm")
    draw.text((621, 1434), "New York session trading modules", fill=MUTED, font=font(32, False), anchor="mm")
    return image


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    make_mark(1024).save(ASSETS / "icon.png")
    make_mark(1024, transparent=True).save(ASSETS / "adaptive-icon.png")
    make_mark(256, transparent=True).save(ASSETS / "brand-mark.png")
    make_logo().save(ASSETS / "brand-logo.png")
    make_splash().save(ASSETS / "splash.png")


if __name__ == "__main__":
    main()
