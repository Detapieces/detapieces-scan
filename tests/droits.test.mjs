// Droits par rôle et sécurité au niveau des lignes (RLS), sur les vraies migrations (PGlite, hors ligne).
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { action, en, enAnonyme, IDS, nouvelleBase, refuse } from "./aide_base.mjs";

const { ruben, edward, annie, nouveau, inconnu } = IDS;
let db;
before(async () => {
  db = await nouvelleBase();
  // décisions de veille fictives (structure de production) pour l'onglet Robots
  await db.exec(`insert into veille_decisions (cle, jour, heure, evenement, id_interne, jumelle_plateforme, jumelle_site, jumelle_ref, categorie, motif, constat, simulation) values
    ('t1', '2026-10-18', '19:00', 'vente', '50025891-155', 'ovoko', null, '9001', 'aurait_ferme', 'deux preuves', 'vente constatée (commande trouvée)', false),
    ('t2', '2026-10-18', '19:05', 'vente', '50025891-156', 'ebay', 'FR', '111', 'aurait_demande_confirmation', 'une preuve', 'quantité 0 sans commande', false),
    ('t3', '2026-10-18', '19:10', 'vente', '50032939-155', 'ebay', 'DE', '222', 'rien', 'déjà terminée', 'déjà fait hors robot', false),
    ('t4', '2026-10-18', '19:15', 'vente', 'x', 'ebay', 'FR', '333', 'aurait_alerte', 'simulation', null, true);
    insert into veille_resumes values ('2026-10-18', 'Résumé du jour (essai)');`);
});

const P = "50025891-155";

