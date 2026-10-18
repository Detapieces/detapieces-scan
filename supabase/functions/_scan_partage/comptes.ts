// Gestion des comptes SCAN — logique pure (les accès Supabase sont injectés : testable hors ligne).
// Identifiant = prénom en minuscules ; compte technique = <prénom>@scan.detapieces.invalid (aucun e-mail envoyé, adresse confirmée d'office).
// Les mots de passe ne sont JAMAIS journalisés : un mot de passe provisoire n'est renvoyé qu'une fois, à l'écran du responsable.

export const DOMAINE = "scan.detapieces.invalid";
export const ROLES = ["equipe", "annonces", "responsable"] as const;
export type Role = (typeof ROLES)[number];
export const MDP_MIN = 8;

export type Profil = { user_id: string; prenom: string; role: Role; actif: boolean; doit_changer_mdp: boolean };

export type Journal = {
  par_user: string | null; par_prenom: string | null; cible_user: string | null; cible_prenom: string | null;
  action: "creation" | "desactivation" | "reactivation" | "reinitialisation_mdp" | "changement_role" | "changement_mdp";
  detail: string | null; appareil: string | null;
};

export type Deps = {
  utilisateurDuJeton(jeton: string): Promise<string | null>;          // id utilisateur, ou null si jeton invalide
  profil(userId: string): Promise<Profil | null>;
  profilParPrenom(prenom: string): Promise<Profil | null>;
  creerUtilisateur(email: string, motDePasse: string): Promise<string>; // renvoie l'id
  changerMotDePasse(userId: string, motDePasse: string): Promise<void>;
  bloquer(userId: string, bloque: boolean): Promise<void>;
  insererProfil(p: Profil & { cree_par: string | null }): Promise<void>;
  majProfil(userId: string, champs: Partial<Omit<Profil, "user_id" | "prenom">>): Promise<void>;
  journaliser(j: Journal): Promise<void>;
  genererMotDePasse(): string;
};

export type Reponse = { status: number; corps: Record<string, unknown> };

const ok = (corps: Record<string, unknown> = {}): Reponse => ({ status: 200, corps: { ok: true, ...corps } });
const ko = (status: number, erreur: string): Reponse => ({ status, corps: { ok: false, erreur } });

export function emailDe(prenom: string): string {
  return `${prenom}@${DOMAINE}`;
}

export function prenomValide(prenom: unknown): prenom is string {
  return typeof prenom === "string" && /^[a-z][a-z0-9-]{1,30}$/.test(prenom);
}

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
export function motDePasseAleatoire(longueur = 10, aleatoire: (n: number) => Uint32Array = (n) => crypto.getRandomValues(new Uint32Array(n))): string {
  const v = aleatoire(longueur);
  let s = "";
  for (let i = 0; i < longueur; i++) s += ALPHABET[v[i] % ALPHABET.length];
  return s;
}

