"""Types « Ovoko uniquement » : lit la nomenclature GRAVÉE en LECTURE SEULE (colonne « Ovoko uniquement » = Oui)
et écrit supabase\\donnees\\scan_test_types_ovoko_uniquement.sql (table scan_test_types_ovoko_uniquement uniquement).
Usage : python -I outils\\generer_types_ovoko.py
"""
import os, sys
ICI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ICI)
import lire_xlsx as x

SOURCE = os.path.abspath(os.path.join(ICI, "..", "..", "..", "Suivi", "01_ID_Interne", "Types_Pieces",
                                      "Nomenclature_ID_Interne_GRAVEE_2026-10-10.xlsx"))
SORTIE = os.path.join(ICI, "..", "supabase", "donnees", "scan_test_types_ovoko_uniquement.sql")


def main():
    lignes = [r for r in x.lignes(*x.feuilles(SOURCE)["Nomenclature"]) if any(c not in (None, "") for c in r)]
    entete = lignes[1]
    col = {n: i for i, n in enumerate(entete)}
    types = []
    for r in lignes[2:]:
        r = r + [None] * len(entete)
        if (r[col["Ovoko uniquement"]] or "").strip() == "Oui":
            types.append((str(int(r[col["Numéro (NNN)"]])), r[col["Nom complet de la pièce"]].strip()))
    q = lambda v: "'" + v.replace("'", "''") + "'"
    sql = ["-- Types « Ovoko uniquement » — généré par outils/generer_types_ovoko.py (ne pas modifier à la main).",
           "-- Source (lecture seule) : Suivi/01_ID_Interne/Types_Pieces/Nomenclature_ID_Interne_GRAVEE_2026-10-10.xlsx,",
           "-- onglet « Nomenclature », colonne « Ovoko uniquement » = Oui. Validé par Ruben le 19/10/2026.",
           "-- Table scan_test_types_ovoko_uniquement UNIQUEMENT. Idempotent. Une transaction.",
           "begin;",
           "insert into public.scan_test_types_ovoko_uniquement (code_piece, libelle) values",
           ",\n".join(f"  ({q(c)}, {q(n)})" for c, n in types),
           "on conflict (code_piece) do nothing;",
           "commit;", ""]
    with open(SORTIE, "w", encoding="utf-8", newline="\n") as h:
        h.write("\n".join(sql))
    print(f"{len(types)} types -> {os.path.normpath(SORTIE)}")
    for c, n in types:
        print(f"  {c.zfill(3)} {n}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
