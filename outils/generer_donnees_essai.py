"""Données d'essai SCAN : portes du STOCK 16 (statut « attendue ») + une dizaine d'emplacements FICTIFS.
Lit (en lecture seule) Suivi\\04_Creation_Annonces\\Arrivage_STOCK16\\ID_Portes_STOCK16_2026-10-15_v2.xlsx (sinon la v1)
et écrit supabase\\donnees\\scan_test_donnees.sql (insertions idempotentes dans les tables scan_test_* uniquement).
Usage : python -I outils\\generer_donnees_essai.py
"""
import os, sys
ICI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ICI)
import lire_xlsx as x

RACINE = os.path.abspath(os.path.join(ICI, "..", "..", ".."))
DOSSIER = os.path.join(RACINE, "Suivi", "04_Creation_Annonces", "Arrivage_STOCK16")
SORTIE = os.path.join(ICI, "..", "supabase", "donnees", "scan_test_donnees.sql")

# Emplacements d'essai FICTIFS (local « L9 » = essai ; le dépôt réel est en réorganisation)
EMPLACEMENTS = [
    ("L9", "local", None), ("L9-R01", "rangee", "L9"), ("L9-R01-E1", "etage", "L9-R01"),
    ("L9-R01-E1-B01", "bac", "L9-R01-E1"), ("L9-R01-E1-B02", "bac", "L9-R01-E1"),
    ("L9-R01-E2", "etage", "L9-R01"), ("L9-R01-E2-B01", "bac", "L9-R01-E2"),
    ("L9-R02", "rangee", "L9"), ("L9-R02-E1", "etage", "L9-R02"), ("L9-R02-E1-B01", "bac", "L9-R02-E1"),
    ("ESSAI-RESERVE", "reserve", None),
]


def q(v):
    return "null" if v in (None, "") else "'" + str(v).replace("'", "''") + "'"


def main():
    source = None
    for nom in ("ID_Portes_STOCK16_2026-10-15_v2.xlsx", "ID_Portes_STOCK16_2026-10-15.xlsx"):
        if os.path.exists(os.path.join(DOSSIER, nom)):
            source = nom
            break
    if not source:
        sys.exit("Fichier STOCK 16 introuvable")
    f = x.feuilles(os.path.join(DOSSIER, source))
    ids = [r for r in x.lignes(*f["ID internes"]) if any(c not in (None, "") for c in r)]
    entete, ids = ids[0], ids[1:]
    col = {n: i for i, n in enumerate(entete)}
    libelles = {}
    for r in x.lignes(*f["Liste annonces"]):
        if r and r[0] and "-" in str(r[0]) and len(r) > 3 and r[3]:
            libelles[r[0]] = r[3]

    signalements, lignes = [], []
    for r in ids:
        g = lambda n: (r[col[n]] if col[n] < len(r) else None) or ""
        idi, lot, code = g("ID interne").strip(), g("Lot").strip(), g("Code").strip()
        if idi != f"{lot}-{code}":
            signalements.append(f"ID {idi} ne correspond pas à lot-code ({lot}-{code}) : ignoré")
            continue
        if g("Statut") != "attendue":
            signalements.append(f"{idi} : statut source « {g('Statut')} » (chargé quand même en « attendue »)")
        libelle = libelles.get(idi) or (f"Porte {g('Porte')}" if g("Porte") else "")
        if not libelle:
            signalements.append(f"{idi} : libellé introuvable : laissé vide")
        lignes.append("(" + ", ".join(q(v) for v in (
            idi, lot, code, libelle, g("Porte"), g("Marque"), g("Modèle"), g("Année"), g("Motorisation"),
            g("Remarques"), f"STOCK16 {source}")) + ")")

    out = ["-- Données d'ESSAI SCAN — généré par outils/generer_donnees_essai.py (ne pas modifier à la main).",
           f"-- Source (lecture seule) : Suivi/04_Creation_Annonces/Arrivage_STOCK16/{source} — feuilles « ID internes » et « Liste annonces ».",
           "-- Tables scan_test_* UNIQUEMENT. Idempotent (on conflict do nothing). Une transaction.",
           "begin;", ""]
    out.append("-- Emplacements d'essai fictifs")
    for code, niveau, parent in EMPLACEMENTS:
        par = "null" if parent is None else f"(select id from public.scan_test_emplacements where code = {q(parent)})"
        out.append("insert into public.scan_test_emplacements (code, niveau_rang, parent_id, libelle, essai) "
                   f"select {q(code)}, (select rang from public.scan_test_config_niveaux where cle = {q(niveau)}), {par}, "
                   f"'Emplacement d''essai fictif', true where not exists (select 1 from public.scan_test_emplacements where code = {q(code)});")
    out.append("insert into public.scan_test_emplacements_historique (emplacement_id, action, nouveau_code, nouveau_parent_id, par_prenom) "
               "select e.id, 'creation', e.code, e.parent_id, 'chargement essai' from public.scan_test_emplacements e "
               "where e.essai and not exists (select 1 from public.scan_test_emplacements_historique h where h.emplacement_id = e.id);")
    out.append("")
    out.append(f"-- Portes du STOCK 16 au statut « attendue » ({len(lignes)} pièces)")
    out.append("insert into public.scan_test_pieces (id_interne, lot, code_piece, libelle, cote, marque, modele, annee, motorisation, remarques, source) values")
    out.append(",\n".join(lignes))
    out.append("on conflict (id_interne) do nothing;")
    out += ["", "commit;", ""]
    os.makedirs(os.path.dirname(SORTIE), exist_ok=True)
    with open(SORTIE, "w", encoding="utf-8", newline="\n") as h:
        h.write("\n".join(out))
    print(f"{len(lignes)} pièces, {len(EMPLACEMENTS)} emplacements d'essai -> {os.path.normpath(SORTIE)}")
    for s in signalements:
        print("SIGNALEMENT :", s)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
