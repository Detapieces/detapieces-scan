// Connexion, comptes et changement de mot de passe obligatoire : logique de la fonction scan-comptes
// (supabase/functions/_scan_partage/comptes.ts) branchée sur la vraie base PGlite ; l'authentification Supabase est simulée.
import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { action, IDS, nouvelleBase, refuse } from "./aide_base.mjs";
import { emailDe, motDePasseAleatoire, traiterComptes } from "../supabase/functions/_scan_partage/comptes.ts";

let db, auth, compteur;

/** Fausse authentification Supabase (mots de passe en mémoire) + accès réels à la base PGlite (comme la clé de service). */
function deps() {
  return {
    async utilisateurDuJeton(j) { return auth.jetons.get(j) ?? null; },
    async profil(id) { return (await db.query("select user_id, prenom, role, actif, doit_changer_mdp from scan_profils where user_id = $1", [id])).rows[0] ?? null; },
    async profilParPrenom(p) { return (await db.query("select user_id, prenom, role, actif, doit_changer_mdp from scan_profils where prenom = $1", [p])).rows[0] ?? null; },
    async creerUtilisateur(email, mdp) {
      const id = `00000000-0000-4000-9000-${String(++compteur).padStart(12, "0")}`;
      await db.query("insert into auth.users values ($1, $2)", [id, email]);
      auth.mdp.set(email, mdp); auth.email.set(id, email);
      return id;
    },
    async changerMotDePasse(id, mdp) { auth.mdp.set(auth.email.get(id), mdp); },
    async bloquer(id, b) { b ? auth.bloques.add(id) : auth.bloques.delete(id); },
    async insererProfil(p) {
      await db.query("insert into scan_profils (user_id, prenom, role, actif, doit_changer_mdp, cree_par) values ($1,$2,$3,$4,$5,$6)",
                     [p.user_id, p.prenom, p.role, p.actif, p.doit_changer_mdp, p.cree_par]);
    },
    async majProfil(id, c) {
      for (const [k, v] of Object.entries(c)) await db.query(`update scan_profils set ${k} = $2, maj_le = now() where user_id = $1`, [id, v]);
    },
    async journaliser(j) {
      await db.query(`insert into scan_journal_comptes (par_user, par_prenom, cible_user, cible_prenom, action, detail, appareil)
                      values ($1,$2,$3,$4,$5,$6,$7)`, [j.par_user, j.par_prenom, j.cible_user, j.cible_prenom, j.action, j.detail, j.appareil]);
    },
    genererMotDePasse: () => motDePasseAleatoire(),
  };
}

/** Connexion comme la page : identifiant = prénom → compte technique ; renvoie un jeton de session. */
async function connexion(prenom, mdp) {
  const email = emailDe(prenom.trim().toLowerCase());
  const id = [...auth.email].find(([, e]) => e === email)?.[0];
  if (!id || auth.mdp.get(email) !== mdp) throw new Error("Identifiant ou mot de passe incorrect");
  if (auth.bloques.has(id)) throw new Error("Compte désactivé");
  const jeton = `jeton-${prenom}-${Math.random()}`;
  auth.jetons.set(jeton, id);
  return { jeton, id };
}

beforeEach(async () => {
  db = await nouvelleBase({ comptes: true });
  compteur = 100;
  auth = { mdp: new Map(), email: new Map(), jetons: new Map(), bloques: new Set() };
  for (const [p, id] of Object.entries(IDS)) { auth.email.set(id, `${p}@scan.detapieces.invalid`); auth.mdp.set(`${p}@scan.detapieces.invalid`, `provisoire-${p}`); }
});

