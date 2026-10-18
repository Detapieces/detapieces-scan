// Parité des règles page / base, emplacements paramétrables avec historique, étiquettes ZPL + PDF.
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { en, IDS, nouvelleBase, action, refuse } from "./aide_base.mjs";
import { ETATS_COMMERCIAUX, ETATS_PHYSIQUES, regle, TOUTES_ACTIONS } from "../docs/regles.js";
import { cylindree, pdfEmplacements, pdfPieces, pdfPlancheTest, textesPiece, zplEmplacement, zplPiece } from "../docs/etiquettes.js";
import { jsPDF } from "jspdf";
import qrcode from "qrcode-generator";

let db;
before(async () => { db = await nouvelleBase(); });

describe("règles : la page propose exactement ce que la base accepte", () => {
  test("toutes les combinaisons rôle × état physique × état commercial × décision × sortie × action", async () => {
    const roles = ["equipe", "annonces", "responsable", null];
    const r = (await db.query(`
      select ro.v as role, ph.v as phys, co.v as comm, de.v as dec, so.v as sortie, ac.v as act,
             scan_regle(ro.v, ph.v, co.v, de.v, so.v, ac.v) as err
        from unnest($1::text[]) ro(v), unnest($2::text[]) ph(v), unnest($3::text[]) co(v),
             unnest(array[null, 'republier']::text[]) de(v), unnest(array[null, 'commande', 'comptoir']::text[]) so(v),
             unnest($4::text[]) ac(v)`,
      [roles, Object.keys(ETATS_PHYSIQUES), Object.keys(ETATS_COMMERCIAUX), TOUTES_ACTIONS])).rows;
    assert.equal(r.length, 4 * 8 * 8 * 2 * 3 * 15);
    const ecarts = r.filter((x) => regle(x.role, x.phys, x.comm, x.dec, x.sortie, x.act) !== x.err);
    assert.deepEqual(ecarts.slice(0, 3), []);
  });
});

describe("emplacements paramétrables", () => {
  test("création conforme à la configuration ; refus si non conforme ou si pas responsable", async () => {
    const creer = (uid, code, niveau, parent) => en(db, uid, () => db.query("select scan_emplacement_creer($1, $2, $3) r", [code, niveau, parent]));
    await creer(IDS.ruben, "L9-R03", "rangee", "L9");
    await creer(IDS.ruben, "L9-R03-E1", "etage", "L9-R03");
    await creer(IDS.ruben, "l9-r03-e1-b01", "bac", "L9-R03-E1");
    await refuse(creer(IDS.ruben, "L9-R03-E1-B1", "bac", "L9-R03-E1"), "non conforme");
    await refuse(creer(IDS.ruben, "L9-R04-E1-B01", "bac", "L9-R03-E1"), "non conforme");
    await refuse(creer(IDS.ruben, "L9-R03-B01", "bac", "L9-R03"), "mauvais niveau");
    await creer(IDS.ruben, "PALETTE-12", "reserve", null);
    await refuse(creer(IDS.edward, "L9-R05", "rangee", "L9"), "réservée au responsable");
  });

  test("la configuration se règle en table, sans toucher au code (ex. bacs sur 3 chiffres)", async () => {
    await db.exec("update scan_test_config_niveaux set chiffres = 3 where cle = 'bac'");
    await en(db, IDS.ruben, () => db.query("select scan_emplacement_creer('L9-R03-E1-B002', 'bac', 'L9-R03-E1')"));
    await db.exec("update scan_test_config_niveaux set chiffres = 2 where cle = 'bac'");
  });

  test("renommer / déplacer garde l'historique ; les sous-emplacements et les pièces suivent ; les gestes gardent l'ancien code", async () => {
    const id = "50025891-156";
    await action(db, IDS.edward, id, "receptionner");
    await action(db, IDS.edward, id, "ranger", "L9-R03-E1-B01");
    await en(db, IDS.ruben, () => db.query("select scan_emplacement_modifier('L9-R03', 'L9-R07')"));
    const v = (await db.query("select emplacement from scan_test_pieces_vue where id_interne = $1", [id])).rows[0];
    assert.equal(v.emplacement, "L9-R07-E1-B01");
    const h = (await db.query("select action, ancien_code, nouveau_code from scan_test_emplacements_historique where ancien_code like 'L9-R03%' order by id")).rows;
    assert.deepEqual(h.map((x) => `${x.ancien_code}>${x.nouveau_code}`).sort(),
      ["L9-R03-E1-B002>L9-R07-E1-B002", "L9-R03-E1-B01>L9-R07-E1-B01", "L9-R03-E1>L9-R07-E1", "L9-R03>L9-R07"].sort());
    const ev = (await db.query("select emplacement_apres from scan_test_evenements where id_interne = $1 and action = 'rangement'", [id])).rows[0];
    assert.equal(ev.emplacement_apres, "L9-R03-E1-B01");
    // déplacement d'un étage vers une autre rangée
    await en(db, IDS.ruben, () => db.query("select scan_emplacement_modifier('L9-R07-E1', 'L9-R01-E3', 'L9-R01')"));
    assert.equal((await db.query("select emplacement from scan_test_pieces_vue where id_interne = $1", [id])).rows[0].emplacement, "L9-R01-E3-B01");
    assert.equal((await db.query("select action from scan_test_emplacements_historique order by id desc limit 1")).rows[0].action, "deplacement");
  });

  test("désactiver un emplacement non vide : refusé ; vide : permis, puis le rangement y est refusé", async () => {
    await refuse(en(db, IDS.ruben, () => db.query("select scan_emplacement_activer('L9-R01-E3-B01', false)")), "non vide");
    await en(db, IDS.ruben, () => db.query("select scan_emplacement_activer('L9-R02-E1-B01', false)"));
    await refuse(action(db, IDS.edward, "50025891-156", "ranger", "L9-R02-E1-B01"), "désactivé");
  });
});

