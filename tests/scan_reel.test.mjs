// Scan sur les VRAIES pièces (migration 20261028120000_scan_reel.sql) — PGlite hors ligne, vraies migrations + doublures.
// Normalisation de l'ID, doublons, droits par rôle, présence / emplacement seulement, enregistrement par le responsable
// (rien d'inventé, état « en_attente_annonce »), aucun état vendu / réservé possible, journal immuable, tables de test intactes,
// droits des nouvelles tables (règle du 23/10), retour arrière.
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { en, enAnonyme, IDS, nouvelleBase, refuse } from "./aide_base.mjs";

const { ruben, edward, annie, nouveau, inconnu } = IDS;
const MIGRATION = readFileSync(new URL("../supabase/migrations/20261028120000_scan_reel.sql", import.meta.url), "utf8");
const ANNULER = readFileSync(new URL("../supabase/annuler/annuler_scan_reel.sql", import.meta.url), "utf8");
let db, idTest;

const appel = (uid, sql, p = []) => en(db, uid, async () => (await db.query(`select ${sql} as r`, p)).rows[0].r);
const lire = (uid, code) => appel(uid, "public.scan_reel_lire($1)", [code]);
const confirmer = (uid, id) => appel(uid, "public.scan_reel_confirmer_presence($1, 'test-appareil', null)", [id]);
const ranger = (uid, id, empl) => appel(uid, "public.scan_reel_ranger($1, $2, 'test-appareil', null)", [id, empl]);
const enregistrer = (uid, id, type) => appel(uid, "public.scan_reel_enregistrer($1, $2, 'test-appareil', null)", [id, type]);
const nb = async (sql, p = []) => Number((await db.query(`select count(*)::int as n from ${sql}`, p)).rows[0].n);

before(async () => {
  db = await nouvelleBase();
  idTest = (await db.query("select id_interne from scan_test_pieces order by id_interne limit 1")).rows[0].id_interne;
  const normTest = idTest.replace(/[-\s]/g, "").toUpperCase();
  await db.query(`insert into pieces (id_interne, lot, id_interne_norme, type_piece, canal, id_ovoko, sku_ebay_fr, stock_partenaire, origine, etat_fiabilite) values
    ('560393-001', '560393', '560393001', 'Moteur complet', 'eBay + Ovoko', '29132', '560393-001', 'non', 'liaison_18_10', 'fiable'),
    ('1000410-001', '1000410', '1000410001', 'Moteur complet', 'eBay + Ovoko', '31959', '1000410-001', 'non', 'liaison_18_10', 'fiable'),
    ('50039012-155', '50039012', '50039012155', 'Porte', null, null, null, 'non', 'liaison_18_10', 'fiable'),
    ('$1', 'X', $2, 'Autoradio', null, null, null, 'non', 'liaison_18_10', 'fiable')`.replace("'$1'", "$1"), [idTest, normTest]);
  await db.exec(`insert into pieces (id_interne, lot, id_interne_norme, type_piece, stock_partenaire, origine, id_interne_en_double) values
    ('316603-001', '316603', '316603001', 'Moteur complet', 'non', 'liaison_18_10', true),
    ('316603-001', '316603', '316603001', 'Moteur complet', 'non', 'liaison_18_10', true);
    insert into annonces_ebay (item_id, site, piece_id, role, rang_fr) values ('298000000001', 'FR', 1, 'FR', 1), ('298000000002', 'DE', 1, 'copie', null);
    insert into ref_lots_stock (lot, stock_arrivage) values ('50039012', 'STOCK 16↓ 09/26'), ('58660446', 'STOCK 16↓ 09/26'),
      ('Y0000016', 'STOCK 16↓ 09/26'), ('63277106', 'STOCK 16↓ 09/26'), ('22222222', 'STOCK ECO 1 ↓');
    insert into scan_test_emplacements (code, niveau_rang, libelle, essai) values ('LA-A1-E0-PL1', 5, 'réel', false), ('LA-A1-E0-PL2', 5, 'réel', false);
    insert into scan_test_emplacements (code, niveau_rang, libelle, essai, actif) values ('LA-ZZ-OFF', 5, 'réel désactivé', false, false);`);
});

