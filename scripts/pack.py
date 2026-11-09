#!/usr/bin/env python3
"""Outil pour les packs de sprites : créer, décrire, vérifier.

    scripts/pack.py init <dossier>        pose les questions, écrit pack.json, crée les
                                          dossiers du minimum et le gabarit 80×80
    scripts/pack.py animations <dossier>  écrit animations.json d'après les PNG présents,
                                          en gardant les durées déjà réglées
    scripts/pack.py check <dossier>       vérifie le pack comme l'extension le fera et
                                          liste ce qu'elle fera différemment

Bibliothèque standard seulement : ni PIL ni GNOME. Les règles (animations
obligatoires, remplaçantes, groupes tout ou rien, cadre du corps) sont celles de
src/pack.ts ; les deux fichiers se tiennent ensemble. Le format d'un pack est
décrit dans PACKS.md.
"""
from __future__ import annotations

import json
import re
import struct
import sys
import zlib
from pathlib import Path

TAILLE = 80
# Pixels transparents autour du corps en pose de repos : haut, bas, côtés (src/pack.ts BODY_BOX).
CADRE_HAUT, CADRE_BAS, CADRE_COTE = 20, 12, 12

NOM_MAX = 30
MOT_MOTIF = re.compile(r"^[^\W\d_]+$")  # un mot, lettres seulement
ID_MOTIF = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
IMAGE_MOTIF = re.compile(r"^(?P<nom>[a-z_]+)_(?P<index>\d{2})\.png$")

OBLIGATOIRES = ["attente", "clignement", "marche_droite"]
REMPLACANTES = [
    ("sursaut", "clignement"),
    ("pointer", "sursaut"),
    ("facepalm", "sursaut"),
    ("pouce", "sursaut"),
    ("gratter", "facepalm"),
    ("applaudissement", "pouce"),
    ("endormie", "attente"),
]
MIROIRS = [("marche_gauche", "marche_droite")]
GESTES_OPTIONNELS = ["respiration", "soupir", "baillement", "coucou", "chut", "tapote", "regard_droite", "regard_gauche"]
GROUPE_MENACE = ["menace", "menace_tenue", "menace_clignement", "menace_rangee"]
DIRECTIONS = ["nord", "nord_est", "est", "sud_est", "sud", "sud_ouest", "ouest", "nord_ouest"]
GROUPES_YEUX = [("attente", "yeux"), ("menace_tenue", "menace_yeux")]


def poses_yeux(prefixe: str) -> list[str]:
    return [f"{prefixe}_{direction}" for direction in DIRECTIONS]


CONNUES = (
    OBLIGATOIRES
    + [animation for animation, _ in REMPLACANTES]
    + [animation for animation, _ in MIROIRS]
    + GESTES_OPTIONNELS
    + GROUPE_MENACE
    + [pose for _, prefixe in GROUPES_YEUX for pose in poses_yeux(prefixe)]
)

# Ce que chaque animation montre, et ses durées par défaut : (ms par image, boucle, usage).
# Les durées sont un point de départ ; animations.json se retouche à la main ensuite.
DEFAUTS: dict[str, tuple[int, bool, str]] = {
    "attente": (1000, True, "Pose de repos, une seule image : la pose par défaut, immobile"),
    "clignement": (60, False, "Clignement des yeux sur la pose de repos, toutes les quelques secondes"),
    "marche_droite": (130, True, "Déplacement vers la droite, en boucle"),
    "marche_gauche": (130, True, "Déplacement vers la gauche, en boucle (miroir de marche_droite si absente)"),
    "respiration": (150, False, "Une respiration, de temps en temps pendant l'attente"),
    "soupir": (160, False, "Un soupir, de temps en temps pendant l'attente"),
    "baillement": (160, False, "Un bâillement : pendant l'attente, et pour proposer une pause"),
    "endormie": (220, False, "S'endort ; les dernières images bouclent pendant le sommeil"),
    "coucou": (140, False, "Salue quand on revient au clavier"),
    "sursaut": (110, False, "Sursaute : une notification arrive"),
    "facepalm": (160, False, "Se prend la tête : une erreur, un plantage"),
    "pouce": (170, False, "Pouce levé : une tâche réussie"),
    "applaudissement": (160, False, "Applaudissement lent et ironique : un succès après plusieurs erreurs"),
    "gratter": (140, False, "Se gratte la tête : la même erreur pour la troisième fois"),
    "tapote": (110, True, "Tapote d'impatience, en boucle devant un chargement qui traîne"),
    "chut": (180, False, "Chut : les notifications viennent d'être coupées"),
    "pointer": (200, False, "Pointe vers la droite : une fenêtre ou une bannière de ce côté (le miroir sert pour la gauche)"),
    "regard_droite": (450, False, "Coup d'œil vers la droite, vers la souris"),
    "regard_gauche": (450, False, "Coup d'œil vers la gauche, vers la souris"),
    "menace": (160, False, "Menace, une fois, quand on l'embête trop ; finit sur la pose menace_tenue"),
    "menace_tenue": (1000, True, "Pose de repos de la bouderie, une seule image : la menace gardée en main"),
    "menace_clignement": (60, False, "Clignement sur la pose menace_tenue"),
    "menace_rangee": (140, False, "Fin de la bouderie : la menace rangée, la menace à l'envers"),
}
for _pose_repos, _prefixe in GROUPES_YEUX:
    for _direction in DIRECTIONS:
        DEFAUTS[f"{_prefixe}_{_direction}"] = (1000, True, f"Pose {_pose_repos}, les yeux tournés vers {_direction.replace('_', '-')}, une seule image")

