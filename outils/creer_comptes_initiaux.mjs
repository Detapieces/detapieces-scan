// Crée les comptes SCAN initiaux (définitifs) : ruben (responsable), edward (équipe).
// Lit l'adresse et la clé de service dans Code\01_Supabase_Setup\.env (jamais affichées, jamais écrites ailleurs).
// Les mots de passe provisoires sont affichés UNE SEULE FOIS dans la console et ne sont écrits dans aucun fichier.
// Changement obligatoire à la première connexion. Usage : node outils/creer_comptes_initiaux.mjs
import { readFileSync } from "node:fs";
import { emailDe, motDePasseAleatoire } from "../supabase/functions/_scan_partage/comptes.ts";

const env = Object.fromEntries(readFileSync(new URL("../../01_Supabase_Setup/.env", import.meta.url), "utf8")
  .split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim().replace(/^"|"$/g, "")]));
const URL_SB = env.SUPABASE_URL, CLE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_SB || !CLE) { console.error("SUPABASE_URL ou clé de service absente du .env"); process.exit(1); }
const H = { apikey: CLE, Authorization: `Bearer ${CLE}`, "Content-Type": "application/json" };
const masquer = (t) => String(t).split(CLE).join("***");

const COMPTES = [["ruben", "responsable"], ["edward", "equipe"]];

async function appel(chemin, options = {}) {
  const r = await fetch(`${URL_SB}${chemin}`, { ...options, headers: { ...H, ...(options.headers ?? {}) } });
  const texte = await r.text();
  if (!r.ok) throw new Error(`${chemin} : HTTP ${r.status} ${masquer(texte).slice(0, 300)}`);
  return texte ? JSON.parse(texte) : null;
}

for (const [prenom, role] of COMPTES) {
  const existe = await appel(`/rest/v1/scan_profils?prenom=eq.${prenom}&select=prenom`);
  if (existe.length) { console.log(`${prenom} : existe déjà — rien fait`); continue; }
  const mdp = motDePasseAleatoire();
  const u = await appel("/auth/v1/admin/users", { method: "POST",
    body: JSON.stringify({ email: emailDe(prenom), password: mdp, email_confirm: true, app_metadata: { scan: true } }) });
  await appel("/rest/v1/scan_profils", { method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ user_id: u.id, prenom, role, actif: true, doit_changer_mdp: true }) });
  await appel("/rest/v1/scan_journal_comptes", { method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ par_prenom: "installation", cible_user: u.id, cible_prenom: prenom, action: "creation", detail: `rôle ${role} (création initiale)` }) });
  console.log(`${prenom} (${role}) : créé — mot de passe provisoire : ${mdp}`);
}
