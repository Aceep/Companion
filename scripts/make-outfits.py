#!/usr/bin/env python3
"""Draw the placeholder outfits of assets/tenues.json.

Each outfit layer is an 80x80 RGBA PNG laid over (or under) her frame at
the same origin, so every coordinate here is a sprite pixel of
attente_00.png: her head's top is row 20, her eyes rows 39-45 (left eye
x 27-34, right eye x 45-52), her head is widest (x 20-59) around row 40,
her right-most tentacle ends around x 66 on rows 47-53.

Layers marked "suit_la_tete" in tenues.json move up and down with her
head at runtime (src/sprite.ts measures each frame), so they are drawn
against the resting pose's head and nothing else.

Style, to match Theo's sprite: flat fills, no anti-aliasing, a 1 px dark
outline around each part (computed from the part's own shape), one
lighter row or pixel for the highlight.

The drawing is pure maths on fixed coordinates: running it twice gives
byte-identical PNGs. To replace a placeholder with real art, drop an
80x80 RGBA PNG under the same name in assets/tenues/ and do not rerun
this script (or remove that outfit from OUTFITS below).

Usage: scripts/make-outfits.py  (from anywhere; paths are relative to the repo)
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "tenues"
SIZE = 80

# Her own outline, and colours already in her frames or the bat.
OUTLINE = (1, 3, 5, 255)
WHITE = (248, 245, 247, 255)
PINK = (216, 182, 193, 255)
BODY = (94, 188, 224, 255)
BODY_SHADE = (67, 151, 192, 255)
WOOD = (184, 101, 27, 255)
WOOD_LIGHT = (233, 137, 43, 255)
ORANGE = (255, 172, 63, 255)
ORANGE_LIGHT = (254, 181, 73, 255)

MASK = (60, 46, 112, 255)
MASK_LIGHT = (98, 82, 164, 255)
STRAP = (34, 26, 66, 255)
RED = (214, 52, 58, 255)
RED_DARK = (160, 30, 44, 255)
RED_LIGHT = (240, 96, 96, 255)
RIB = (200, 198, 214, 255)
LENS = (44, 46, 62, 255)
GLINT = (176, 186, 206, 255)
PARTY_PINK = (236, 94, 140, 255)
PARTY_YELLOW = (255, 214, 92, 255)
GLASS = (214, 236, 244, 255)
GLASS_EDGE = (170, 206, 222, 255)
CLOTH_RED = (230, 80, 70, 255)

Shape = set[tuple[int, int]]


def ellipse(box: tuple[int, int, int, int]) -> Shape:
    return polygon_or_ellipse(lambda draw: draw.ellipse(box, fill=1))


def rectangle(box: tuple[int, int, int, int]) -> Shape:
    left, top, right, bottom = box
    return {(x, y) for x in range(left, right + 1) for y in range(top, bottom + 1)}


def polygon(points: list[tuple[float, float]]) -> Shape:
    return polygon_or_ellipse(lambda draw: draw.polygon(points, fill=1))


def polygon_or_ellipse(paint) -> Shape:
    # Mode "1" has no anti-aliasing: every pixel is in or out.
    canvas = Image.new("1", (SIZE, SIZE), 0)
    paint(ImageDraw.Draw(canvas))
    return {(x, y) for y in range(SIZE) for x in range(SIZE) if canvas.getpixel((x, y))}


def line(start: tuple[int, int], end: tuple[int, int]) -> Shape:
    return polygon_or_ellipse(lambda draw: draw.line([start, end], fill=1, width=1))


def border(shape: Shape) -> Shape:
    """The pixels of the shape touching the outside: where its outline goes."""
    return {(x, y) for (x, y) in shape
            if any((x + dx, y + dy) not in shape for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))}


def under_top_edge(shape: Shape) -> Shape:
    """The first row of fill under the outline: where the light catches it."""
    edge = border(shape)
    inner = shape - edge
    return {(x, y) for (x, y) in inner if (x, y - 1) in edge}


class Layer:
    def __init__(self) -> None:
        self.image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    def paint(self, pixels, colour) -> None:
        for x, y in pixels:
            if 0 <= x < SIZE and 0 <= y < SIZE:
                self.image.putpixel((x, y), colour)

    def part(self, shape: Shape, fill, highlight=None) -> None:
        """A filled part with its own outline, over whatever was drawn before."""
        self.paint(shape, fill)
        if highlight is not None:
            self.paint(under_top_edge(shape), highlight)
        self.paint(border(shape), OUTLINE)

    def save(self, name: str) -> None:
        OUT.mkdir(parents=True, exist_ok=True)
        self.image.save(OUT / f"{name}.png", optimize=False)


def sleep_mask() -> Layer:
    """Two padded lobes over her eyes, a pink stitched closed eye on each, a strap to the sides of her head."""
    layer = Layer()
    # The strap first, so the mask's outline closes over its ends.
    layer.paint(rectangle((20, 41, 23, 41)) | rectangle((56, 41, 59, 41)), STRAP)
    shape = ellipse((22, 37, 38, 47)) | ellipse((41, 37, 57, 47)) | rectangle((30, 38, 49, 44))
    layer.part(shape, MASK, MASK_LIGHT)
    for centre in (30, 49):
        layer.paint({(centre - 4, 42), (centre + 3, 42)} | {(x, 43) for x in range(centre - 3, centre + 3)}, PINK)
    return layer


def knit_hat() -> Layer:
    """A red knit dome with ribs, a white rolled rim above her eyes, a pompom on top."""
    layer = Layer()
    dome = {(x, y) for (x, y) in ellipse((24, 11, 55, 37)) if y <= 27}
    layer.part(dome, RED, RED_LIGHT)
    inner = dome - border(dome) - under_top_edge(dome)
    layer.paint({(x, y) for (x, y) in inner if x % 4 == 1}, RED_DARK)
    rim = ellipse((20, 25, 59, 31)) | rectangle((22, 26, 57, 29))
    layer.paint(rim, WHITE)
    layer.paint({(x, y) for (x, y) in rim - border(rim) if x % 3 == 0}, RIB)
    layer.paint(border(rim), OUTLINE)
    pompom = ellipse((35, 5, 44, 14))
    layer.part(pompom, WHITE)
    layer.paint({(40, 12), (41, 11), (41, 12), (39, 12)}, RIB)
    return layer


def sunglasses() -> Layer:
    """Two dark lenses over her eyes (with room for them to look around), a bridge, the arms to her head's sides."""
    layer = Layer()
    layer.paint(rectangle((20, 39, 25, 39)) | rectangle((54, 39, 59, 39)) | rectangle((36, 39, 43, 39)), OUTLINE)
    for left in (24, 43):
        lens = rectangle((left, 37, left + 12, 46)) - {
            (left, 37), (left + 12, 37), (left, 46), (left + 12, 46)}
        layer.part(lens, LENS)
        layer.paint({(left + 3, 39), (left + 2, 40), (left + 4, 39)}, GLINT)
    return layer


