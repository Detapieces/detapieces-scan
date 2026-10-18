// TOUT le circuit retour + robot de scan en veille : gestes via la vraie fonction SQL (PGlite), annonces eBay / Ovoko SIMULÉES,
// décisions par la logique du robot (supabase/functions/_scan_partage/robot.ts). Aucun appel réel à eBay ni à Ovoko.
import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { action, IDS, nouvelleBase } from "./aide_base.mjs";
import { tourRobot } from "../supabase/functions/_scan_partage/robot.ts";

const { ruben, edward, annie } = IDS;
const ID = "50035189-181", LOT = "50035189";
const FR = "110000000001", DE = "120000000001", IT = "130000000001", ES = "140000000001", OVO = "900001";
let db;

/** Un tour du robot, écrit en base comme le fait la fonction scan-robot-veille (traces + file des événements). */
async function tour(maintenant = new Date(), delai = 24) {
  const file = (await db.query("select id::int, id_interne, action, cree_le from scan_test_evenements where not traite_robot order by id")).rows;
  const tous = (await db.query("select id::int, id_interne, action, cree_le from scan_test_evenements")).rows;
  const pieces = new Map((await db.query("select * from scan_test_pieces")).rows.map((p) => [p.id_interne, p]));
  const annonces = (await db.query("select * from scan_test_plateformes_simulees")).rows;
  const res = tourRobot(file.map(iso), tous.map(iso), pieces, annonces.map(iso), maintenant, delai);
  for (const { id, r } of res) {
    for (const t of r.traces) {
      await db.query(`insert into scan_test_robot_traces (cle, evenement_id, id_interne, declencheur, plateforme, site, annonce_ref, decision, motif, preuves, alerte)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (cle) do nothing`,
        [t.cle, t.evenement_id, t.id_interne, t.declencheur, t.plateforme, t.site, t.annonce_ref, t.decision, t.motif, JSON.stringify(t.preuves), t.alerte]);
    }
    await db.query("update scan_test_evenements set traite_robot = $2, resultat_robot = $3, traite_le = case when $2 then now() end where id = $1", [id, r.traite, r.resultat]);
  }
  return res;
}
const iso = (o) => ({ ...o, cree_le: new Date(o.cree_le).toISOString() });

async function annonce(plateforme, site, ref, { sku = null, code = null, lot = LOT, statut = "active", ancienne = null, decalageMin = 1 } = {}) {
  await db.query(`insert into scan_test_plateformes_simulees (plateforme, site, annonce_ref, sku, code_additionnel, lot, statut, ancienne_ref, cree_le)
    values ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(mins => $9))`, [plateforme, site, ref, sku, code, lot, statut, ancienne, decalageMin]);
}
async function traces(declencheur) {
  return (await db.query("select * from scan_test_robot_traces where declencheur = $1 order by id", [declencheur])).rows;
}
async function evenement(nom) {
  return (await db.query("select * from scan_test_evenements where action = $1 order by id desc limit 1", [nom])).rows[0];
}

/** Pièce en vente (FR + copies MAG + Ovoko), vendue, expédiée, revenue. */
async function pieceRevenue() {
  await db.query(`update scan_test_pieces set ebay_fr = $2, ebay_de = $3, ebay_it = $4, ebay_es = $5, ovoko_id = $6 where id_interne = $1`,
                 [ID, FR, DE, IT, ES, OVO]);
  await action(db, edward, ID, "receptionner");
  await action(db, edward, ID, "ranger", "L9-R01-E1-B01");
  await action(db, ruben, ID, "corriger_statut", null, "annonces publiées (essai)", null, "en_vente");
  // les annonces d'origine sont terminées / vendues
  await annonce("ebay", "FR", FR, { sku: ID, statut: "vendue", decalageMin: -60 });
  for (const [s, r] of [["DE", DE], ["IT", IT], ["ES", ES]]) await annonce("ebay", s, r, { sku: ID, statut: "terminee", decalageMin: -60 });
  await annonce("ovoko", "OVOKO", OVO, { code: ID, statut: "terminee", decalageMin: -60 });
  await action(db, edward, ID, "preparer_commande");
  await action(db, edward, ID, "retour_recu");
}

