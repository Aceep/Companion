#!/usr/bin/env python3
"""Derive the resting poses whose eyes follow the pointer.

Her eyes are solid dark ovals with a small highlight, no white around
them, so "looking somewhere" means moving the whole eye inside the face,
the way Theo's own glance (regard_droite) does: two pixels sideways,
one up or down. Each pose is the rest frame (attente_00, and batte_tenue_00
for the sulk) with both eyes lifted off and put back at an offset, so the
eyes keep their exact shape and nothing else moves.

The blinks stay drawn on the straight pose; a blink is over too quickly
for the difference to show.

Usage: scripts/make-eyes.py  (from anywhere; paths are relative to the repo)
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"

BODY = (94, 188, 224, 255)
OUTLINE = (1, 3, 5, 255)
HIGHLIGHT = (228, 197, 209, 255)

# Open eyes in the rest frame: rows 39-45, left eye x 27-34, right eye x 45-52.
EYE_TOP, EYE_BOTTOM = 39, 45
EYES = [(27, 34), (45, 52)]

# Screen directions, y pointing down. Sideways goes two pixels like Theo's
# glance, the diagonals one each way so the eyes never touch the shading.
DIRECTIONS = {
    "nord": (0, -1),
    "nord_est": (1, -1),
    "est": (2, 0),
    "sud_est": (1, 1),
    "sud": (0, 1),
    "sud_ouest": (-1, 1),
    "ouest": (-2, 0),
    "nord_ouest": (-1, -1),
}

# Resting pose: (source frame, name prefix of the derived ones).
POSES = [
    (ASSETS / "attente" / "attente_00.png", "yeux"),
    (ASSETS / "batte_tenue" / "batte_tenue_00.png", "batte_yeux"),
]


def eye_pixels(image: Image.Image) -> dict[tuple[int, int], tuple[int, int, int, int]]:
    """Every pixel of both eyes, outline and highlight, by position."""
    pixels = {}
    for left, right in EYES:
        for y in range(EYE_TOP, EYE_BOTTOM + 1):
            for x in range(left, right + 1):
                colour = image.getpixel((x, y))
                if colour in (OUTLINE, HIGHLIGHT):
                    pixels[(x, y)] = colour
                else:
                    assert colour == BODY, f"unexpected colour {colour} at {(x, y)} inside the eye box"
    return pixels


def looking(rest: Image.Image, eyes: dict, dx: int, dy: int) -> Image.Image:
    image = rest.copy()
    for position in eyes:
        image.putpixel(position, BODY)
    for (x, y), colour in eyes.items():
        target = (x + dx, y + dy)
        # Only bare skin may be painted over: the shading, the mouth or the bat must stay as drawn.
        assert target in eyes or rest.getpixel(target) == BODY, f"eye would cover {rest.getpixel(target)} at {target}"
        image.putpixel(target, colour)
    return image


def check_round(image: Image.Image, eyes: dict, dx: int, dy: int) -> None:
    """The moved eyes are exactly the original ones, and nothing else changed."""
    moved = {(x + dx, y + dy): colour for (x, y), colour in eyes.items()}
    for y in range(image.height):
        for x in range(image.width):
            expected = moved.get((x, y))
            if expected is None:
                expected = BODY if (x, y) in eyes else None
            if expected is not None:
                assert image.getpixel((x, y)) == expected, f"eye pixel {(x, y)} is wrong"


def check_untouched(rest: Image.Image, image: Image.Image, eyes: dict, dx: int, dy: int) -> None:
    touched = set(eyes) | {(x + dx, y + dy) for x, y in eyes}
    for y in range(image.height):
        for x in range(image.width):
            if (x, y) not in touched:
                assert image.getpixel((x, y)) == rest.getpixel((x, y)), f"stray pixel at {(x, y)}"


def write_animation(name: str, frame: Image.Image) -> None:
    folder = ASSETS / name
    folder.mkdir(exist_ok=True)
    frame.save(folder / f"{name}_00.png")
    frame.save(folder / f"{name}_planche.png")


def main() -> None:
    for source, prefix in POSES:
        rest = Image.open(source).convert("RGBA")
        eyes = eye_pixels(rest)
        assert len([p for p in eyes if p[0] < 40]) == len([p for p in eyes if p[0] >= 40]), "the two eyes differ"
        for direction, (dx, dy) in DIRECTIONS.items():
            image = looking(rest, eyes, dx, dy)
            check_round(image, eyes, dx, dy)
            check_untouched(rest, image, eyes, dx, dy)
            write_animation(f"{prefix}_{direction}", image)
        print(f"wrote {len(DIRECTIONS)} poses {prefix}_* from {source.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
