// SCAN — gestion des comptes (créer, désactiver, réactiver, réinitialiser un mot de passe, changer un rôle)
// et changement de son propre mot de passe. Appelée par la page avec le jeton de session de l'utilisateur.
// La clé de service reste ICI, côté serveur (secret SUPABASE_SERVICE_ROLE_KEY fourni par Supabase) — jamais dans la page.
import { createClient } from "@supabase/supabase-js";
import { type Deps, motDePasseAleatoire, type Profil, traiterComptes } from "../_scan_partage/comptes.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reponse = (corps: unknown, status = 200) =>
  new Response(JSON.stringify(corps), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reponse({ ok: false, erreur: "Méthode non autorisée" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
                             { auth: { persistSession: false, autoRefreshToken: false } });
  const echec = (e: { message?: string } | null) => { if (e) throw new Error(e.message ?? "erreur Supabase"); };
  const deps: Deps = {
    async utilisateurDuJeton(jeton) {
      const { data, error } = await admin.auth.getUser(jeton);
      return error || !data?.user ? null : data.user.id;
    },
    async profil(id) {
      const { data, error } = await admin.from("scan_profils").select("user_id,prenom,role,actif,doit_changer_mdp").eq("user_id", id).maybeSingle();
      echec(error); return data as Profil | null;
    },
    async profilParPrenom(prenom) {
      const { data, error } = await admin.from("scan_profils").select("user_id,prenom,role,actif,doit_changer_mdp").eq("prenom", prenom).maybeSingle();
      echec(error); return data as Profil | null;
    },
    async creerUtilisateur(email, motDePasse) {
      const { data, error } = await admin.auth.admin.createUser({ email, password: motDePasse, email_confirm: true,
                                                                   app_metadata: { scan: true } });
      echec(error); return data.user!.id;
    },
    async changerMotDePasse(id, motDePasse) {
      const { error } = await admin.auth.admin.updateUserById(id, { password: motDePasse }); echec(error);
    },
    async bloquer(id, bloque) {
      const { error } = await admin.auth.admin.updateUserById(id, { ban_duration: bloque ? "876000h" : "none" }); echec(error);
    },
    async insererProfil(p) {
      const { error } = await admin.from("scan_profils").insert(p); echec(error);
    },
    async majProfil(id, champs) {
      const { error } = await admin.from("scan_profils").update({ ...champs, maj_le: new Date().toISOString() }).eq("user_id", id); echec(error);
    },
    async journaliser(j) {
      const { error } = await admin.from("scan_journal_comptes").insert(j); echec(error);
    },
    genererMotDePasse: () => motDePasseAleatoire(),
  };
  try {
    const jeton = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "") || null;
    const corps = await req.json().catch(() => ({}));
    const r = await traiterComptes(jeton, corps, deps);
    return reponse(r.corps, r.status);
  } catch (e) {
    // jamais le corps de la requête (il peut contenir un mot de passe) dans la réponse ou les journaux
    console.error("scan-comptes : erreur", (e as Error).message);
    return reponse({ ok: false, erreur: "Erreur serveur : réessayez ou prévenez Ruben" }, 500);
  }
});
