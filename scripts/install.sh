#!/usr/bin/env bash
# Build the extension and install it into the user's GNOME Shell extensions
# directory. It is NOT enabled in the live session; use `npm run nested` to
# try it safely, or `gnome-extensions enable crepe@aceep.github.io` once you
# trust it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="$(node -e 'console.log(require(process.argv[1]).uuid)' "$ROOT/metadata.json")"
TARGET="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

cd "$ROOT"
npx tsc

rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -r dist/. "$TARGET/"
cp metadata.json stylesheet.css "$TARGET/"
mkdir -p "$TARGET/schemas"
cp schemas/*.gschema.xml "$TARGET/schemas/"
glib-compile-schemas --strict "$TARGET/schemas"
mkdir -p "$TARGET/assets"
cp assets/animations.json assets/repliques.json assets/tenues.json "$TARGET/assets/"
for dir in assets/*/; do
    name="$(basename "$dir")"
    mkdir -p "$TARGET/assets/$name"
    cp "$dir"/*.png "$TARGET/assets/$name/"
done

echo "installed to $TARGET"
