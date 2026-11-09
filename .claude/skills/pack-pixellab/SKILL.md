---
name: pack-pixellab
description: Dessine un pack de sprites pour Crêpe avec PixelLab (MCP officiel ou interface web), depuis une description ou un PNG existant, puis le décrit et le vérifie avec scripts/pack.py. À utiliser quand on veut un autre personnage que Crêpe sur le bureau.
---

# Un pack de sprites avec PixelLab

Le format cible est celui de `PACKS.md` : des PNG 80×80, le corps dans le
cadre (20 px transparents en haut, 12 en bas, 12 de chaque côté), des
dossiers nommés d'après la table des animations. Lis `PACKS.md` avant de
commencer, c'est le contrat ; ce skill dit seulement comment obtenir les
images.

## Avant tout

1. Le MCP PixelLab doit être branché. Vérifie qu'un outil `get_balance` ou
   `create_character` est disponible. Sinon, donne la commande et arrête-toi
   là, ou propose la variante à la main (dernière section) :

   ```sh
   claude mcp add pixellab https://api.pixellab.ai/mcp -t http -H "Authorization: Bearer <token>"
   ```

   Le token vient de la page de connexion de pixellab.ai. Le palier gratuit
   n'est pas documenté : appelle `get_balance` avant de générer et dis le
   solde ; un pack complet, c'est une vingtaine d'animations, donc une
   vingtaine de générations. Arrête-toi et demande si le solde ne suit pas.
2. Demande ce qui manque, en une fois : l'identifiant du pack (minuscules,
   ex. `poireau`), le nom affiché, le mot de sa langue, l'auteur, et le point
   de départ : une description du personnage, ou le chemin d'un PNG existant.