describe("connexion et comptes", () => {
  test("identifiant = prénom en minuscules → compte technique sans e-mail réel", () => {
    assert.equal(emailDe("edward"), "edward@scan.detapieces.invalid");
  });

  test("mot de passe provisoire aléatoire : 10 caractères, sans caractère ambigu", () => {
    const m = motDePasseAleatoire();
    assert.equal(m.length, 10);
    assert.doesNotMatch(m, /[0O1lI]/);
    assert.notEqual(m, motDePasseAleatoire());
  });

  test("première connexion : actions refusées → changement obligatoire (8 car. min.) → actions permises", async () => {
    // ruben crée edouard
    const r = await connexion("ruben", "provisoire-ruben");
    const c = await traiterComptes(r.jeton, { action: "creer", prenom: "Edouard", role: "equipe" }, deps());
    assert.equal(c.status, 200);
    assert.equal(c.corps.prenom, "edouard");
    const provisoire = c.corps.mot_de_passe_provisoire;
    assert.equal(provisoire.length, 10);
    // edouard se connecte avec son prénom
    await assert.rejects(connexion("edouard", "mauvais"), /incorrect/);
    const e = await connexion("EDOUARD ", provisoire);
    await refuse(action(db, e.id, "50025891-155", "receptionner"), "Changez d'abord votre mot de passe");
    // trop court / contient le prénom
    assert.equal((await traiterComptes(e.jeton, { action: "changer_mdp", nouveau: "court" }, deps())).status, 400);
    assert.match((await traiterComptes(e.jeton, { action: "changer_mdp", nouveau: "edouard2026!" }, deps())).corps.erreur, /prénom/);
    // bon mot de passe
    const ok = await traiterComptes(e.jeton, { action: "changer_mdp", nouveau: "Portes-Guignes77" }, deps());
    assert.equal(ok.status, 200);
    assert.equal((await connexion("edouard", "Portes-Guignes77")).id, e.id);
    await assert.rejects(connexion("edouard", provisoire), /incorrect/);
    assert.equal((await action(db, e.id, "50025891-155", "receptionner")).physique, "receptionnee");
  });

  test("aucun mot de passe dans le journal des comptes", async () => {
    const r = await connexion("ruben", "provisoire-ruben");
    const c = await traiterComptes(r.jeton, { action: "creer", prenom: "ioana", role: "annonces", appareil: "PC bureau" }, deps());
    await traiterComptes(r.jeton, { action: "reinitialiser", prenom: "ioana" }, deps());
    const journal = JSON.stringify((await db.query("select * from scan_journal_comptes")).rows);
    assert.ok(!journal.includes(c.corps.mot_de_passe_provisoire));
    assert.match(journal, /creation/);
    assert.match(journal, /reinitialisation_mdp/);
  });

  test("responsable : créer, changer un rôle, réinitialiser (changement à nouveau obligatoire), désactiver, réactiver", async () => {
    const r = await connexion("ruben", "provisoire-ruben");
    const d = deps();
    assert.equal((await traiterComptes(r.jeton, { action: "creer", prenom: "edward", role: "equipe" }, d)).status, 409);
    assert.equal((await traiterComptes(r.jeton, { action: "creer", prenom: "é-dward", role: "equipe" }, d)).status, 400);
    assert.equal((await traiterComptes(r.jeton, { action: "creer", prenom: "marius", role: "chef" }, d)).status, 400);
    assert.equal((await traiterComptes(r.jeton, { action: "changer_role", prenom: "edward", role: "annonces" }, d)).corps.role, "annonces");
    const re = await traiterComptes(r.jeton, { action: "reinitialiser", prenom: "edward" }, d);
    assert.equal(re.status, 200);
    assert.equal((await d.profilParPrenom("edward")).doit_changer_mdp, true);
    await connexion("edward", re.corps.mot_de_passe_provisoire);
    assert.equal((await traiterComptes(r.jeton, { action: "desactiver", prenom: "edward" }, d)).status, 200);
    await assert.rejects(connexion("edward", re.corps.mot_de_passe_provisoire), /désactivé/);
    assert.equal((await d.profilParPrenom("edward")).actif, false);
    assert.equal((await traiterComptes(r.jeton, { action: "reactiver", prenom: "edward" }, d)).status, 200);
    await connexion("edward", re.corps.mot_de_passe_provisoire);
  });

  test("garde-fous : pas d'auto-désactivation, pas d'auto-rétrogradation", async () => {
    const r = await connexion("ruben", "provisoire-ruben");
    assert.equal((await traiterComptes(r.jeton, { action: "desactiver", prenom: "ruben" }, deps())).status, 400);
    assert.equal((await traiterComptes(r.jeton, { action: "changer_role", prenom: "ruben", role: "equipe" }, deps())).status, 400);
  });

  test("edward (équipe) et annonces : aucune gestion des comptes ; jeton invalide refusé", async () => {
    const e = await connexion("edward", "provisoire-edward");
    assert.equal((await traiterComptes(e.jeton, { action: "creer", prenom: "x1", role: "equipe" }, deps())).status, 403);
    assert.equal((await traiterComptes(e.jeton, { action: "reinitialiser", prenom: "ruben" }, deps())).status, 403);
    const a = await connexion("annie", "provisoire-annie");
    assert.equal((await traiterComptes(a.jeton, { action: "changer_role", prenom: "annie", role: "responsable" }, deps())).status, 403);
    assert.equal((await traiterComptes("faux", { action: "changer_mdp", nouveau: "12345678" }, deps())).status, 401);
    assert.equal((await traiterComptes(null, {}, deps())).status, 401);
  });

  test("responsable qui doit encore changer son mot de passe : gestion des comptes bloquée", async () => {
    await db.exec("update scan_profils set doit_changer_mdp = true where prenom = 'ruben'");
    const r = await connexion("ruben", "provisoire-ruben");
    assert.equal((await traiterComptes(r.jeton, { action: "creer", prenom: "marius", role: "equipe" }, deps())).status, 403);
  });
});