describe("Lecture d'une vraie pièce", () => {
  test("ID comparé normalisé : avec ou sans tiret, espaces, minuscules => même fiche (type, lot, canal, ID Ovoko, annonces)", async () => {
    for (const code of ["560393-001", "560393001", " 560393 001 ", "560393-001"]) {
      const r = await lire(edward, code);
      assert.equal(r.trouve, 1, code);
      const p = r.pieces[0];
      assert.deepEqual([p.id_interne, p.type_piece, p.lot, p.canal, p.id_ovoko, p.ebay_fr, p.copies, p.etat_physique],
                       ["560393-001", "Moteur complet", "560393", "eBay + Ovoko", "29132", "298000000001", "DE 298000000002", null]);
    }
    assert.equal((await lire(annie, "1000410001")).pieces[0].id_ovoko, "31959", "rôle annonces : lecture permise");
  });
  test("pièce aussi présente dans la table de test : lien id_test renvoyé", async () => {
    assert.equal((await lire(ruben, idTest)).pieces[0].id_test, idTest);
    assert.equal((await lire(ruben, "560393-001")).pieces[0].id_test, null);
  });
  test("ID en double : les lignes sont renvoyées, aucun geste possible", async () => {
    assert.equal((await lire(ruben, "316603-001")).trouve, 2);
    await refuse(confirmer(ruben, "316603-001"), "porté par 2 lignes");
  });
  test("ID inconnu : lot, lot connu, ID formaté ; partenaire ECO signalé ; TMP- / A+B non valides", async () => {
    assert.deepEqual(await lire(ruben, "Y0000016001"),
      { trouve: 0, id_valide: true, lot: "Y0000016", id_formate: "Y0000016-001", lot_connu: true, lot_partenaire: false });
    assert.equal((await lire(ruben, "22222222-001")).lot_partenaire, true);
    assert.equal((await lire(ruben, "TMP-123")).id_valide, false);
    assert.equal((await lire(ruben, "63945226-186+63945226-187")).id_valide, false);
  });
  test("anonyme et compte inconnu : refusés", async () => {
    await refuse(enAnonyme(db, () => db.query("select public.scan_reel_lire('560393-001')")), "permission denied");
    await refuse(lire(inconnu, "560393-001"), "compte inconnu");
  });
});

describe("Gestes : présence confirmée et emplacement seulement", () => {
  test("confirmer la présence : équipe oui ; annonces, mot de passe à changer : non ; journal signé", async () => {
    await refuse(confirmer(annie, "560393-001"), "réservée à l'équipe sur site");
    await refuse(confirmer(nouveau, "560393-001"), "Changez d'abord votre mot de passe");
    const r = await confirmer(edward, "560393001");
    assert.deepEqual([r.ok, r.evenement, r.id_interne], [true, "confirmation_presence", "560393-001"]);
    const p = (await lire(edward, "560393-001")).pieces[0];
    assert.deepEqual([p.etat_physique, p.etat_commercial, p.confirme_prenom], ["presente_confirmee", null, "edward"],
                     "commercial inconnu : laissé vide, rien d'inventé");
    const e = (await db.query("select * from scan_pieces_evenements where id = $1", [r.evenement_id])).rows[0];
    assert.deepEqual([e.prenom, e.role, e.appareil, e.physique_avant, e.physique_apres], ["edward", "equipe", "test-appareil", null, "presente_confirmee"]);
  });
  test("ranger : emplacement réel actif seulement (essai, désactivé, inconnu refusés) ; puis changement d'emplacement", async () => {
    await refuse(ranger(edward, "1000410-001", "L9-R01-E1-B01"), "d'essai");
    await refuse(ranger(edward, "1000410-001", "LA-ZZ-OFF"), "Emplacement inconnu");
    await refuse(ranger(edward, "1000410-001", ""), "scannez l'emplacement");
    const r1 = await ranger(edward, "1000410-001", "la-a1-e0-pl1");
    assert.deepEqual([r1.evenement, r1.emplacement], ["rangement", "LA-A1-E0-PL1"]);
    const r2 = await ranger(ruben, "1000410001", "LA-A1-E0-PL2");
    assert.equal(r2.evenement, "changement_emplacement");
    const p = (await lire(ruben, "1000410-001")).pieces[0];
    assert.deepEqual([p.etat_physique, p.emplacement], ["presente_confirmee", "LA-A1-E0-PL2"]);
    const id = (await db.query("select id from scan_test_emplacements where code = 'LA-A1-E0-PL2'")).rows[0].id;
    assert.deepEqual(await appel(edward, "public.scan_reel_emplacement($1)", [id]), [{ id_interne: "1000410-001", type_piece: "Moteur complet" }]);
  });
  test("aucun état vendu / réservé / parti possible (contrainte), journal immuable", async () => {
    await refuse(db.query("update scan_pieces_etat set etat_physique = 'partie'"), "check");
    await refuse(db.query("update scan_pieces_etat set etat_commercial = 'vendue'"), "check");
    await refuse(db.query("update scan_pieces_etat set etat_commercial = 'reservee'"), "check");
    await refuse(db.query("update scan_pieces_evenements set prenom = 'x'"), "modification interdite");
    await refuse(db.query("delete from scan_pieces_evenements"), "Suppression interdite");
  });
  test("les gestes réels ne touchent ni pieces (hors enregistrement) ni les tables de test", async () => {
    const avant = (await db.query("select md5(string_agg(t::text, '|' order by id)) h from pieces t")).rows[0].h;
    const evts = await nb("scan_test_evenements"), tests = (await db.query("select md5(string_agg(t::text, '|' order by id_interne)) h from scan_test_pieces t")).rows[0].h;
    await confirmer(ruben, "1000410-001");
    await ranger(ruben, "560393-001", "LA-A1-E0-PL1");
    assert.equal((await db.query("select md5(string_agg(t::text, '|' order by id)) h from pieces t")).rows[0].h, avant);
    assert.equal(await nb("scan_test_evenements"), evts);
    assert.equal((await db.query("select md5(string_agg(t::text, '|' order by id_interne)) h from scan_test_pieces t")).rows[0].h, tests);
  });
});

