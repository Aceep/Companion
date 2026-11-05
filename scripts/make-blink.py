#!/usr/bin/env python3
"""Derive the static idle frame and the blink frames from the rest frame.

Theo's zip has no blink: Crêpe either breathes (tentacles move) or sleeps.
Alycia wants her still between events, only blinking now and then. The
blink is drawn pixel by pixel on top of respiration_00 so nothing else
moves, using the closed-eye shape from the "endormie" frames (a shallow
downward arc the width of the eye).

Usage: scripts/make-blink.py  (from anywhere; paths are relative to the repo)
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
REST = ASSETS / "respiration" / "respiration_00.png"

BODY = (94, 188, 224, 255)
OUTLINE = (1, 3, 5, 255)

# Open eyes in the rest frame: rows 39-45, left eye x 27-34, right eye x 45-52.
EYE_TOP, EYE_BOTTOM = 39, 45
EYES = [(27, 34), (45, 52)]


def clear_rows(image: Image.Image, top: int, bottom: int) -> None:
    for left, right in EYES:
        for y in range(top, bottom + 1):
            for x in range(left, right + 1):
                image.putpixel((x, y), BODY)


def half_closed(rest: Image.Image) -> Image.Image:
    image = rest.copy()
    # Lid comes down over the upper half; the lower rounded half stays.
    clear_rows(image, EYE_TOP, EYE_TOP + 2)
    return image


def closed(rest: Image.Image) -> Image.Image:
    image = rest.copy()
    clear_rows(image, EYE_TOP, EYE_BOTTOM)
    for left, right in EYES:
        image.putpixel((left, EYE_BOTTOM - 1), OUTLINE)
        image.putpixel((right, EYE_BOTTOM - 1), OUTLINE)
        for x in range(left + 1, right):
            image.putpixel((x, EYE_BOTTOM), OUTLINE)
    return image


def write_animation(name: str, frames: list[Image.Image]) -> None:
    folder = ASSETS / name
    folder.mkdir(exist_ok=True)
    for index, frame in enumerate(frames):
        frame.save(folder / f"{name}_{index:02d}.png")
    sheet = Image.new("RGBA", (frame.width * len(frames), frame.height), (0, 0, 0, 0))
    for index, frame in enumerate(frames):
        sheet.paste(frame, (index * frame.width, 0))
    sheet.save(folder / f"{name}_planche.png")


def main() -> None:
    rest = Image.open(REST).convert("RGBA")
    assert rest.getpixel((27, 39)) == OUTLINE and rest.getpixel((52, 45)) != OUTLINE, "rest frame changed; eye coordinates need a review"
    write_animation("attente", [rest])
    half = half_closed(rest)
    write_animation("clignement", [rest, half, closed(rest), half])
    print("wrote assets/attente and assets/clignement")


if __name__ == "__main__":
    main()