CLIGNEMENT_DUREES = [40, 60, 110, 60]

EVENEMENTS = [
    "notification", "erreur", "succes", "retour", "clic", "endormissement", "matin", "soir", "vendredi",
    "commentaire", "agacee", "enervee", "boude", "menace_rangee", "deplacee", "retour_maison", "patience",
    "trop_de_notifs", "couche_tard", "pause", "musique", "silence", "impatience", "enfin", "fin_du_chut",
    "perplexe", "cerveau_absent", "cerveau_fatigue", "cerveau_panne", "depart", "retour_furieuse",
    "tache_terminee", "attention", "pipeline_echec", "ticket_nouveau", "tickets_ouverts", "travail_non_commite",
    "machine", "agenda", "commande_echec", "commande_longue", "fin_concentration", "reunion_fin_resume",
    "reunion_fin_rien", "esquive", "curieuse", "souris", "bilan", "tenue_fete", "tenue_vendredi", "tenue_hiver",
    "tenue_ete", "encre", "pense_bete", "pense_bete_relance", "pense_bete_ok", "pense_bete_incompris",
    "pense_bete_en_retard", "pense_bete_plein", "rappel_pipeline", "rappel_commandes", "rappel_bouderie",
    "rappel_focus", "bilan_semaine",
]
VALEURS = ["heure", "titre", "texte", "tickets", "notifs", "erreurs", "succes", "clics", "nudges", "resume", "quand", "jour", "nombre"]


class Rapport:
    """Erreurs (le pack sera refusé), avertissements (il marchera, mais) et notes (ce qu'elle fera autrement)."""

    def __init__(self) -> None:
        self.erreurs: list[str] = []
        self.avertissements: list[str] = []
        self.notes: list[str] = []

    def affiche(self) -> int:
        for erreur in self.erreurs:
            print(f"ERREUR  {erreur}")
        for avertissement in self.avertissements:
            print(f"ATTENTION  {avertissement}")
        for note in self.notes:
            print(f"note  {note}")
        if self.erreurs:
            print(f"\n{len(self.erreurs)} erreur(s) : l'extension refusera ce pack et gardera Crêpe.")
            return 1
        print("\nPack valide." + (" Elle fera tout." if not self.notes else f" {len(self.notes)} chose(s) qu'elle fera autrement, voir ci-dessus."))
        return 0


# ---------------------------------------------------------------- PNG, sans PIL

def taille_png(chemin: Path) -> tuple[int, int] | None:
    """Largeur et hauteur lues dans l'en-tête, ou None si ce n'est pas un PNG."""
    with chemin.open("rb") as fichier:
        entete = fichier.read(24)
    if len(entete) < 24 or entete[:8] != b"\x89PNG\r\n\x1a\n" or entete[12:16] != b"IHDR":
        return None
    largeur, hauteur = struct.unpack(">II", entete[16:24])
    return largeur, hauteur


