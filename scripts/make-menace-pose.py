#!/usr/bin/env python3
"""Derive the "holding the bat" poses from the last frame of the swing.

Theo's "menace" swing ends with the bat held across her front. While she
sulks she keeps it out: menace_08 becomes her resting pose, gets the same
blink as the normal one, and the swing played backwards is her putting
the bat away. Only the eyes are redrawn, at the head's offset from the
rest frame (measured like scripts/restore-face.py does), so the bat and
the tentacles stay exactly as Theo drew them.

Usage: scripts/make-menace-pose.py  (from anywhere; paths are relative to the repo)
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
REST = ASSETS / "respiration" / "respiration_00.png"
SWING = ASSETS / "menace"
SWING_FRAMES = 9

BODY = (94, 188, 224, 255)
OUTLINE = (1, 3, 5, 255)

# Open eyes in the rest frame: rows 39-45, left eye x 27-34, right eye x 45-52.
EYE_TOP, EYE_BOTTOM = 39, 45
EYES = [(27, 34), (45, 52)]
HEAD_CENTRE_COLUMN = 40


def head_anchor(image: Image.Image) -> tuple[int, float]:
    """Top of the outline at the head's centre column, and the head's horizontal centre a bit lower."""
    top = next(y for y in range(image.height) if image.getpixel((HEAD_CENTRE_COLUMN, y))[3])
    row = top + 10
    columns = [x for x in range(image.width) if image.getpixel((x, row))[3]]
    return top, (min(columns) + max(columns)) / 2


def head_offset(rest: Image.Image, frame: Image.Image) -> tuple[int, int]:
    rest_top, rest_centre = head_anchor(rest)
    frame_top, frame_centre = head_anchor(frame)
    return round(frame_centre - rest_centre), frame_top - rest_top


def eyes_match(rest: Image.Image, frame: Image.Image, dx: int, dy: int) -> bool:
    """The blink overwrites the eye boxes; anything else drawn there (the bat, a tentacle) would be lost."""
    return all(
        rest.getpixel((x, y)) == frame.getpixel((x + dx, y + dy))
        for left, right in EYES
        for y in range(EYE_TOP, EYE_BOTTOM + 1)
        for x in range(left, right + 1)
    )


def clear_rows(image: Image.Image, top: int, bottom: int, dx: int, dy: int) -> None:
    for left, right in EYES:
        for y in range(top, bottom + 1):
            for x in range(left, right + 1):
                image.putpixel((x + dx, y + dy), BODY)


def half_closed(pose: Image.Image, dx: int, dy: int) -> Image.Image:
    image = pose.copy()
    # Lid comes down over the upper half; the lower rounded half stays.
    clear_rows(image, EYE_TOP, EYE_TOP + 2, dx, dy)
    return image


def closed(pose: Image.Image, dx: int, dy: int) -> Image.Image:
    image = pose.copy()
    clear_rows(image, EYE_TOP, EYE_BOTTOM, dx, dy)
    for left, right in EYES:
        image.putpixel((left + dx, EYE_BOTTOM - 1 + dy), OUTLINE)
        image.putpixel((right + dx, EYE_BOTTOM - 1 + dy), OUTLINE)
        for x in range(left + 1, right):
            image.putpixel((x + dx, EYE_BOTTOM + dy), OUTLINE)
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
    swing = [Image.open(SWING / f"menace_{index:02d}.png").convert("RGBA") for index in range(SWING_FRAMES)]
    held = swing[-1]
    dx, dy = head_offset(rest, held)
    assert eyes_match(rest, held, dx, dy), "menace_08 eyes differ from the rest frame; the blink would erase something"

    write_animation("menace_tenue", [held])
    half = half_closed(held, dx, dy)
    write_animation("menace_clignement", [held, half, closed(held, dx, dy), half])
    write_animation("menace_rangee", list(reversed(swing)))
    print(f"head offset {(dx, dy)}; wrote assets/menace_tenue, assets/menace_clignement and assets/menace_rangee")


if __name__ == "__main__":
    main()