def party_hat() -> Layer:
    """A pink and yellow striped cone, tilted to her right, with a white pompom at the tip."""
    layer = Layer()
    base_left, base_right, apex = (32.5, 22.5), (47.5, 20.0), (45.0, 2.0)
    cone = polygon([base_left, base_right, apex])
    base_centre = ((base_left[0] + base_right[0]) / 2, (base_left[1] + base_right[1]) / 2)
    axis = (apex[0] - base_centre[0], apex[1] - base_centre[1])
    length_squared = axis[0] ** 2 + axis[1] ** 2
    stripes = {(x, y) for (x, y) in cone
               if int(((x - base_centre[0]) * axis[0] + (y - base_centre[1]) * axis[1]) / length_squared * 6) % 2 == 1}
    layer.paint(cone, PARTY_PINK)
    layer.paint(stripes, PARTY_YELLOW)
    layer.paint(border(cone), OUTLINE)
    layer.part(ellipse((42, 0, 47, 5)), WHITE)
    return layer


def glass() -> Layer:
    """A tumbler of something orange with a straw, the tip of her right-most tentacle curled around its foot."""
    layer = Layer()
    straw = line((70, 41), (74, 31))
    layer.paint({(x + dx, y + dy) for (x, y) in straw for dx in (-1, 0, 1) for dy in (-1, 0, 1)}, OUTLINE)
    layer.paint({(x, y) for (x, y) in straw if y % 2 == 0}, PARTY_PINK)
    layer.paint({(x, y) for (x, y) in straw if y % 2 == 1}, WHITE)
    tumbler = polygon([(65, 38), (75, 38), (74, 51), (66, 51)])
    layer.paint(tumbler, GLASS)
    layer.paint({(x, y) for (x, y) in tumbler if y >= 43}, ORANGE)
    layer.paint({(x, y) for (x, y) in tumbler if y == 43}, ORANGE_LIGHT)
    layer.paint({(x, y) for (x, y) in tumbler - border(tumbler) if x == min(px for px, py in tumbler if py == y) + 1}, GLASS_EDGE)
    layer.paint(border(tumbler), OUTLINE)
    # The straw goes into the drink, in front of the glass's far wall.
    layer.paint({(x, y) for (x, y) in straw if y >= 38}, PARTY_PINK)
    tip = ellipse((62, 46, 70, 52)) - {(x, y) for x in range(62, 71) for y in range(46, 48) if x < 64}
    layer.part(tip, BODY)
    layer.paint({(x, 51) for x in range(64, 69)} - border(tip), BODY_SHADE)
    return layer


def deckchair() -> Layer:
    """Behind her: a red and white striped sling between two wooden uprights leaning back, her head above it, two legs splayed under her."""
    layer = Layer()
    for start, end in (((10, 66), (5, 78)), ((69, 66), (74, 78))):
        leg = polygon_or_ellipse(lambda draw, s=start, e=end: draw.line([s, e], fill=1, width=3))
        layer.part(leg, WOOD)
    sling = polygon([(14, 36), (65, 36), (69, 66), (10, 66)])
    layer.paint(sling, WHITE)
    layer.paint({(x, y) for (x, y) in sling if (x - 10) // 5 % 2 == 0}, CLOTH_RED)
    layer.paint(border(sling), OUTLINE)
    for top, bottom in (((13, 34), (9, 68)), ((66, 34), (70, 68))):
        upright = polygon_or_ellipse(lambda draw, t=top, b=bottom: draw.line([t, b], fill=1, width=3))
        layer.part(upright, WOOD, WOOD_LIGHT)
    layer.part(rectangle((9, 65, 70, 67)), WOOD, WOOD_LIGHT)
    return layer


OUTFITS = {
    "masque_nuit": sleep_mask,
    "bonnet": knit_hat,
    "lunettes": sunglasses,
    "chapeau_fete": party_hat,
    "verre": glass,
    "transat": deckchair,
}


def main() -> None:
    for name, draw in OUTFITS.items():
        draw().save(name)
        print(f"wrote {OUT / name}.png")


if __name__ == "__main__":
    main()
