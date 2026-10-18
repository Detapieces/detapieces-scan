// Chaque transition de statut, passée par la vraie fonction SQL scan_action (PGlite, hors ligne).
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { action, IDS, nouvelleBase, piece, refuse } from "./aide_base.mjs";

const { ruben, edward, annie } = IDS;
let db;
before(async () => { db = await nouvelleBase(); });

const P = (n) => ["50025891-155", "50025891-156", "50032939-155", "50032939-156"][n];
async function ids() { return (await db.query("select id_interne from scan_test_pieces order by id_interne limit 40")).rows.map((r) => r.id_interne); }

describe("transitions de statut", () => {
  test("données d'essai : 154 portes « attendue » / « annonce pas encore créée », 11 emplacements d'essai", async () => {
    const r = (await db.query("select etat_physique, etat_commercial, count(*)::int n from scan_test_pieces group by 1, 2")).rows;
    assert.deepEqual(r, [{ etat_physique: "attendue", etat_commercial: "annonce_non_creee", n: 154 }]);
    assert.equal((await db.query("select count(*)::int n from scan_test_emplacements where essai")).rows[0].n, 11);
  });

  test("réceptionner : attendue → réceptionnée ; deux fois = refusé", async () => {
    const r = await action(db, edward, P(0), "receptionner");
    assert.equal(r.physique, "receptionnee");
    assert.equal(r.evenement, "reception");
    await refuse(action(db, edward, P(0), "receptionner"), "déjà réceptionnée");
  });

  test("ranger : refusé avant réception ; double scan pièce + emplacement ; changement d'emplacement", async () => {
    await refuse(action(db, edward, P(1), "ranger", "L9-R01-E1-B01"), "réceptionnez d'abord");
    await refuse(action(db, edward, P(0), "ranger", null), "scannez l'emplacement");
    await refuse(action(db, edward, P(0), "ranger", "ZZ-INCONNU"), "Emplacement inconnu");
    let r = await action(db, edward, P(0), "ranger", "l9-r01-e1-b01");
    assert.equal(r.evenement, "rangement");
    assert.equal((await piece(db, P(0))).emplacement, "L9-R01-E1-B01");
    r = await action(db, edward, P(0), "ranger", "L9-R01-E1-B02");
    assert.equal(r.evenement, "changement_emplacement");
    const ev = (await db.query("select emplacement_avant, emplacement_apres from scan_test_evenements where id = $1", [r.evenement_id])).rows[0];
    assert.deepEqual(ev, { emplacement_avant: "L9-R01-E1-B01", emplacement_apres: "L9-R01-E1-B02" });
  });

  test("un bac contient beaucoup de pièces ; une pièce n'a qu'un emplacement", async () => {
    const liste = (await ids()).slice(10, 20);
    for (const id of liste) { await action(db, edward, id, "receptionner"); await action(db, edward, id, "ranger", "L9-R02-E1-B01"); }
    const n = (await db.query("select count(*)::int n from scan_test_pieces_vue where emplacement = 'L9-R02-E1-B01'")).rows[0].n;
    assert.equal(n, 10);
  });

  test("signaler absente → absente sans emplacement ; retrouvée = réceptionner", async () => {
    const r = await action(db, edward, P(0), "signaler_absente");
    assert.equal(r.physique, "absente");
    assert.equal((await piece(db, P(0))).emplacement, null);
    await refuse(action(db, edward, P(1), "signaler_absente"), "pas censée");
    assert.equal((await action(db, edward, P(0), "receptionner")).physique, "receptionnee");
    await action(db, edward, P(0), "ranger", "L9-R01-E1-B01");
  });

  test("prête à publier (annonces) : seulement si annonce pas encore créée et pièce réceptionnée", async () => {
    await refuse(action(db, annie, P(1), "marquer_prete_a_publier"), "réceptionnée au scan");
    assert.equal((await action(db, annie, P(0), "marquer_prete_a_publier")).commercial, "prete_a_publier");
    await refuse(action(db, annie, P(0), "marquer_prete_a_publier"), "pas encore créée");
  });

  test("réserver / annuler la réservation : retour à l'état commercial d'avant", async () => {
    assert.equal((await action(db, edward, P(0), "reserver")).commercial, "reservee");
    await refuse(action(db, edward, P(0), "reserver"), "pas disponible");
    assert.equal((await action(db, edward, P(0), "annuler_reservation")).commercial, "prete_a_publier");
    await refuse(action(db, edward, P(0), "annuler_reservation"), "pas réservée");
  });

  test("préparer une commande → partie + vendue ; annulation AVANT expédition → rangée + en vente (sans décision retour)", async () => {
    await refuse(action(db, edward, P(0), "preparer_commande"), "ni en vente");
    await action(db, ruben, P(0), "corriger_statut", null, "annonce publiée (essai)", null, "en_vente");
    const r = await action(db, edward, P(0), "preparer_commande");
    assert.deepEqual([r.physique, r.commercial, r.emplacement], ["partie", "vendue", null]);
    await refuse(action(db, edward, P(0), "annulation_avant_expedition", null), "scannez l'emplacement");
    const a = await action(db, edward, P(0), "annulation_avant_expedition", "L9-R01-E1-B01");
    assert.deepEqual([a.physique, a.commercial, a.emplacement], ["rangee", "en_vente", "L9-R01-E1-B01"]);
    assert.equal((await piece(db, P(0))).retour_decision, null);
  });

  test("vente comptoir → partie + vendue ; pas d'« annulation avant expédition » sur une vente comptoir", async () => {
    await action(db, edward, P(2), "receptionner");
    const r = await action(db, edward, P(2), "vente_comptoir");
    assert.deepEqual([r.physique, r.commercial, r.evenement], ["partie", "vendue", "vente_comptoir"]);
    await refuse(action(db, edward, P(2), "annulation_avant_expedition", "L9-R01-E1-B01"), "commande préparée");
    await refuse(action(db, edward, P(2), "vente_comptoir"), "pas au dépôt");
  });

  test("retour : reçu (seulement si vendue et partie) → rebut ; ou → Republier + rangement → prête à republier", async () => {
    await refuse(action(db, edward, P(1), "retour_recu"), "vendue et partie");
    // P(2) vendue au comptoir puis revenue : rebut
    let r = await action(db, edward, P(2), "retour_recu");
    assert.deepEqual([r.physique, r.commercial, r.evenement], ["en_retour", "retour_attente_decision", "retour_recu"]);
    await refuse(action(db, edward, P(2), "ranger", "L9-R01-E1-B01"), "sans décision");
    r = await action(db, annie, P(2), "decider_rebut");
    assert.deepEqual([r.physique, r.commercial, r.evenement], ["rebut", "retiree", "retour_rebut"]);
    await refuse(action(db, annie, P(2), "decider_rebut"), "aucun retour en attente");
    // P(0) : commande, retour, republier
    await action(db, edward, P(0), "preparer_commande");
    await action(db, edward, P(0), "retour_recu");
    r = await action(db, ruben, P(0), "decider_republier");
    assert.equal(r.evenement, "retour_decision_republier");
    assert.equal((await piece(db, P(0))).retour_decision, "republier");
    await refuse(action(db, ruben, P(0), "decider_rebut"), "décision déjà prise");
    r = await action(db, edward, P(0), "ranger", "L9-R01-E2-B01");
    assert.deepEqual([r.physique, r.commercial, r.evenement, r.emplacement], ["rangee", "prete_a_republier", "retour_republication", "L9-R01-E2-B01"]);
    assert.equal((await piece(db, P(0))).retour_decision, null);
  });

  test("marqueurs « Ovoko uniquement » et « gardée de côté » (annonces) : bascule oui / non", async () => {
    assert.equal((await action(db, annie, P(1), "basculer_ovoko_uniquement")).evenement, "marquage_ovoko_uniquement");
    assert.equal((await piece(db, P(1))).ovoko_uniquement, true);
    assert.equal((await action(db, annie, P(1), "basculer_ovoko_uniquement")).evenement, "retrait_ovoko_uniquement");
    assert.equal((await action(db, annie, P(1), "basculer_gardee_de_cote")).evenement, "marquage_gardee_de_cote");
    assert.equal((await piece(db, P(1))).gardee_de_cote, true);
  });

  test("type « Ovoko uniquement » (table de types) : affiché comme information, sans rien bloquer", async () => {
    await db.exec("insert into scan_test_types_ovoko_uniquement values ('156', 'TEST seulement')");
    assert.equal((await piece(db, P(3))).ovoko_uniquement, true);
    assert.equal((await action(db, edward, P(3), "receptionner")).physique, "receptionnee");
    await db.exec("delete from scan_test_types_ovoko_uniquement");
  });

  test("correction de statut : responsable seulement, commentaire obligatoire, états contrôlés", async () => {
    await refuse(action(db, ruben, P(1), "corriger_statut", null, null, "rangee"), "commentaire est obligatoire");
    await refuse(action(db, ruben, P(1), "corriger_statut", null, "x", "cassee"), "État physique inconnu");
    const r = await action(db, ruben, P(1), "corriger_statut", null, "trouvée en réserve", "supposee_presente");
    assert.equal(r.physique, "supposee_presente");
    assert.equal(r.evenement, "correction_statut");
  });

  test("pas de statut « réceptionné mais cassé » ; « rebut » n'existe que pour un retour", async () => {
    const e = await refuse(db.query("update scan_test_pieces set etat_physique = 'cassee' where id_interne = $1", [P(1)]));
    assert.match(e, /check/i);
    const sansRetour = (await db.query(`select count(*)::int n from scan_test_pieces p where etat_physique = 'rebut'
      and not exists (select 1 from scan_test_evenements e where e.id_interne = p.id_interne and e.action = 'retour_rebut')`)).rows[0].n;
    assert.equal(sansRetour, 0);
  });

  test("pièce inconnue : message clair", async () => {
    await refuse(action(db, edward, "99999999-155", "receptionner"), "Pièce inconnue : 99999999-155");
    await refuse(action(db, edward, "", "receptionner"), "Pièce inconnue : (vide)");
  });

  test("chaque geste est signé (qui, quand, rôle, appareil) ; ancien et nouveau statut", async () => {
    const r = (await db.query("select * from scan_test_evenements order by id")).rows;
    assert.ok(r.length > 20);
    for (const e of r) {
      assert.ok(e.user_id && e.prenom && e.role && e.appareil === "test-appareil" && e.cree_le, `signature manquante (${e.id})`);
      assert.ok(e.physique_avant && e.physique_apres && e.commercial_avant && e.commercial_apres);
      assert.equal(e.traite_robot, false);
    }
  });

  test("rien ne s'efface : événement non modifiable / non supprimable ; pièce non supprimable", async () => {
    await refuse(db.query("delete from scan_test_evenements where id = 1"), "Suppression interdite");
    await refuse(db.query("update scan_test_evenements set action = 'x' where id = 1"), "ne se modifie pas");
    await db.query("update scan_test_evenements set traite_robot = true, resultat_robot = 'essai' where id = 1");
    await refuse(db.query("delete from scan_test_pieces where id_interne = $1", [P(1)]), "Suppression interdite");
  });
});