describe("droits par rôle", () => {
  test("edward (équipe) : actions de dépôt OK ; ne peut NI décider d'un retour, NI marquer, NI corriger", async () => {
    await action(db, edward, P, "receptionner");
    await action(db, edward, P, "vente_comptoir");
    await action(db, edward, P, "retour_recu");
    await refuse(action(db, edward, P, "decider_republier"), "Droits insuffisants");
    await refuse(action(db, edward, P, "decider_rebut"), "Droits insuffisants");
    await refuse(action(db, edward, P, "marquer_prete_a_publier"), "Droits insuffisants");
    await refuse(action(db, edward, P, "basculer_ovoko_uniquement"), "Droits insuffisants");
    await refuse(action(db, edward, P, "corriger_statut", null, "x", "rangee"), "Droits insuffisants");
  });

  test("edward (équipe) : PAS d'onglet Robots", async () => {
    await refuse(en(db, edward, () => db.query("select scan_robots_veille('2026-10-18')")), "réservé au responsable");
  });

  test("annonces : peut décider un retour, ne peut pas réceptionner ni ranger", async () => {
    await refuse(action(db, annie, "50025891-156", "receptionner"), "Droits insuffisants");
    await refuse(action(db, annie, P, "ranger", "L9-R01-E1-B01"), "Droits insuffisants");
    assert.equal((await action(db, annie, P, "decider_republier")).evenement, "retour_decision_republier");
    await refuse(en(db, annie, () => db.query("select scan_robots_veille('2026-10-18')")), "réservé au responsable");
  });

  test("ruben (responsable) : peut tout (chaque action au moins une fois)", async () => {
    const Q = "50032939-155";
    const suite = [["receptionner"], ["ranger", "L9-R01-E1-B01"], ["marquer_prete_a_publier"], ["reserver"], ["annuler_reservation"],
      ["basculer_ovoko_uniquement"], ["basculer_gardee_de_cote"], ["signaler_absente"], ["receptionner"], ["ranger", "L9-R01-E1-B01"],
      ["vente_comptoir"], ["retour_recu"], ["decider_republier"], ["ranger", "L9-R01-E1-B02"],
      ["corriger_statut", null, "mise en vente (essai)", null, "en_vente"], ["preparer_commande"], ["annulation_avant_expedition", "L9-R01-E1-B01"],
      ["preparer_commande"], ["retour_recu"], ["decider_rebut"]];
    for (const [a, e = null, c = null, ph = null, co = null] of suite) await action(db, ruben, Q, a, e, c, ph, co);
    const faites = new Set((await db.query("select distinct action from scan_test_evenements where id_interne = $1 and prenom = 'ruben'", [Q])).rows.map((r) => r.action));
    assert.equal(faites.size, 16); // les 15 actions, dont « ranger » sous deux formes (rangement, retour_republication)
  });

  test("ruben : onglet Robots en lecture seule — décisions, résumé du jour, % « certaines » hors simulations", async () => {
    const avant = (await db.query("select count(*)::int n from veille_decisions")).rows[0].n;
    const r = await en(db, ruben, async () => (await db.query("select scan_robots_veille('2026-10-18') as r")).rows[0].r);
    assert.equal(r.decisions.length, 4);
    assert.equal(r.resume.total, 3);
    assert.equal(r.resume.certaines, 2);
    assert.equal(Number(r.resume.pourcentage_certaines), 66.7);
    assert.equal(r.resume.texte_resume_veille, "Résumé du jour (essai)");
    assert.ok(r.decisions.some((d) => d.constat === "quantité 0 sans commande"));
    assert.equal((await db.query("select count(*)::int n from veille_decisions")).rows[0].n, avant);
  });

  test("les tables de veille restent fermées en direct (aucune politique ajoutée)", async () => {
    const r = await en(db, ruben, () => db.query("select count(*)::int n from veille_decisions").then((x) => x.rows[0].n).catch((e) => e.message));
    assert.ok(r === 0 || /permission denied/.test(r), `inattendu : ${r}`);
  });

  test("changement de mot de passe obligatoire : aucune action tant qu'il n'est pas fait", async () => {
    await refuse(action(db, nouveau, "50025891-156", "receptionner"), "Changez d'abord votre mot de passe");
  });

  test("compte désactivé ou sans profil : refusé, ne voit rien", async () => {
    await db.exec(`update scan_profils set actif = false where prenom = 'annie'`);
    await refuse(action(db, annie, P, "decider_rebut"), "compte inconnu ou désactivé");
    const vu = await en(db, annie, () => db.query("select count(*)::int n from scan_test_pieces").then((x) => x.rows[0].n));
    assert.equal(vu, 0);
    await db.exec(`update scan_profils set actif = true where prenom = 'annie'`);
    await refuse(action(db, inconnu, P, "receptionner"), "compte inconnu");
    assert.equal(await en(db, inconnu, () => db.query("select count(*)::int n from scan_test_evenements").then((x) => x.rows[0].n)), 0);
  });

  test("visiteur non connecté (clé publique seule) : aucune lecture, aucune action", async () => {
    await refuse(enAnonyme(db, () => db.query("select * from scan_test_pieces limit 1")), "permission denied");
    await refuse(enAnonyme(db, () => db.query("select * from scan_profils limit 1")), "permission denied");
    await refuse(enAnonyme(db, () => db.query("select scan_action('x', 'receptionner')")), "permission denied");
    await refuse(enAnonyme(db, () => db.query("select scan_robots_veille()")), "permission denied");
  });

  test("aucune écriture directe dans les tables, même connecté (tout passe par scan_action)", async () => {
    await refuse(en(db, ruben, () => db.query("update scan_test_pieces set etat_commercial = 'vendue'")), "permission denied");
    await refuse(en(db, ruben, () => db.query("insert into scan_test_evenements (id_interne, action) values ($1, 'x')", [P])), "permission denied");
    await refuse(en(db, ruben, () => db.query("update scan_profils set role = 'responsable'")), "permission denied");
    await refuse(en(db, edward, () => db.query("select * from scan_test_plateformes_simulees")), "permission denied");
  });

  test("profils : chacun voit le sien ; le responsable voit tous les comptes et le journal", async () => {
    const e = await en(db, edward, () => db.query("select prenom from scan_profils").then((x) => x.rows.map((r) => r.prenom)));
    assert.deepEqual(e, ["edward"]);
    const r = await en(db, ruben, () => db.query("select prenom from scan_profils order by prenom").then((x) => x.rows.map((r) => r.prenom)));
    assert.deepEqual(r, ["annie", "edward", "nouveau", "ruben"]);
    assert.equal(await en(db, edward, () => db.query("select count(*)::int n from scan_journal_comptes").then((x) => x.rows[0].n)), 0);
  });

  test("lecture du suivi (vue) pour tout compte actif, RLS de l'appelant appliquée", async () => {
    const n = await en(db, edward, () => db.query("select count(*)::int n from scan_test_pieces_vue").then((x) => x.rows[0].n));
    assert.equal(n, 154);
  });
});