describe("étiquettes Zebra ZD421 (203 dpi)", () => {
  const p = { id_interne: "50025891-155", libelle: "Porte avant gauche", modele: "RCZ", motorisation: "1.6 essence" };

  test("cylindrée commerciale ; cm³ gardés et signalés en cas de doute", () => {
    assert.deepEqual(cylindree("1.6 essence"), { texte: "1.6", doute: false });
    assert.deepEqual(cylindree("1248 cm3"), { texte: "1248 cm³", doute: true });
    assert.equal(textesPiece(p).vehicule, "RCZ · 1.6");
  });

  test("pièce 55 × 35 mm : QR = ID interne SEUL, à droite ID, pièce + côté, modèle · cylindrée", () => {
    const z = zplPiece(p);
    assert.match(z, /\^PW440/); assert.match(z, /\^LL280/);
    assert.match(z, /\^BQN,2,7\^FDMA,50025891-155\^FS/);
    assert.match(z, /\^FD50025891-155\^FS/); assert.match(z, /\^FDPorte avant gauche\^FS/); assert.match(z, /\^FDRCZ · 1\.6\^FS/);
    assert.match(z, /\^CI28/);
    assert.ok(z.startsWith("^XA") && z.endsWith("^XZ"));
  });

  test("emplacement 100 × 50 mm horizontal : QR = code SEUL, code en très gros", () => {
    const z = zplEmplacement("L9-R01-E1-B01");
    assert.match(z, /\^PW800/); assert.match(z, /\^LL400/);
    assert.match(z, /\^FDMA,L9-R01-E1-B01\^FS/);
    const h = Number(z.match(/\^A0N,(\d+)/)[1]);
    assert.ok(h >= 55 && h * 0.62 * 13 <= 480, `hauteur ${h}`);
    assert.ok(Number(zplEmplacement("L9").match(/\^A0N,(\d+)/)[1]) === 200);
  });

  test("caractères spéciaux ZPL échappés", () => {
    assert.match(zplPiece({ ...p, libelle: "Porte ^ test_1" }), /\^FDPorte _5E test_5F1\^FS/);
  });

  test("aperçus PDF : une page par étiquette, au format réel ; planche de test A4", () => {
    const d = pdfPieces(jsPDF, qrcode, [p, { ...p, id_interne: "50025891-156", libelle: "Porte avant droite" }]);
    assert.equal(d.getNumberOfPages(), 2);
    const w = d.internal.pageSize.getWidth(), h = d.internal.pageSize.getHeight();
    assert.deepEqual([Math.round(w), Math.round(h)], [55, 35]);
    const e = pdfEmplacements(jsPDF, qrcode, ["L9", "L9-R01-E1-B01"]);
    assert.deepEqual([Math.round(e.internal.pageSize.getWidth()), Math.round(e.internal.pageSize.getHeight())], [100, 50]);
    assert.equal(pdfPlancheTest(jsPDF, qrcode, [p], ["L9"]).getNumberOfPages(), 1);
  });
});