describe("Enregistrer une pièce absente de la base (responsable)", () => {
  test("équipe et annonces refusées", async () => {
    await refuse(enregistrer(edward, "50039012-001", "Moteur complet"), "réservé au responsable");
    await refuse(enregistrer(annie, "50039012-001", "Moteur complet"), "réservée à l'équipe sur site");
  });
  test("refus : ID non valide, TMP-, A+B, déjà dans la base (même normalisé), lot inconnu, lot ECO, type inconnu ou vide", async () => {
    await refuse(enregistrer(ruben, "TMP-123", "Moteur complet"), "ID interne non valide");
    await refuse(enregistrer(ruben, "63945226-186+63945226-187", "Moteur complet"), "ID interne non valide");
    await refuse(enregistrer(ruben, "560393001", "Moteur complet"), "déjà dans la base");
    await refuse(enregistrer(ruben, "99999999-001", "Moteur complet"), "Lot 99999999 inconnu");
    await refuse(enregistrer(ruben, "22222222-001", "Moteur complet"), "stock partenaire ECO");
    await refuse(enregistrer(ruben, "58660446-001", "Moteur V12 inventé"), "Type de pièce « Moteur V12 inventé » inconnu");
    await refuse(enregistrer(ruben, "58660446-001", ""), "inconnu");
    assert.equal(await nb("pieces where origine = 'scan'"), 0, "aucune ligne créée par un refus");
  });
  test("création : ID formaté, rien d'inventé, présente confirmée / annonce pas encore créée, état « en_attente_annonce »", async () => {
    const types = await appel(ruben, "public.scan_reel_types()");
    assert.ok(types.includes("Moteur complet"));
    for (const [saisi, attendu] of [["50039012-001", "50039012-001"], ["58660446001", "58660446-001"], ["y0000016-001", "Y0000016-001"], ["63277106 001", "63277106-001"]]) {
      const r = await enregistrer(ruben, saisi, "Moteur complet");
      assert.deepEqual([r.ok, r.evenement, r.id_interne], [true, "enregistrement", attendu]);
      const p = (await db.query("select * from pieces where id = $1", [r.piece_id])).rows[0];
      assert.deepEqual([p.id_interne, p.lot, p.type_piece, p.origine, p.stock_partenaire, p.id_interne_en_double],
                       [attendu, attendu.split("-")[0], "Moteur complet", "scan", "non", false]);
      assert.deepEqual([p.vehicule, p.canal, p.id_ovoko, p.prix_ovoko, p.sku_ebay_fr, p.cote, p.liaison_id], [null, null, null, null, null, null, null],
                       "véhicule, canal, prix, ID Ovoko, SKU, côté : vides");
      assert.equal(p.etat_fiabilite, "en_attente_annonce");
      const f = (await lire(edward, saisi)).pieces[0];
      assert.deepEqual([f.etat_physique, f.etat_commercial, f.emplacement], ["presente_confirmee", "annonce_non_creee", null],
                       "aucun emplacement attribué : il sera scanné");
    }
    await refuse(enregistrer(ruben, "50039012001", "Moteur complet"), "déjà dans la base");
    assert.equal(await nb("pieces where origine = 'scan'"), 4);
    assert.equal(await nb("scan_pieces_evenements where action = 'enregistrement'"), 4);
    const r = await ranger(edward, "58660446-001", "LA-A1-E0-PL1");
    assert.equal(r.emplacement, "LA-A1-E0-PL1", "rattachement d'un moteur enregistré à un emplacement scanné");
  });
});

