// Types « Ovoko uniquement » (nomenclature gravée) : mention affichée pour ces types, rien ne change pour les autres.
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { action, IDS, nouvelleBase, piece } from "./aide_base.mjs";
import { actionsPossibles } from "../docs/regles.js";

let db;
before(async () => {
  db = await nouvelleBase();
  await db.exec(readFileSync(new URL("../supabase/donnees/scan_test_types_ovoko_uniquement.sql", import.meta.url), "utf8"));
  // pièces FICTIVES (base hors ligne seulement) : airbag volant, ceinture avant gauche, volant de direction
  await db.exec(`insert into scan_test_pieces (id_interne, lot, code_piece, libelle) values
    ('50025891-503', '50025891', '503', 'Airbag volant (conducteur)'),
    ('50025891-505', '50025891', '505', 'Ceinture de sécurité avant gauche'),
    ('50025891-500', '50025891', '500', 'Volant de direction')`);
});

describe("types « Ovoko uniquement »", () => {
  test("23 codes chargés, tous issus de la nomenclature gravée", async () => {
    const r = (await db.query("select code_piece from scan_test_types_ovoko_uniquement order by code_piece::int")).rows.map((x) => x.code_piece);
    assert.deepEqual(r, ["202", "312", "419", "501", "502", "503", "505", "506", "508", "515", "516", "517", "523", "524", "525",
                         "539", "540", "541", "542", "543", "544", "547", "548"]);
  });

  test("airbag et ceinture : mention « Ovoko uniquement » (par le type, sans marqueur sur la pièce)", async () => {
    for (const id of ["50025891-503", "50025891-505"]) {
      const p = await piece(db, id);
      assert.equal(p.ovoko_uniquement, true, id);
      assert.equal(p.ovoko_uniquement_type, true, id);
      assert.equal(p.ovoko_uniquement_marque, false, id);
    }
  });

  test("volant de direction (500) et portes : pas de mention", async () => {
    assert.equal((await piece(db, "50025891-500")).ovoko_uniquement, false);
    const n = (await db.query("select count(*)::int n from scan_test_pieces_vue where ovoko_uniquement and code_piece not in ('503', '505')")).rows[0].n;
    assert.equal(n, 0);
  });

  test("information seulement : les gestes de scan restent les mêmes", async () => {
    const p = await piece(db, "50025891-503");
    const porte = await piece(db, "50025891-155");
    assert.deepEqual(actionsPossibles("equipe", p), actionsPossibles("equipe", porte));
    assert.equal((await action(db, IDS.edward, "50025891-503", "receptionner")).physique, "receptionnee");
  });
});
