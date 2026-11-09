# Packs de sprites

Crêpe est le personnage par défaut. Un pack remplace son dessin par un
autre : un poireau, un chat, ce que tu veux, dessiné en pixel art 80×80.
L'extension garde tout son comportement (elle s'endort, elle boude, elle
commente) et joue les animations du pack à la place de celles de Crêpe.
Ce qu'un pack ne dessine pas, elle s'en passe.

## En deux mots

1. À la racine du clone de Crêpe, `./pack poireau` (Python 3 suffit).
   `poireau` est l'identifiant du pack, en minuscules. Le script pose
   quatre questions (nom affiché, mot répété, auteur, description) et
   crée `~/.local/share/crepe/packs/poireau/` avec `pack.json`, le
   gabarit et les trois dossiers obligatoires, vides.
2. Dessine les images 80×80 dans le cadre du gabarit et dépose-les en
   `attente/attente_00.png`, `clignement/clignement_00.png`… (voir la
   table plus bas pour les noms et le nombre d'images).
3. `./pack poireau` à nouveau : il écrit `animations.json` d'après les
   images présentes, vérifie le tout et dit ce qu'elle fera autrement.
   Recommence après chaque ajout d'images.
4. Dans les préférences, page « Apparence », choisis le pack. Le
   changement est immédiat.

`scripts/pack.py` fait la même chose en trois sous-commandes (`init`,
`animations`, `check`) sur un dossier de ton choix, pour qui veut la
main sur chaque étape.

Le minimum pour qu'un pack soit accepté : `attente` (1 image),
`clignement` (le clignement sur cette pose) et `marche_droite`. Tout le
reste est optionnel.

## Le dossier

```
~/.local/share/crepe/packs/<id>/      <id> : minuscules, chiffres, - et _
  pack.json                           obligatoire
  animations.json                     obligatoire (`./pack` l'écrit)
  attente/attente_00.png              obligatoire
  clignement/clignement_00.png …      obligatoire
  marche_droite/marche_droite_00.png …obligatoire
  <autres animations>/…               optionnel
  repliques.json                      optionnel : ses phrases à lui
  tenues.json, tenues/*.png           optionnel : ses tenues
  encre/encre_0.png … encre_3.png     optionnel : ses taches quand il est furieux
  icone.png                           optionnel : l'icône du bouton des réglages rapides
```

`$XDG_DATA_HOME` remplace `~/.local/share` s'il est défini. Le bouton
« Ouvrir » des préférences ouvre ce dossier et le crée au besoin.

### pack.json

```json
{
  "nom": "Poireau",
  "mot": "poireau",
  "auteur": "Léa",
  "description": "Un poireau qui trouve que tout va trop vite."
}
```

- `nom` : ce que le menu, le bouton des réglages rapides et les
  préférences affichent à la place de « Crêpe ». 30 caractères au plus.
- `mot` : un seul mot en minuscules. Dans sa langue, chaque mot d'une
  phrase devient celui-là, comme Crêpe dit « Crêpe crêpe, crêpe. » : ici
  « Poireau poireau, poireau. », avec la phrase lisible en petit dessous.
- `auteur`, `description` : facultatifs, affichés dans les préférences.

## Le cadre

Chaque image fait 80×80 pixels, fond transparent. Le corps en pose de
repos tient dans un cadre fixe : 20 pixels transparents en haut, 12 en
bas, 12 de chaque côté, soit une zone de 56×48 pour le personnage.
`./pack <id>` dépose `gabarit.png` avec ce cadre en rouge : garde-le
sous ton calque de dessin.

Pourquoi : la zone cliquable est ce cadre et pas l'image entière, pour
ne pas voler les clics des fenêtres ; la bulle se pose au-dessus de lui ;
quand il se cache derrière le bord de l'écran, c'est ce cadre qui dépasse.
Un dessin qui déborde marche quand même, mais tout ça sera décalé.
`./pack <id>` compte les pixels hors cadre de `attente_00.png` et le dit.

Les gestes peuvent sortir du cadre (un bras qui pointe, un saut) : seule
la pose de repos compte.

Style conseillé, pour ressembler au reste du bureau : aplats sans
anti-aliasing, un contour sombre d'un pixel, une palette courte. Rien
n'est imposé.

## Les animations

Les noms sont le contrat : l'extension cherche ces dossiers-là, et ignore
les autres. Chaque animation est une suite d'images `<nom>_00.png`,
`<nom>_01.png`… dans le dossier `<nom>/`. Le nombre d'images est libre ;
« images » ci-dessous est celui de Crêpe, qui marche bien. Les durées par
image et la boucle vivent dans `animations.json` (voir plus bas).

Obligatoires :

| Nom | Images | Boucle | Ce qu'elle montre |
| --- | --- | --- | --- |
| `attente` | 1 | oui | La pose de repos, immobile. Tout part de là et y revient |
| `clignement` | 4 | non | Les yeux qui se ferment et se rouvrent, dessinés sur `attente`. Joué toutes les quelques secondes |
| `marche_droite` | 9 | oui | Le déplacement vers la droite, en boucle, sur place dans l'image (c'est l'extension qui le déplace) |

Optionnelles, avec ce qu'elle fait quand elles manquent :

| Nom | Images | Boucle | Ce qu'elle montre, quand | Si absente |
| --- | --- | --- | --- | --- |
| `marche_gauche` | 9 | oui | Le déplacement vers la gauche | Miroir de `marche_droite` |
| `respiration` | 9 | non | Une respiration, de temps en temps au repos | Pas ce gigotement |
| `soupir` | 9 | non | Un soupir, de temps en temps au repos | Pas ce gigotement |
| `baillement` | 9 | non | Un bâillement : au repos, et pour proposer une pause | Pas ce gigotement ; la pause est une phrase seule |
| `endormie` | 9 | non | Il s'endort ; `boucle_fin` dit quelles images bouclent ensuite (la respiration du sommeil) | Il dort en pose `attente`, sans cligner |
| `coucou` | 9 | non | Un salut quand tu reviens au clavier | La phrase seule |
| `sursaut` | 9 | non | Un sursaut : une notification arrive | Un clignement à la place |
| `facepalm` | 9 | non | Il se prend la tête : une erreur, un plantage | Joue `sursaut` |
| `pouce` | 9 | non | Un pouce levé, ou l'équivalent : une réussite | Joue `sursaut` |
| `applaudissement` | 9 | non | Un applaudissement lent, ironique : une réussite après trois erreurs | Joue `pouce` |
| `gratter` | 9 | non | Il se gratte la tête : la même erreur pour la troisième fois | Joue `facepalm` |
| `tapote` | 9 | oui | Il tapote d'impatience, en boucle, devant un chargement qui traîne | Pas d'impatience |
| `chut` | 9 | non | Un doigt (une feuille, un bras) devant la bouche : les notifications viennent d'être coupées | La phrase seule |
| `pointer` | 9 | non | Il pointe vers la **droite** : une fenêtre ou une bannière de ce côté. L'extension le retourne pour la gauche | Un sursaut à la place |
| `regard_droite` | 6 | non | Un coup d'œil vers la droite, vers la souris | Pas de geste |
| `regard_gauche` | 6 | non | Un coup d'œil vers la gauche | Pas de geste |

La bouderie avec quelque chose en main, tout ou rien (les quatre, ou
aucune) :

| Nom | Images | Boucle | Ce qu'elle montre |
| --- | --- | --- | --- |
| `menace` | 9 | non | Il sort quelque chose et menace, une fois, quand on l'embête trop. La dernière image est la pose `menace_tenue` |
| `menace_tenue` | 1 | oui | La pose de repos de la bouderie : la menace gardée en main |
| `menace_clignement` | 4 | non | Le clignement sur `menace_tenue` |
| `menace_rangee` | 9 | non | La fin de la bouderie : il range ce qu'il tenait (`menace` à l'envers marche très bien) |