// deno-lint-ignore no-explicit-any
export async function traiterComptes(jeton: string | null, corps: any, deps: Deps): Promise<Reponse> {
  if (!jeton) return ko(401, "Non connecté");
  const uid = await deps.utilisateurDuJeton(jeton);
  if (!uid) return ko(401, "Session expirée : reconnectez-vous");
  const moi = await deps.profil(uid);
  if (!moi || !moi.actif) return ko(403, "Droits insuffisants : compte inconnu ou désactivé");
  const appareil = typeof corps?.appareil === "string" ? corps.appareil.slice(0, 120) : null;
  const action = corps?.action;

  // --- tout utilisateur : changer son propre mot de passe -------------------------------------
  if (action === "changer_mdp") {
    const mdp = corps?.nouveau;
    if (typeof mdp !== "string" || mdp.length < MDP_MIN) return ko(400, `Mot de passe trop court : ${MDP_MIN} caractères minimum`);
    if (mdp.length > 72) return ko(400, "Mot de passe trop long (72 caractères maximum)");
    if (mdp.toLowerCase().includes(moi.prenom)) return ko(400, "Le mot de passe ne doit pas contenir votre prénom");
    await deps.changerMotDePasse(uid, mdp);
    await deps.majProfil(uid, { doit_changer_mdp: false });
    await deps.journaliser({ par_user: uid, par_prenom: moi.prenom, cible_user: uid, cible_prenom: moi.prenom,
                             action: "changement_mdp", detail: null, appareil });
    return ok();
  }

  // --- responsable uniquement ------------------------------------------------------------------
  if (moi.role !== "responsable") return ko(403, "Droits insuffisants : gestion des comptes réservée au responsable");
  if (moi.doit_changer_mdp) return ko(403, "Changez d'abord votre mot de passe (obligatoire à la première connexion)");

  const base = { par_user: uid, par_prenom: moi.prenom, appareil };

  if (action === "creer") {
    const prenom = typeof corps?.prenom === "string" ? corps.prenom.trim().toLowerCase() : "";
    const role = corps?.role;
    if (!prenomValide(prenom)) return ko(400, "Prénom invalide : lettres minuscules sans accent, chiffres ou tiret (2 à 31 caractères)");
    if (!ROLES.includes(role)) return ko(400, "Rôle invalide");
    if (await deps.profilParPrenom(prenom)) return ko(409, `Le compte « ${prenom} » existe déjà`);
    const provisoire = deps.genererMotDePasse();
    const id = await deps.creerUtilisateur(emailDe(prenom), provisoire);
    await deps.insererProfil({ user_id: id, prenom, role, actif: true, doit_changer_mdp: true, cree_par: uid });
    await deps.journaliser({ ...base, cible_user: id, cible_prenom: prenom, action: "creation", detail: `rôle ${role}` });
    return ok({ prenom, role, mot_de_passe_provisoire: provisoire });
  }

  const cible = typeof corps?.prenom === "string" ? await deps.profilParPrenom(corps.prenom.trim().toLowerCase()) : null;
  if (!["desactiver", "reactiver", "reinitialiser", "changer_role"].includes(action)) return ko(400, "Action inconnue");
  if (!cible) return ko(404, "Compte inconnu");
  const surSoi = cible.user_id === uid;
  const jb = { ...base, cible_user: cible.user_id, cible_prenom: cible.prenom };

  if (action === "desactiver") {
    if (surSoi) return ko(400, "Vous ne pouvez pas désactiver votre propre compte");
    await deps.bloquer(cible.user_id, true);
    await deps.majProfil(cible.user_id, { actif: false });
    await deps.journaliser({ ...jb, action: "desactivation", detail: null });
    return ok({ prenom: cible.prenom, actif: false });
  }
  if (action === "reactiver") {
    await deps.bloquer(cible.user_id, false);
    await deps.majProfil(cible.user_id, { actif: true });
    await deps.journaliser({ ...jb, action: "reactivation", detail: null });
    return ok({ prenom: cible.prenom, actif: true });
  }
  if (action === "reinitialiser") {
    const provisoire = deps.genererMotDePasse();
    await deps.changerMotDePasse(cible.user_id, provisoire);
    await deps.majProfil(cible.user_id, { doit_changer_mdp: true });
    await deps.journaliser({ ...jb, action: "reinitialisation_mdp", detail: null });
    return ok({ prenom: cible.prenom, mot_de_passe_provisoire: provisoire });
  }
  // changer_role
  const role = corps?.role;
  if (!ROLES.includes(role)) return ko(400, "Rôle invalide");
  if (surSoi && role !== "responsable") return ko(400, "Vous ne pouvez pas retirer votre propre rôle de responsable");
  await deps.majProfil(cible.user_id, { role });
  await deps.journaliser({ ...jb, action: "changement_role", detail: `${cible.role} → ${role}` });
  return ok({ prenom: cible.prenom, role });
}
