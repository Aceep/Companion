#!/usr/bin/env python3
"""Put Crêpe's canonical face back on AI-generated frames.

PixelLab redraws every frame and tends to shrink the eyes, add eyebrow
lines or draw sucker spots on the tentacles, all of which the character
brief forbids. This script fixes the recurring defects without a new
generation:

- any colour outside the resting frame's palette becomes the plain
  underside pink (that removes sucker spots);
- the eyes (and the mouth unless --no-mouth, for gestures that cover it)
  are copied from respiration_00.png, shifted by however much the head
  moved in the frame (measured on the head's outline).

Usage: scripts/restore-face.py <dir with frame_0.png ... frame_8.png> [--no-mouth]
Writes the fixed frames to <dir>/fixed/ and a contact sheet there.
Check the sheet: a tentacle in front of the eyes would be overwritten.
"""
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
REST = Image.open(ROOT / "assets" / "respiration" / "respiration_00.png").convert("RGBA")
BODY = (94, 188, 224, 255)
OUTLINE = (1, 3, 5, 255)
UNDERSIDE = (216, 182, 193, 255)
REFLECTION = (228, 197, 209, 255)
PALETTE = {REST.getpixel((x, y)) for y in range(REST.height) for x in range(REST.width)}

# Face geometry in the resting frame (x0, y0, x1, y1 inclusive).
LEFT_EYE = (27, 39, 34, 45)
RIGHT_EYE = (45, 39, 52, 45)
MOUTH = (36, 45, 44, 47)
HEAD_CENTRE_COLUMN = 40


def head_anchor(image: Image.Image) -> tuple[int, float]:
    """Top of the outline at the head's centre column, and the head's horizontal centre a bit lower."""
    top = next(y for y in range(image.height) if image.getpixel((HEAD_CENTRE_COLUMN, y))[3])
    row = top + 10
    columns = [x for x in range(image.width) if image.getpixel((x, row))[3]]
    return top, (min(columns) + max(columns)) / 2


def restore(frame: Image.Image, keep_mouth: bool) -> tuple[Image.Image, tuple[int, int]]:
    fixed = frame.copy()
    for y in range(frame.height):
        for x in range(frame.width):
            pixel = fixed.getpixel((x, y))
            if pixel[3] and pixel not in PALETTE:
                fixed.putpixel((x, y), UNDERSIDE)

    rest_top, rest_centre = head_anchor(REST)
    frame_top, frame_centre = head_anchor(fixed)
    dx, dy = round(frame_centre - rest_centre), frame_top - rest_top

    boxes = [LEFT_EYE, RIGHT_EYE] + ([MOUTH] if keep_mouth else [])
    for x0, y0, x1, y1 in boxes:
        # Erase what the AI drew around the feature (stray eyebrow lines included)...
        for y in range(y0 - 2, y1 + 2):
            for x in range(x0 - 1, x1 + 2):
                if fixed.getpixel((x + dx, y + dy)) in (OUTLINE, REFLECTION):
                    fixed.putpixel((x + dx, y + dy), BODY)
        # ...then stamp the canonical feature.
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                fixed.putpixel((x + dx, y + dy), REST.getpixel((x, y)))
    return fixed, (dx, dy)


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    source = Path(sys.argv[1])
    keep_mouth = "--no-mouth" not in sys.argv
    target = source / "fixed"
    target.mkdir(exist_ok=True)

    frames = []
    for index in range(9):
        frame = Image.open(source / f"frame_{index}.png").convert("RGBA")
        # Frame 0 is the untouched input; it is the reference, not a suspect.
        fixed, offset = (frame, (0, 0)) if index == 0 else restore(frame, keep_mouth)
        fixed.save(target / f"frame_{index}.png")
        frames.append(fixed)
        print(f"frame {index}: head offset {offset}")

    zoom = 4
    sheet = Image.new("RGBA", (frames[0].width * zoom * len(frames), frames[0].height * zoom), (60, 60, 60, 255))
    for index, frame in enumerate(frames):
        big = frame.resize((frame.width * zoom, frame.height * zoom), Image.NEAREST)
        sheet.paste(big, (index * big.width, 0), big)
    sheet.save(target / "sheet.png")
    print(f"wrote {target}")


if __name__ == "__main__":
    main()
