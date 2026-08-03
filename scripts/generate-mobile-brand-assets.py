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
    glow_draw.ellipse((s(210), s(190), s(814), s(794)), fill=(47, 230, 168, 48))
    glow_draw.ellipse((s(300), s(270), s(724), s(694)), fill=(245, 201, 74, 35))
    image.alpha_composite(glow.filter(ImageFilter.GaussianBlur(s(36))))

    draw = ImageDraw.Draw(image)
    draw.ellipse((s(232), s(210), s(792), s(770)), fill=(8, 42, 31, 255), outline=(31, 105, 75, 255), width=s(10))
    draw.ellipse((s(304), s(282), s(720), s(698)), fill=(22, 33, 26, 255), outline=(45, 62, 52, 255), width=s(5))

    # Candlestick base, clean and non-bird-like.
    draw.line((s(352), s(648), s(672), s(648)), fill=(224, 232, 226, 255), width=s(18))
    draw.line((s(392), s(356), s(392), s(690)), fill=GREEN, width=s(34))
    rounded_rect(draw, (s(330), s(462), s(454), s(584)), s(28), fill=GREEN)
    draw.line((s(624), s(300), s(624), s(640)), fill=GOLD, width=s(34))
    rounded_rect(draw, (s(562), s(422), s(686), s(544)), s(28), fill=GOLD)

    # FX monogram: strong X with a compact upward price stroke.
    draw.line((s(270), s(276), s(754), s(748)), fill=(7, 9, 8, 255), width=s(70))
    draw.line((s(754), s(276), s(270), s(748)), fill=(7, 9, 8, 255), width=s(70))
    draw.line((s(286), s(292), s(738), s(732)), fill=GOLD, width=s(38))
    draw.line((s(738), s(292), s(286), s(732)), fill=GREEN, width=s(38))
    draw.line((s(590), s(406), s(702), s(328), s(744), s(362)), fill=WHITE, width=s(16), joint="curve")

    # Small gold badge suggests XAU without text clutter in launcher.
    rounded_rect(draw, (s(416), s(734), s(608), s(798)), s(32), fill=(245, 201, 74, 255))
    draw.text((s(512), s(766)), "XAU", fill=(6, 11, 8, 255), font=font(s(34), True), anchor="mm")

    return image


def make_logo() -> Image.Image:
    image = Image.new("RGBA", (920, 260), (0, 0, 0, 0))
    mark = make_mark(208, transparent=True)
    image.alpha_composite(mark, (24, 26))
    draw = ImageDraw.Draw(image)
    draw.text((260, 72), "XAUUSD", fill=WHITE, font=font(68, True), anchor="la")
    draw.text((260, 142), "SIGNAL", fill=GREEN, font=font(42, True), anchor="la")
    draw.line((260, 200, 705, 200), fill=(48, 66, 56, 255), width=3)
    draw.line((260, 200, 470, 200), fill=GOLD, width=5)
    draw.text((260, 222), "NY SESSION INDICATORS", fill=MUTED, font=font(22, True), anchor="la")
    return image


def make_splash() -> Image.Image:
    image = Image.new("RGBA", (1242, 2436), BG)
    glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse((170, 570, 1072, 1472), fill=(47, 230, 168, 40))
    glow_draw.ellipse((335, 730, 907, 1302), fill=(245, 201, 74, 26))
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
