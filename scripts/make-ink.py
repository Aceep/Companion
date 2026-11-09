#!/usr/bin/env python3
"""Draw the ink splats of assets/encre/ (encre_0.png to encre_3.png).

Four irregular dark-violet splats, 48, 64, 80 and 96 px square, shown by
the extension at INK_SCALE (src/ink.ts) and faded out with the actor's
opacity, so there are no fade frames. Each splat is a blob whose radius
wobbles with the angle, a few tapering streaks ending in droplets, and
loose droplets around it.

Style, to match Theo's sprite and make-outfits.py: flat fills, no
anti-aliasing, a 1 px dark outline computed from the shape, a couple of
lighter pixels for a wet highlight.

Pure maths on fixed seeds: running it twice gives byte-identical PNGs.

Usage: scripts/make-ink.py  (from anywhere; paths are relative to the repo)
"""
import math
import random
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "encre"

# (pixels, seed): the size is also the one src/ink.ts expects for the index.
SPLATS = [(48, 11), (64, 23), (80, 37), (96, 52)]

OUTLINE = (14, 5, 24, 255)
FILL = (42, 16, 66, 255)
FILL_DARK = (28, 10, 46, 255)
GLINT = (104, 66, 150, 255)

Shape = set[tuple[int, int]]


def disc(centre: tuple[float, float], radius: float) -> Shape:
    cx, cy = centre
    reach = math.ceil(radius)
    return {(x, y)
            for x in range(int(cx) - reach, int(cx) + reach + 1)
            for y in range(int(cy) - reach, int(cy) + reach + 1)
            if (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2}


def blob(rng: random.Random, size: int) -> Shape:
    """The main body: a radius that wobbles with a few random harmonics."""
    centre = size / 2
    base = size * 0.24
    harmonics = [(rng.uniform(0.05, 0.22), k, rng.uniform(0, math.tau)) for k in (2, 3, 5, 7)]
    shape: Shape = set()
    for x in range(size):
        for y in range(size):
            angle = math.atan2(y - centre, x - centre)
            radius = base * (1 + sum(a * math.sin(k * angle + p) for a, k, p in harmonics))
            if math.hypot(x - centre, y - centre) <= radius:
                shape.add((x, y))
    return shape


def streaks(rng: random.Random, size: int) -> Shape:
    """Streaks flung outwards, thick at the root and thinning to a droplet at the tip."""
    centre = size / 2
    shape: Shape = set()
    for _ in range(rng.randint(5, 8)):
        angle = rng.uniform(0, math.tau)
        reach = size * rng.uniform(0.34, 0.47)
        start = size * 0.15
        steps = int(reach - start)
        for step in range(steps):
            t = step / max(1, steps - 1)
            distance = start + step
            width = max(0.0, 2.6 * (1 - t) ** 1.3)
            point = (centre + math.cos(angle) * distance, centre + math.sin(angle) * distance)
            shape |= disc(point, width) if width >= 0.5 else {(round(point[0]), round(point[1]))}
        tip = (centre + math.cos(angle) * reach, centre + math.sin(angle) * reach)
        shape |= disc(tip, rng.uniform(1.5, 2.8))
    return shape


def droplets(rng: random.Random, size: int) -> Shape:
    centre = size / 2
    shape: Shape = set()
    for _ in range(rng.randint(5, 9)):
        angle = rng.uniform(0, math.tau)
        distance = size * rng.uniform(0.36, 0.47)
        point = (centre + math.cos(angle) * distance, centre + math.sin(angle) * distance)
        shape |= disc(point, rng.uniform(0.8, 2.2))
    return shape


def border(shape: Shape) -> Shape:
    return {(x, y) for (x, y) in shape
            if any((x + dx, y + dy) not in shape for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))}


def draw(size: int, seed: int) -> Image.Image:
    rng = random.Random(seed)
    shape = blob(rng, size) | streaks(rng, size) | droplets(rng, size)
    shape = {(x, y) for (x, y) in shape if 0 <= x < size and 0 <= y < size}
    edge = border(shape)
    inner = shape - edge
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    for x, y in shape:
        image.putpixel((x, y), FILL)
    # A darker rim just inside the outline gives the pool some depth.
    for x, y in {(x, y) for (x, y) in inner if (x, y) not in border(inner)} - inner:
        image.putpixel((x, y), FILL_DARK)
    for x, y in {(x, y) for (x, y) in inner if any((x + dx, y + dy) in edge for dx, dy in ((1, 0), (0, 1)))}:
        image.putpixel((x, y), FILL_DARK)
    # A wet glint on the upper left of the pool.
    glint_at = (round(size * 0.40), round(size * 0.38))
    for dx, dy in ((0, 0), (1, 0), (0, 1), (-1, 1), (2, -1)):
        point = (glint_at[0] + dx, glint_at[1] + dy)
        if point in inner:
            image.putpixel(point, GLINT)
    for x, y in edge:
        image.putpixel((x, y), OUTLINE)
    return image


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for index, (size, seed) in enumerate(SPLATS):
        draw(size, seed).save(OUT / f"encre_{index}.png", optimize=False)
        print(f"wrote {OUT / f'encre_{index}.png'}")


if __name__ == "__main__":
    main()