3. Crée le dossier avec les réponses (le script est interactif, on lui passe
   les réponses sur l'entrée standard) :

   ```sh
   printf '%s\n%s\n%s\n%s\n' "Poireau" "poireau" "Léa" "Un poireau pressé" \
     | scripts/pack.py init ~/.local/share/crepe/packs/poireau
   ```

Ne regénère jamais une image que l'auteur a déjà dessinée ou validée sans
le demander. Garde tout en 80×80 : si un outil ne sort pas cette taille,
dis-le au lieu de redimensionner en douce.

## La pose de repos, puis validation

Tout le pack dérive de `attente/attente_00.png`. Elle doit être validée à
l'écran avant la suite.

- **Depuis une description** : `create_character` (ou l'outil « pro » qui
  accepte 80×80 ; les anciens outils plafonnent à 64×64, ce qui ne convient
  pas). Prompt type, en anglais, à compléter avec la description :
  `"<description>, pixel art, front view, single character, centered, 1px dark
  outline, flat colors, transparent background, body fits in a 56x48 box"`.
- **Depuis un PNG** : `image_to_pixelart` s'il n'est pas déjà en pixel art,
  puis un recadrage à 80×80 avec le corps dans le cadre. Pour ce recadrage,
  pas de PIL : un petit script Python avec `zlib`/`struct`, comme
  `scripts/pack.py` le fait (`pixels_png`, `ecrit_png`), ou `inpaint_image`
  pour étendre le fond.

Puis :

```sh
scripts/pack.py check <dossier>
```

Il dira `animations.json manque`, c'est attendu à ce stade, mais il compte
aussi les pixels hors cadre de `attente_00.png` : zéro, ou on recadre.
Montre l'image à l'auteur (lis le PNG) et attends son accord.

## Le minimum : clignement et marche

- `clignement/` : quatre images sur la pose de repos, `[ouverts, mi-clos,
  fermés, mi-clos]`. L'image 0 est `attente_00.png` tel quel. Pour « fermés »,
  `edit_image` ou `inpaint_image` sur la zone des yeux avec `"eyes closed,
  same pose, nothing else changes"` ; « mi-clos » se dérive à la main ou par
  un second inpaint. Vérifie que seuls les yeux ont bougé (compare les pixels
  hors zone des yeux avec l'image 0 ; s'ils diffèrent, recopie-les depuis
  l'image 0).
- `marche_droite/` : `animate_character` ou `animate_image` sur la pose de
  repos, `"walking to the right, in place, side-stepping, 9 frames, loop"`.
  Le personnage reste au même endroit dans l'image : c'est l'extension qui le
  déplace. Pas besoin de `marche_gauche`, l'extension retourne l'image.

```sh
scripts/pack.py animations <dossier>
scripts/pack.py check <dossier>
```

À ce stade le pack est valide et utilisable. Propose de l'essayer avant
d'aller plus loin : page « Apparence » des préférences, ou

```sh
gsettings set org.gnome.shell.extensions.crepe sprite-pack <id>
```

## Les animations optionnelles, dans l'ordre utile

Une génération chacune, avec `animate_character`/`animate_image` sur la
pose de repos, 9 images sauf mention, et le même rituel après chaque lot :
`pack.py animations`, `pack.py check`, montrer, corriger les yeux.

| Dossier | Prompt (anglais) | Note |
| --- | --- | --- |
| `sursaut` | `startled jump, surprised, lands back in rest pose` | Déclenche aussi la plupart des réactions quand les autres manquent |
| `facepalm` | `facepalm, hand (or limb) on face, dismayed, back to rest pose` | Si pas de main : la tête qui tombe en avant |
| `pouce` | `thumbs up, pleased, back to rest pose` | Un équivalent : un hochement, une feuille levée |
| `endormie` | `falling asleep, eyes closing, slumping, then slow breathing` | Les 4 dernières images bouclent ; `pack.py` règle `boucle_fin` |
| `coucou` | `waving hello, friendly, back to rest pose` | |
| `baillement` | `big yawn, mouth open, back to rest pose` | |
| `soupir` | `sighing, shoulders drop, back to rest pose` | |
| `respiration` | `breathing in and out gently, subtle` | |
| `regard_droite` / `regard_gauche` | `glancing to the right (left), eyes only, back to center` | 6 images |
| `pointer` | `pointing to the right with one limb, holds, back to rest pose` | Vers la droite seulement |
| `tapote` | `tapping impatiently, looping` | Boucle |
| `chut` | `shushing, limb to mouth, holds, back to rest pose` | |
| `gratter` | `scratching head, puzzled, back to rest pose` | |
| `applaudissement` | `slow sarcastic clapping` | |
| `menace`, `menace_tenue`, `menace_clignement`, `menace_rangee` | `pulls out a <objet>, threatening swing, ends holding it` | Les quatre ou rien. `menace_tenue` = dernière image de `menace` ; `menace_clignement` = clignement dessus ; `menace_rangee` = `menace` à l'envers |

Les poses `yeux_*` (huit directions, une image chacune) se font sans
PixelLab : déplacer les pixels des yeux de `attente_00.png` de deux pixels
de côté, un en haut ou en bas, comme `scripts/make-eyes.py` pour Crêpe.
Demande à l'auteur les coordonnées des yeux (ou lis-les sur l'image) et
écris les huit PNG avec `zlib`/`struct`. Idem pour `menace_yeux_*` sur
`menace_tenue_00.png` si la menace existe.

## Les yeux qui dérivent

PixelLab redessine chaque image et les yeux changent d'une image à
l'autre (plus petits, des sourcils en plus). Après chaque animation, pour
les images où le personnage est au repos ou presque, compare la zone des
yeux avec `attente_00.png` et recopie-la quand elle a dérivé sans raison.
`scripts/restore-face.py` fait cela pour Crêpe avec PIL et ses
coordonnées ; adapte les coordonnées, ou refais-le en Python standard.

## Pour finir

- `scripts/pack.py check <dossier>` une dernière fois : lis les notes à
  l'auteur, c'est ce que le personnage fera autrement.
- Propose `repliques.json` si l'auteur veut des phrases à lui (format dans
  `PACKS.md`), sinon les génériques servent.
- Ne touche ni au dépôt de Crêpe ni à `assets/` : un pack vit dans
  `~/.local/share/crepe/packs/`.

## Sans MCP : à la main dans l'interface web

Même recette, même table de prompts, dans pixellab.ai : créer le
personnage à 80×80, une animation par ligne, exporter les images une par
une (ou la planche, puis la découper en 80×80 avec un script Python
standard) dans `<dossier>/<animation>/<animation>_NN.png`. Puis les deux
commandes `pack.py animations` et `pack.py check`, et la page
« Apparence » des préférences.