describe("Droits (règle Supabase du 23/10) et retour arrière", () => {
  test("tables : RLS, rien pour anon / authenticated, service_role seul, séquence fermée, règle explicite", async () => {
    for (const t of ["scan_pieces_etat", "scan_pieces_evenements"]) {
      const d = (await db.query(`select has_table_privilege('anon', 'public.${t}', 'select, insert, update, delete, truncate, references, trigger') an,
        has_table_privilege('authenticated', 'public.${t}', 'select, insert, update, delete, truncate, references, trigger') au,
        has_table_privilege('service_role', 'public.${t}', 'select') and has_table_privilege('service_role', 'public.${t}', 'insert') sr,
        (select relrowsecurity from pg_class where oid = 'public.${t}'::regclass) rls,
        (select string_agg(policyname || ':' || array_to_string(roles, ','), ' ') from pg_policies where tablename = '${t}') pol`)).rows[0];
      assert.deepEqual([d.an, d.au, d.sr, d.rls, d.pol], [false, false, true, true, "service_role_seul:service_role"], t);
      await refuse(en(db, ruben, () => db.query(`select * from public.${t}`)), "permission denied");
    }
    const s = (await db.query("select has_sequence_privilege('authenticated', 'public.scan_pieces_evenements_id_seq', 'usage') a, has_sequence_privilege('anon', 'public.scan_pieces_evenements_id_seq', 'usage') b")).rows[0];
    assert.deepEqual([s.a, s.b], [false, false]);
  });
  test("fonctions : exposées à authenticated seulement ; outils internes fermés", async () => {
    for (const f of ["scan_reel_lire(text)", "scan_reel_emplacement(bigint)", "scan_reel_types()", "scan_reel_confirmer_presence(text, text, text)",
                     "scan_reel_ranger(text, text, text, text)", "scan_reel_enregistrer(text, text, text, text)"]) {
      const d = (await db.query(`select has_function_privilege('anon', 'public.${f}', 'execute') an, has_function_privilege('authenticated', 'public.${f}', 'execute') au`)).rows[0];
      assert.deepEqual([d.an, d.au], [false, true], f);
    }
    for (const f of ["scan_reel_profil(boolean)", "scan_reel_une_piece(text)", "scan_reel_journal_immuable()"]) {
      const d = (await db.query(`select has_function_privilege('anon', 'public.${f}', 'execute') an, has_function_privilege('authenticated', 'public.${f}', 'execute') au`)).rows[0];
      assert.deepEqual([d.an, d.au], [false, false], f);
    }
  });
  test("retour arrière : tables et fonctions retirées, pieces intacte ; migration réappliquée (rejouable)", async () => {
    const avant = await nb("pieces");
    await db.exec(ANNULER);
    assert.equal(await nb("pg_tables where tablename in ('scan_pieces_etat', 'scan_pieces_evenements')"), 0);
    assert.equal(await nb("pg_proc where proname like 'scan_reel%'"), 0);
    assert.equal(await nb("pieces"), avant);
    assert.equal(await nb("pg_proc where proname = 'scan_action'"), 1, "fonctions existantes intactes");
    await db.exec(MIGRATION);
    await db.exec(MIGRATION);
    assert.equal(await nb("pg_tables where tablename in ('scan_pieces_etat', 'scan_pieces_evenements')"), 2);
  });
});