beforeEach(async () => { db = await nouvelleBase(); });

describe("circuit retour et robot de scan (veille)", () => {
  test("1. retour reçu → en retour + retour en attente de décision ; le robot surveille sans rien décider", async () => {
    await pieceRevenue();
    const p = (await db.query("select * from scan_test_pieces where id_interne = $1", [ID])).rows[0];
    assert.deepEqual([p.etat_physique, p.etat_commercial], ["en_retour", "retour_attente_decision"]);
    const r = await tour();
    const e = await evenement("retour_recu");
    assert.equal(e.traite_robot, false);
    assert.match(e.resultat_robot, /aucune remise en vente/);
    assert.equal((await traces("retour_recu")).length, 0);
    assert.ok(r.every((x) => x.r.traces.every((t) => t.decision !== "aurait_ferme")));
  });

  test("2. la plateforme remet la pièce en vente PENDANT le retour → « aurait fermé » FR + toutes les copies MAG + alerte", async () => {
    await pieceRevenue();
    await annonce("ebay", "FR", FR, { sku: ID, statut: "active" }).catch(async () => {
      await db.query("update scan_test_plateformes_simulees set statut = 'active' where annonce_ref = $1", [FR]);
    });
    for (const r of [DE, IT, ES]) await db.query("update scan_test_plateformes_simulees set statut = 'active' where annonce_ref = $1", [r]);
    await tour();
    const t = await traces("retour_recu");
    assert.deepEqual(t.map((x) => `${x.site}:${x.decision}`).sort(), ["DE:aurait_ferme", "ES:aurait_ferme", "FR:aurait_ferme", "IT:aurait_ferme"]);
    assert.ok(t.every((x) => x.alerte && /sans décision au scan/.test(x.alerte)));
    // rejouer le robot ne crée pas de doublon
    await tour();
    assert.equal((await traces("retour_recu")).length, 4);
    assert.equal((await evenement("retour_recu")).traite_robot, false);
  });

  test("3. « Rebut » → rebut + retirée ; « aurait fermé » toute annonce active (FR, MAG, Ovoko)", async () => {
    await pieceRevenue();
    await db.query("update scan_test_plateformes_simulees set statut = 'active' where annonce_ref = any($1)", [[FR, DE, OVO]]);
    await action(db, annie, ID, "decider_rebut");
    await tour();
    const t = await traces("retour_rebut");
    assert.deepEqual(t.map((x) => `${x.plateforme}:${x.site}:${x.decision}`).sort(),
                     ["ebay:DE:aurait_ferme", "ebay:FR:aurait_ferme", "ovoko:OVOKO:aurait_ferme"]);
    assert.equal((await evenement("retour_rebut")).traite_robot, true);
    assert.equal((await evenement("retour_recu")).traite_robot, true); // surveillance close : décision prise
  });

  test("4. « Republier » + rangement → annonce régénérée MÊME SKU : « aurait relié » FR + copies MAG DE/IT/ES + Ovoko", async () => {
    await pieceRevenue();
    await action(db, ruben, ID, "decider_republier");
    await action(db, edward, ID, "ranger", "L9-R01-E1-B02");
    await annonce("ebay", "FR", "110000000002", { sku: ID, ancienne: FR });
    await annonce("ebay", "DE", "120000000002", { sku: ID, ancienne: DE });
    await annonce("ebay", "IT", "130000000002", { sku: ID, ancienne: IT });
    await annonce("ebay", "ES", "140000000002", { sku: ID, ancienne: ES });
    await annonce("ovoko", "OVOKO", "900002", { code: ID });
    await tour();
    const t = await traces("retour_republication");
    assert.deepEqual(t.map((x) => `${x.site}:${x.annonce_ref}:${x.decision}`).sort(), [
      "DE:120000000002:aurait_relie", "ES:140000000002:aurait_relie", "FR:110000000002:aurait_relie",
      "IT:130000000002:aurait_relie", "OVOKO:900002:aurait_relie"]);
    const e = await evenement("retour_republication");
    assert.equal(e.traite_robot, true);
    assert.match(e.resultat_robot, /reliée/);
    const p = (await db.query("select etat_physique, etat_commercial from scan_test_pieces where id_interne = $1", [ID])).rows[0];
    assert.deepEqual([p.etat_physique, p.etat_commercial], ["rangee", "prete_a_republier"]);
    // mode veille : la base n'est PAS modifiée par le robot (il dit seulement ce qu'il aurait relié)
    assert.equal((await db.query("select ebay_fr from scan_test_pieces where id_interne = $1", [ID])).rows[0].ebay_fr, FR);
  });

  test("5. annonce régénérée SANS SKU → impossible à relier : « aurait fermé » l'annonce et ses copies MAG + alerte", async () => {
    await pieceRevenue();
    await action(db, ruben, ID, "decider_republier");
    await action(db, edward, ID, "ranger", "L9-R01-E1-B02");
    await annonce("ebay", "FR", "110000000003", { sku: null, ancienne: FR });
    await annonce("ebay", "DE", "120000000003", { sku: null, ancienne: DE });
    await tour();
    const t = await traces("retour_republication");
    assert.deepEqual(t.map((x) => `${x.site}:${x.decision}`).sort(), ["DE:aurait_ferme", "FR:aurait_ferme"]);
    const fr = t.find((x) => x.site === "FR");
    assert.match(fr.motif, /SKU absent/);
    assert.ok(fr.alerte);
    assert.ok(!t.some((x) => x.decision === "aurait_relie"));
  });

  test("6. annonce régénérée avec un LOT DIFFÉRENT → « aurait fermé » + alerte (jamais relié)", async () => {
    await pieceRevenue();
    await action(db, ruben, ID, "decider_republier");
    await action(db, edward, ID, "ranger", "L9-R01-E1-B02");
    await annonce("ebay", "FR", "110000000004", { sku: ID, lot: "59999999", ancienne: FR });
    await tour();
    const t = await traces("retour_republication");
    assert.equal(t.length, 1);
    assert.equal(t[0].decision, "aurait_ferme");
    assert.match(t[0].motif, /lot qui ne concorde pas/);
    assert.ok(t[0].alerte);
  });

  test("7. une seule preuve forte (n° d'origine seul, SKU différent) → « aurait demandé confirmation », jamais au n° seul", async () => {
    await pieceRevenue();
    await action(db, ruben, ID, "decider_republier");
    await action(db, edward, ID, "ranger", "L9-R01-E1-B02");
    await annonce("ebay", "FR", "110000000005", { sku: "AUTRE-001", lot: null, ancienne: FR });
    await tour();
    const t = await traces("retour_republication");
    assert.equal(t.length, 1);
    assert.equal(t[0].decision, "aurait_demande_confirmation");
    assert.match(t[0].motif, /SKU différent/);
  });

  test("8. aucune annonce régénérée : en attente avant le délai ; après 24 h → « prête à republier » maintenu + alerte annonces", async () => {
    await pieceRevenue();
    await action(db, ruben, ID, "decider_republier");
    await action(db, edward, ID, "ranger", "L9-R01-E1-B02");
    await tour(new Date(Date.now() + 23 * 3600e3));
    let e = await evenement("retour_republication");
    assert.equal(e.traite_robot, false);
    assert.match(e.resultat_robot, /en attente/);
    await tour(new Date(Date.now() + 25 * 3600e3));
    e = await evenement("retour_republication");
    assert.equal(e.traite_robot, true);
    const t = await traces("retour_republication");
    assert.equal(t.length, 1);
    assert.equal(t[0].decision, "aurait_alerte");
    assert.match(t[0].alerte, /Équipe annonces/);
    assert.equal((await db.query("select etat_commercial from scan_test_pieces where id_interne = $1", [ID])).rows[0].etat_commercial, "prete_a_republier");
  });

  test("9. annulation AVANT expédition → rangée + en vente, sans décision retour ; robot : rien", async () => {
    await db.query("update scan_test_pieces set ebay_fr = $2 where id_interne = $1", [ID, FR]);
    await action(db, edward, ID, "receptionner");
    await action(db, edward, ID, "ranger", "L9-R01-E1-B01");
    await action(db, ruben, ID, "corriger_statut", null, "en vente (essai)", null, "en_vente");
    await action(db, edward, ID, "preparer_commande");
    const r = await action(db, edward, ID, "annulation_avant_expedition", "L9-R01-E1-B01");
    assert.deepEqual([r.physique, r.commercial], ["rangee", "en_vente"]);
    assert.equal((await db.query("select count(*)::int n from scan_test_evenements where id_interne = $1 and action like 'retour%'", [ID])).rows[0].n, 0);
    await tour();
    const t = await traces("annulation_avant_expedition");
    assert.equal(t.length, 1);
    assert.equal(t[0].decision, "rien");
  });

  test("10. vente comptoir scannée → « aurait fermé » l'annonce FR, ses copies MAG et la pièce Ovoko", async () => {
    await db.query(`update scan_test_pieces set ebay_fr = $2, ebay_de = $3, ebay_it = $4, ebay_es = $5, ovoko_id = $6 where id_interne = $1`,
                   [ID, FR, DE, IT, ES, OVO]);
    await annonce("ebay", "FR", FR, { sku: ID, decalageMin: -60 });
    for (const [s, r] of [["DE", DE], ["IT", IT], ["ES", ES]]) await annonce("ebay", s, r, { sku: ID, decalageMin: -60 });
    await annonce("ovoko", "OVOKO", OVO, { code: ID, decalageMin: -60 });
    await annonce("ebay", "FR", "110000009999", { sku: "50035189-182", decalageMin: -60 }); // autre pièce du même lot : jamais touchée
    await action(db, edward, ID, "receptionner");
    await action(db, edward, ID, "vente_comptoir");
    await tour();
    const t = await traces("vente_comptoir");
    assert.deepEqual(t.map((x) => `${x.plateforme}:${x.site}:${x.decision}`).sort(), [
      "ebay:DE:aurait_ferme", "ebay:ES:aurait_ferme", "ebay:FR:aurait_ferme", "ebay:IT:aurait_ferme", "ovoko:OVOKO:aurait_ferme"]);
    assert.ok(!t.some((x) => x.annonce_ref === "110000009999"));
    assert.ok(t.every((x) => x.preuves.find((p) => p.identifiant.includes("ID interne")).resultat === "concorde"));
  });

  test("11. vente comptoir : annonce reconnue seulement par son n° (SKU absent, lot absent) → « aurait demandé confirmation »", async () => {
    await db.query("update scan_test_pieces set ebay_fr = $2 where id_interne = $1", [ID, FR]);
    await annonce("ebay", "FR", FR, { sku: null, lot: null, decalageMin: -60 });
    await action(db, edward, ID, "receptionner");
    await action(db, edward, ID, "vente_comptoir");
    await tour();
    const t = await traces("vente_comptoir");
    assert.equal(t.length, 1);
    assert.equal(t[0].decision, "aurait_demande_confirmation");
    assert.ok(t[0].alerte);
  });

  test("12. les autres gestes sont marqués traités « aucune action robot » ; les traces ne s'effacent pas", async () => {
    await action(db, edward, ID, "receptionner");
    await tour();
    assert.equal((await evenement("reception")).resultat_robot, "aucune action robot");
    await action(db, edward, ID, "vente_comptoir");
    await tour();
    await assert.rejects(db.query("delete from scan_test_robot_traces"), /Suppression interdite/);
  });
});