def pixels_png(chemin: Path) -> tuple[int, int, int, bytes] | None:
    """(largeur, hauteur, canaux, octets) d'un PNG 8 bits RGB ou RGBA non entrelacé ; None pour les autres."""
    donnees = chemin.read_bytes()
    if donnees[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    position = 8
    largeur = hauteur = canaux = 0
    compresse = b""
    while position + 8 <= len(donnees):
        longueur, genre = struct.unpack(">I4s", donnees[position:position + 8])
        contenu = donnees[position + 8:position + 8 + longueur]
        position += 12 + longueur
        if genre == b"IHDR":
            largeur, hauteur, profondeur, couleur, _, _, entrelace = struct.unpack(">IIBBBBB", contenu)
            if profondeur != 8 or entrelace != 0 or couleur not in (2, 6):
                return None
            canaux = 3 if couleur == 2 else 4
        elif genre == b"IDAT":
            compresse += contenu
        elif genre == b"IEND":
            break
    brut = zlib.decompress(compresse)
    ligne = largeur * canaux
    sortie = bytearray()
    precedente = bytearray(ligne)
    for y in range(hauteur):
        debut = y * (ligne + 1)
        filtre = brut[debut]
        courante = bytearray(brut[debut + 1:debut + 1 + ligne])
        for i in range(ligne):
            a = courante[i - canaux] if i >= canaux else 0
            b = precedente[i]
            c = precedente[i - canaux] if i >= canaux else 0
            if filtre == 1:
                courante[i] = (courante[i] + a) & 255
            elif filtre == 2:
                courante[i] = (courante[i] + b) & 255
            elif filtre == 3:
                courante[i] = (courante[i] + (a + b) // 2) & 255
            elif filtre == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                courante[i] = (courante[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        sortie += courante
        precedente = courante
    return largeur, hauteur, canaux, bytes(sortie)


def ecrit_png(chemin: Path, largeur: int, hauteur: int, pixels: bytes) -> None:
    """Écrit un PNG RGBA 8 bits depuis des octets bruts, ligne par ligne, sans filtre."""
    def bloc(genre: bytes, contenu: bytes) -> bytes:
        return struct.pack(">I", len(contenu)) + genre + contenu + struct.pack(">I", zlib.crc32(genre + contenu) & 0xFFFFFFFF)

    ligne = largeur * 4
    brut = b"".join(b"\x00" + pixels[y * ligne:(y + 1) * ligne] for y in range(hauteur))
    chemin.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + bloc(b"IHDR", struct.pack(">IIBBBBB", largeur, hauteur, 8, 6, 0, 0, 0))
        + bloc(b"IDAT", zlib.compress(brut, 9))
        + bloc(b"IEND", b"")
    )


def pixels_hors_cadre(largeur: int, hauteur: int, canaux: int, pixels: bytes) -> int:
    if canaux < 4:
        return largeur * hauteur - (largeur - 2 * CADRE_COTE) * (hauteur - CADRE_HAUT - CADRE_BAS)
    compte = 0
    for y in range(hauteur):
        hors_ligne = y < CADRE_HAUT or y >= hauteur - CADRE_BAS
        for x in range(largeur):
            if not hors_ligne and CADRE_COTE <= x < largeur - CADRE_COTE:
                continue
            if pixels[(y * largeur + x) * canaux + 3] > 0:
                compte += 1
    return compte


def gabarit() -> bytes:
    """Le cadre du corps en traits rouges sur fond transparent, un damier léger au-dessus de la limite de la tête."""
    pixels = bytearray(TAILLE * TAILLE * 4)

    def pose(x: int, y: int, couleur: tuple[int, int, int, int]) -> None:
        if 0 <= x < TAILLE and 0 <= y < TAILLE:
            pixels[(y * TAILLE + x) * 4:(y * TAILLE + x) * 4 + 4] = bytes(couleur)

    rouge = (220, 40, 40, 255)
    gris = (128, 128, 128, 60)
    for x in range(CADRE_COTE, TAILLE - CADRE_COTE):
        pose(x, CADRE_HAUT, rouge)
        pose(x, TAILLE - CADRE_BAS - 1, rouge)
    for y in range(CADRE_HAUT, TAILLE - CADRE_BAS):
        pose(CADRE_COTE, y, rouge)
        pose(TAILLE - CADRE_COTE - 1, y, rouge)
    for y in range(TAILLE):
        for x in range(TAILLE):
            hors = y < CADRE_HAUT or y >= TAILLE - CADRE_BAS or x < CADRE_COTE or x >= TAILLE - CADRE_COTE
            if hors and (x + y) % 2 == 0:
                pose(x, y, gris)
    return bytes(pixels)


# ---------------------------------------------------------------- commandes

def commande_init(dossier: Path) -> int:
    if not ID_MOTIF.match(dossier.name):
        print(f"Le nom du dossier « {dossier.name} » doit être en minuscules, chiffres, « - » ou « _ » : c'est l'identifiant du pack.")
        return 1
    if (dossier / "pack.json").exists():
        print(f"{dossier / 'pack.json'} existe déjà ; rien n'est écrasé.")
        return 1
    print("Quelques questions ; Entrée garde la valeur entre crochets.")
    nom = demande("Nom du personnage", dossier.name.capitalize())
    mot = demande("Le mot qu'il répète à la place de chaque mot (un seul, en minuscules)", nom.lower())
    auteur = demande("Auteur (optionnel)", "")
    description = demande("Une ligne de description (optionnel)", "")
    rapport = Rapport()
    verifie_manifeste(dossier.name, {"nom": nom, "mot": mot, "auteur": auteur, "description": description}, rapport)
    if rapport.erreurs:
        rapport.affiche()
        return 1
    dossier.mkdir(parents=True, exist_ok=True)
    manifeste = {"nom": nom, "mot": mot}
    if auteur:
        manifeste["auteur"] = auteur
    if description:
        manifeste["description"] = description
    ecrit_json(dossier / "pack.json", manifeste)
    for animation in OBLIGATOIRES:
        (dossier / animation).mkdir(exist_ok=True)
    ecrit_png(dossier / "gabarit.png", TAILLE, TAILLE, gabarit())
    print(f"\nPack créé dans {dossier}/ :")
    print("  pack.json, gabarit.png (le cadre du corps, à garder sous le calque de dessin)")
    print("  " + ", ".join(f"{animation}/" for animation in OBLIGATOIRES) + " : les trois animations obligatoires, à remplir")
    print("\nDépose les PNG en <animation>/<animation>_00.png, _01.png… puis lance :")
    print(f"  scripts/pack.py animations {dossier}")
    print(f"  scripts/pack.py check {dossier}")
    print("PACKS.md décrit chaque animation.")
    return 0


def demande(question: str, defaut: str) -> str:
    reponse = input(f"{question} [{defaut}] : ").strip()
    return reponse or defaut


def commande_animations(dossier: Path) -> int:
    chemin = dossier / "animations.json"
    existantes: dict = {}
    if chemin.exists():
        existantes = json.loads(chemin.read_text(encoding="utf-8"))
        if not isinstance(existantes, dict):
            print(f"{chemin} n'est pas un objet JSON ; je ne le touche pas.")
            return 1
    trouvees = images_par_animation(dossier)
    if not trouvees:
        print(f"Aucun dossier d'animation avec des PNG nommés <nom>/<nom>_00.png dans {dossier}.")
        return 1

    resultat: dict = {}
    for nom, images in sorted(trouvees.items()):
        ancienne = existantes.get(nom)
        ms, boucle, usage = DEFAUTS.get(nom, (130, False, "À décrire : ce que montre cette animation"))
        if isinstance(ancienne, dict):
            durees = list(ancienne.get("durees_ms", []))
            durees = (durees + [ms] * len(images))[:len(images)]
            entree = {**ancienne, "images": len(images), "taille": f"{TAILLE}x{TAILLE}", "durees_ms": durees}
        else:
            durees = durees_par_defaut(nom, len(images), ms)
            entree = {"images": len(images), "taille": f"{TAILLE}x{TAILLE}", "durees_ms": durees, "boucle": boucle, "usage": usage}
            if nom == "endormie" and len(images) >= 2:
                entree["boucle_fin"] = [max(1, len(images) - 3), len(images)]
        resultat[nom] = entree
        if nom not in CONNUES:
            print(f"note  « {nom} » : l'extension ne connaît pas ce nom, elle l'ignorera (voir PACKS.md).")
    disparues = [nom for nom in existantes if nom not in trouvees]
    for nom in disparues:
        print(f"ATTENTION  « {nom} » est dans animations.json mais son dossier n'a plus d'image ; entrée retirée.")
    ecrit_json(chemin, resultat)
    print(f"{chemin} écrit : {len(resultat)} animation(s). Les durées se retouchent à la main.")
    return 0


def durees_par_defaut(nom: str, nombre: int, ms: int) -> list[int]:
    if nom in ("clignement", "menace_clignement") and nombre == len(CLIGNEMENT_DUREES):
        return list(CLIGNEMENT_DUREES)
    return [ms] * nombre


def images_par_animation(dossier: Path) -> dict[str, list[Path]]:
    trouvees: dict[str, list[Path]] = {}
    for sous_dossier in sorted(p for p in dossier.iterdir() if p.is_dir()):
        images = sorted(sous_dossier.glob(f"{sous_dossier.name}_??.png"))
        if images:
            trouvees[sous_dossier.name] = images
    return trouvees


def commande_check(dossier: Path) -> int:
    rapport = Rapport()
    if not dossier.is_dir():
        print(f"{dossier} n'est pas un dossier.")
        return 1
    if not ID_MOTIF.match(dossier.name):
        rapport.erreurs.append(f"le nom du dossier « {dossier.name} » doit être en minuscules, chiffres, « - » ou « _ »")

    manifeste = lit_json(dossier / "pack.json", rapport, obligatoire=True)
    if isinstance(manifeste, dict):
        verifie_manifeste(dossier.name, manifeste, rapport)
    elif manifeste is not None:
        rapport.erreurs.append("pack.json : un objet attendu")

    animations = lit_json(dossier / "animations.json", rapport, obligatoire=True)
    presentes: set[str] = set()
    if isinstance(animations, dict):
        presentes = verifie_animations(dossier, animations, rapport)
    elif animations is not None:
        rapport.erreurs.append("animations.json : un objet attendu")

    if presentes:
        passe_en_revue(presentes, rapport)
        verifie_cadre(dossier / "attente" / "attente_00.png", rapport)

    repliques = lit_json(dossier / "repliques.json", rapport, obligatoire=False)
    if isinstance(repliques, dict):
        verifie_repliques(repliques, rapport)
    elif repliques is not None:
        rapport.erreurs.append("repliques.json : un objet attendu")

    tenues = lit_json(dossier / "tenues.json", rapport, obligatoire=False)
    if isinstance(tenues, dict):
        verifie_tenues(dossier, tenues, presentes, rapport)

    encre = dossier / "encre"
    if encre.is_dir():
        for variante in range(4):
            if not (encre / f"encre_{variante}.png").exists():
                rapport.erreurs.append(f"encre/encre_{variante}.png manque (quatre tailles, 0 à 3, ou pas de dossier encre/)")
    icone = dossier / "icone.png"
    if icone.exists() and taille_png(icone) is None:
        rapport.erreurs.append("icone.png n'est pas un PNG")
    return rapport.affiche()


def lit_json(chemin: Path, rapport: Rapport, obligatoire: bool):
    if not chemin.exists():
        if obligatoire:
            rapport.erreurs.append(f"{chemin.name} manque")
        return None
    try:
        return json.loads(chemin.read_text(encoding="utf-8"))
    except (OSError, ValueError) as erreur:
        rapport.erreurs.append(f"{chemin.name} illisible : {erreur}")
        return None


def verifie_manifeste(identifiant: str, manifeste: dict, rapport: Rapport) -> None:
    nom = manifeste.get("nom")
    if not isinstance(nom, str) or not nom.strip():
        rapport.erreurs.append('pack.json : « nom » doit être une chaîne non vide')
    elif len(nom.strip()) > NOM_MAX:
        rapport.erreurs.append(f"pack.json : « nom » dépasse {NOM_MAX} caractères")
    mot = manifeste.get("mot")
    if not isinstance(mot, str) or not MOT_MOTIF.match(mot.strip()) or mot.strip() != mot.strip().lower():
        rapport.erreurs.append('pack.json : « mot » doit être un seul mot en minuscules, comme « crêpe »')
    for cle in ("auteur", "description"):
        if cle in manifeste and manifeste[cle] is not None and not isinstance(manifeste[cle], str):
            rapport.erreurs.append(f"pack.json : « {cle} » doit être une chaîne")


def verifie_animations(dossier: Path, animations: dict, rapport: Rapport) -> set[str]:
    presentes: set[str] = set()
    for nom, entree in animations.items():
        if not isinstance(entree, dict):
            rapport.erreurs.append(f"animations.json : « {nom} » doit être un objet")
            continue
        images = entree.get("images")
        durees = entree.get("durees_ms")
        if not isinstance(images, int) or images < 1:
            rapport.erreurs.append(f"{nom} : « images » doit être un entier ≥ 1")
            continue
        if not isinstance(durees, list) or len(durees) != images or not all(isinstance(d, int) and d > 0 for d in durees):
            rapport.erreurs.append(f"{nom} : « durees_ms » doit lister {images} durée(s) en millisecondes")
        if entree.get("taille") != f"{TAILLE}x{TAILLE}":
            rapport.erreurs.append(f"{nom} : « taille » doit être \"{TAILLE}x{TAILLE}\"")
        if not isinstance(entree.get("boucle"), bool):
            rapport.erreurs.append(f"{nom} : « boucle » doit être true ou false")
        fin = entree.get("boucle_fin")
        if fin is not None and not (isinstance(fin, list) and len(fin) == 2 and all(isinstance(i, int) for i in fin) and 1 <= fin[0] <= fin[1] <= images):
            rapport.erreurs.append(f"{nom} : « boucle_fin » doit être [première, dernière] entre 1 et {images}")
        for index in range(images):
            image = dossier / nom / f"{nom}_{index:02d}.png"
            if not image.exists():
                rapport.erreurs.append(f"{nom} : image manquante {image.relative_to(dossier)}")
                continue
            dimensions = taille_png(image)
            if dimensions is None:
                rapport.erreurs.append(f"{image.relative_to(dossier)} n'est pas un PNG")
            elif dimensions != (TAILLE, TAILLE):
                rapport.erreurs.append(f"{image.relative_to(dossier)} fait {dimensions[0]}×{dimensions[1]}, pas {TAILLE}×{TAILLE}")
        presentes.add(nom)
    for sous_dossier, images in images_par_animation(dossier).items():
        if sous_dossier not in animations:
            rapport.avertissements.append(f"le dossier {sous_dossier}/ a {len(images)} image(s) mais animations.json ne le décrit pas : lance « pack.py animations »")
    return presentes


def passe_en_revue(presentes: set[str], rapport: Rapport) -> None:
    """La revue de src/pack.ts : mêmes règles, mêmes phrases."""
    presentes = set(presentes)
    for nom in OBLIGATOIRES:
        if nom not in presentes:
            rapport.erreurs.append(f"animations.json n'a pas « {nom} » : une des {len(OBLIGATOIRES)} animations que tout pack doit avoir")
    if rapport.erreurs:
        return
    inconnues = sorted(nom for nom in presentes if nom not in CONNUES)
    if inconnues:
        rapport.avertissements.append("animations inconnues, ignorées : " + ", ".join(inconnues))

    def ecarte_groupe(groupe: list[str], note: str) -> None:
        la = [nom for nom in groupe if nom in presentes]
        if 0 < len(la) < len(groupe):
            presentes.difference_update(la)
            rapport.notes.append(note)

    ecarte_groupe(GROUPE_MENACE, f"Menace incomplète ({', '.join(GROUPE_MENACE)} vont ensemble) : elle boude sans rien tenir.")
    for pose_repos, prefixe in GROUPES_YEUX:
        poses = poses_yeux(prefixe)
        ecarte_groupe(poses, f"Poses {prefixe}_* incomplètes (les huit directions vont ensemble) : les yeux ne bougent pas en {pose_repos}.")
        if pose_repos not in presentes:
            presentes.difference_update(poses)

    for animation, miroir_de in MIROIRS:
        if animation not in presentes and miroir_de in presentes:
            presentes.add(animation)
            rapport.notes.append(f"Sans « {animation} », elle joue « {miroir_de} » en miroir.")

    remplacees: dict[str, str] = {}
    for animation, jouee_comme in REMPLACANTES:
        if animation in presentes:
            continue
        source = remplacees.get(jouee_comme, jouee_comme)
        if source not in presentes:
            continue
        remplacees[animation] = source
        presentes.add(animation)
        rapport.notes.append(f"Sans « {animation} », elle joue « {source} » à la place.")

    manquantes = [nom for nom in CONNUES if nom not in presentes]
    gestes = [nom for nom in manquantes if nom in GESTES_OPTIONNELS and nom != "tapote"]
    if gestes:
        rapport.notes.append("Sans " + ", ".join(f"« {nom} »" for nom in gestes) + " : pas de geste, la réplique seule.")
    if "tapote" in manquantes:
        rapport.notes.append("Sans « tapote » : pas d'impatience devant un chargement qui traîne.")
    if all(nom in manquantes for nom in GROUPE_MENACE):
        rapport.notes.append("Sans « menace » : elle boude en pose d'attente.")
    for pose_repos, prefixe in GROUPES_YEUX:
        if pose_repos in presentes and all(nom in manquantes for nom in poses_yeux(prefixe)):
            rapport.notes.append(f"Sans « {prefixe}_* » : les yeux ne suivent pas la souris en {pose_repos}.")


def verifie_cadre(image: Path, rapport: Rapport) -> None:
    if not image.exists():
        return
    decode = pixels_png(image)
    if decode is None:
        rapport.avertissements.append(f"{image.name} : PNG ni RGB ni RGBA 8 bits, le cadre du corps n'a pas pu être vérifié")
        return
    largeur, hauteur, canaux, pixels = decode
    hors = pixels_hors_cadre(largeur, hauteur, canaux, pixels)
    if hors:
        rapport.avertissements.append(
            f"{image.name} : {hors} pixel(s) opaque(s) hors du cadre du corps ({CADRE_HAUT} px en haut, {CADRE_BAS} en bas, {CADRE_COTE} de chaque côté) ; "
            "la zone cliquable, la bulle et la cachette seront décalées"
        )


def verifie_repliques(repliques: dict, rapport: Rapport) -> None:
    inconnues = sorted(cle for cle in repliques if cle not in EVENEMENTS)
    if inconnues:
        rapport.avertissements.append("repliques.json : événements inconnus, ignorés : " + ", ".join(inconnues))
    for evenement, lignes in repliques.items():
        if evenement not in EVENEMENTS:
            continue
        if not isinstance(lignes, list) or not lignes or not all(isinstance(ligne, str) and ligne for ligne in lignes):
            rapport.erreurs.append(f"repliques.json : « {evenement} » doit être une liste non vide de phrases")
            continue
        for ligne in lignes:
            for valeur in re.findall(r"\{([a-z]+)\}", ligne):
                if valeur not in VALEURS:
                    rapport.erreurs.append(f"repliques.json : « {evenement} » utilise {{{valeur}}}, inconnu (connus : {', '.join(VALEURS)})")
            if len(ligne) > 90 and "{" not in ligne:
                rapport.avertissements.append(f"repliques.json : « {evenement} » a une phrase de plus de 90 caractères : « {ligne[:40]}… »")


def verifie_tenues(dossier: Path, tenues: dict, presentes: set[str], rapport: Rapport) -> None:
    for identifiant, tenue in tenues.items():
        calques = tenue.get("calques") if isinstance(tenue, dict) else None
        if not isinstance(calques, list) or not calques:
            rapport.erreurs.append(f"tenues.json : « {identifiant} » doit avoir au moins un calque")
            continue
        for calque in calques:
            fichier = calque.get("fichier") if isinstance(calque, dict) else None
            if not isinstance(fichier, str) or not (dossier / fichier).exists():
                rapport.erreurs.append(f"tenues.json : « {identifiant} » : fichier manquant {fichier}")
            elif taille_png(dossier / fichier) != (TAILLE, TAILLE):
                rapport.erreurs.append(f"tenues.json : « {identifiant} » : {fichier} doit faire {TAILLE}×{TAILLE}")
            if isinstance(calque, dict) and calque.get("z") not in ("devant", "derriere"):
                rapport.erreurs.append(f"tenues.json : « {identifiant} » : « z » doit être « devant » ou « derriere »")
        for motif in (tenue.get("visible_pendant") or []) + (tenue.get("cache_pendant") or []):
            if not any(nom.startswith(motif[:-1]) if motif.endswith("*") else nom == motif for nom in presentes):
                rapport.erreurs.append(f"tenues.json : « {identifiant} » : « {motif} » ne correspond à aucune animation du pack")


def ecrit_json(chemin: Path, contenu: dict) -> None:
    chemin.write_text(json.dumps(contenu, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(arguments: list[str]) -> int:
    if len(arguments) != 2 or arguments[0] not in ("init", "animations", "check"):
        print(__doc__.strip())
        return 2
    dossier = Path(arguments[1]).resolve()
    return {"init": commande_init, "animations": commande_animations, "check": commande_check}[arguments[0]](dossier)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