Sans les quatre, il boude en pose `attente`, et les phrases de bouderie
restent.

Les yeux qui suivent la souris, tout ou rien par pose (les huit
directions, ou aucune) :

| Nom | Images | Boucle | Ce qu'elle montre |
| --- | --- | --- | --- |
| `yeux_nord`, `yeux_nord_est`, `yeux_est`, `yeux_sud_est`, `yeux_sud`, `yeux_sud_ouest`, `yeux_ouest`, `yeux_nord_ouest` | 1 | oui | `attente` avec les deux yeux décalés vers cette direction (deux pixels de côté, un en haut ou en bas, un de chaque sur les diagonales) |
| `menace_yeux_<direction>` | 1 | oui | Pareil sur `menace_tenue` ; seulement si la menace est là |

Sans elles, les yeux restent droits et le réglage « Suit la souris des
yeux » est grisé. Pour Crêpe elles sont dérivées de la pose de repos par
`scripts/make-eyes.py` (il déplace les pixels des yeux, dont il connaît
les coordonnées) ; adapte ses constantes à ton dessin si tu veux les
générer plutôt que les dessiner.

Les durées : `./pack <id>` met celles de Crêpe par défaut (130 ms
par image pour un geste, 1000 pour une pose fixe, `[40, 60, 110, 60]` pour
un clignement). Un geste qui doit marquer une pause (le facepalm tenu, le
sursaut en l'air) se règle en allongeant l'image concernée dans
`animations.json` :

```json
"facepalm": {
  "images": 9,
  "taille": "80x80",
  "durees_ms": [130, 130, 130, 130, 130, 800, 130, 130, 130],
  "boucle": false,
  "usage": "Erreur, plantage"
}
```

`boucle_fin` (sur `endormie`) donne la première et la dernière image, à
partir de 1, qui bouclent une fois l'animation jouée.

## Les phrases

Sans `repliques.json`, il dit les phrases génériques de l'extension
(`assets/repliques_generiques.json`) : les mêmes événements que Crêpe,
écrits sans pieuvre, sans tentacule et sans batte, à la première personne
et sans accord de genre. Avec un `repliques.json`, chaque événement
présent remplace la liste générique ; les absents gardent la générique ;
les clés inconnues sont ignorées.

```json
{
  "clic": ["Quoi.", "Je pousse, là.", "Encore toi."],
  "erreur": ["Ça a fané.", "Classique.", "Relance, on verra."]
}
```

Les événements et ce qu'ils disent sont la liste `VOICE_EVENTS` de
`src/voice.ts` ; les valeurs entre accolades (`{heure}`, `{titre}`,
`{texte}`, `{tickets}`, `{quand}`, `{jour}`, `{nombre}`, `{resume}`,
`{notifs}`, `{erreurs}`, `{succes}`, `{clics}`, `{nudges}`) et leur usage
sont décrits dans le README, section « What she does ». Une liste doit
avoir au moins une phrase ; `./pack <id>` relève les valeurs inconnues
et les phrases de plus de 90 caractères.

Pour la voix, les règles de Crêpe valent pour tout le monde : court, sec,
en français, sans emoji, un point d'exclamation au plus. Il se moque du
build, pas de la personne.

## Tenues, encre, icône

- **Tenues** : un `tenues.json` au format du README (section « Tenues »)
  et des PNG 80×80 dans `tenues/`, dessinés sur les coordonnées de **ta**
  pose de repos. Les six tenues de Crêpe sont connues (`masque_nuit`,
  `bonnet`, `lunettes`, `chapeau_fete`, `verre`, `transat`) ; décris
  celles que tu veux, les autres ne seront jamais portées. Sans le
  fichier, pas de tenues, et le groupe « Tenues » des préférences est grisé.
- **Encre** : quatre PNG `encre/encre_0.png` à `encre_3.png` de 48, 64, 80
  et 96 pixels, ce qu'il projette quand il est furieux. Sans le dossier,
  rien n'est projeté et le réglage est grisé. Les phrases `encre` restent
  (« Tiens, ça éclabousse. »).
- **Icône** : `icone.png`, affichée dans le bouton des réglages rapides.
  Sans elle, celle de Crêpe.

## Ce qui se passe si quelque chose cloche

Un pack que l'extension ne peut pas charger (pas de `pack.json`, une
animation obligatoire absente, une image manquante, un JSON cassé) ne la
casse jamais : Crêpe s'affiche à la place, la raison va dans le journal
(`journalctl --user -f -o cat /usr/bin/gnome-shell`, lignes « Crêpe: »)
et dans la ligne « État » des préférences. `./pack <id>` dit la même
chose avant d'essayer.

## Avec PixelLab

Les sprites de Crêpe viennent de PixelLab. Pour un pack, la recette est
la même : un personnage 80×80 vu de face, puis une animation par ligne de
la table, exportée image par image dans le dossier du bon nom. Un skill
pour Claude Code, dans `.claude/skills/pack-pixellab/`, pilote PixelLab
par son MCP et enchaîne `./pack` ; il décrit aussi la marche à suivre à
la main dans l'interface web. PixelLab a tendance à redessiner les yeux
d'une image à l'autre : vérifie-les, et remets ceux de la pose de repos
quand ils ont bougé.
