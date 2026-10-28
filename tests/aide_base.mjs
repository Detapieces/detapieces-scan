// Base Postgres HORS LIGNE (PGlite, en mémoire) : les VRAIES migrations SQL + les données d'essai,
// avec de petites doublures de ce que Supabase fournit (auth.users, auth.uid(), rôles anon / authenticated,
// et la structure des tables de veille lues par l'onglet Robots). Aucun accès réseau.
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = fileURLToPath(new URL("..", import.meta.url));
const lire = (...p) => readFileSync(join(RACINE, ...p), "utf8");

export const IDS = {
  ruben: "00000000-0000-4000-8000-000000000001",
  edward: "00000000-0000-4000-8000-000000000002",
  annie: "00000000-0000-4000-8000-000000000003",
  nouveau: "00000000-0000-4000-8000-000000000004",
  inconnu: "00000000-0000-4000-8000-000000000099",
};

const DOUBLURES = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
create schema auth;
create table auth.users (id uuid primary key, email text unique);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
-- structure (partielle) des tables de veille de production, pour l'onglet Robots
create table public.veille_decisions (
  id bigint generated always as identity primary key, cle text unique not null, cree_le timestamptz default now(),
  jour date not null, heure time not null, simulation boolean not null default false, evenement text not null,
  plateforme_vente text, canal_vente text, id_interne text, jumelle_plateforme text, jumelle_site text, jumelle_ref text,
  categorie text not null, motif text not null, constat text, deja_fait_hors_robot boolean not null default false, categorie_si_active text);
create table public.veille_resumes (jour date primary key, texte text not null);
alter table public.veille_decisions enable row level security; alter table public.veille_resumes enable row level security;
-- 28/10 : structure (partielle) de la VRAIE table des pièces et des tables robots lues par le scan réel, avec les fonctions
-- robots_* de production recopiées (robots_calculer_fiabilite réduite au seul cas « en_attente_annonce », testé en entier dans
-- 04_Robots_Action/tests/attente_annonce_scan.test.ts). Droits comme en production : service_role seul.
create table public.pieces (
  id bigint generated always as identity primary key, id_interne text, lot text, id_ovoko text unique, canal text, statut_liaison text,
  stock_partenaire text, source_import text, importe_le timestamptz not null default now(), maj_le timestamptz not null default now(),
  id_interne_en_double boolean not null default false, type_piece text, cote text, vehicule text, liaison_id bigint unique,
  id_interne_norme text, prix_ovoko numeric, code_additionnel_ovoko text, sku_ebay_fr text, interdit_ebay boolean, certitude text,
  a_reparer boolean not null default false, motif_liaison text, incoherence_releve text, origine text, etat_fiabilite text,
  motif_fiabilite text, fiabilite_le timestamptz, regle_identite text);
create table public.annonces_ebay (item_id text primary key, site text, piece_id bigint, role text, rang_fr smallint, statut text, remplace_par text);
create table public.ref_lots_stock (id bigint generated always as identity primary key, lot text, stock_arrivage text);
alter table public.pieces enable row level security; alter table public.annonces_ebay enable row level security;
alter table public.ref_lots_stock enable row level security;
revoke all on public.pieces, public.annonces_ebay, public.ref_lots_stock from public, anon, authenticated;
create function public.robots_id_norme(p text) returns text language sql immutable as
  $$ select nullif(upper(regexp_replace(coalesce(p, ''), '[[:space:]-]', '', 'g')), '') $$;
create function public.robots_id_valide(p text) returns boolean language sql immutable as
  $$ select coalesce(public.robots_id_norme(p) ~ '^Y?[0-9]{7,13}$', false) $$;
create function public.robots_lot_de(p text) returns text language sql immutable as
  $$ select case when public.robots_id_valide(p) then left(public.robots_id_norme(p), length(public.robots_id_norme(p)) - 3) end $$;
create function public.robots_lot_connu(p_lot text) returns boolean language sql stable as $$
  select p_lot is not null and (exists (select 1 from public.pieces where public.robots_id_norme(lot) = public.robots_id_norme(p_lot))
                                or exists (select 1 from public.ref_lots_stock where public.robots_id_norme(lot) = public.robots_id_norme(p_lot))) $$;
create function public.robots_calculer_fiabilite(p_pieces bigint[] default null) returns jsonb language sql as $$
  update public.pieces p set etat_fiabilite = 'en_attente_annonce', statut_liaison = 'en_attente_annonce'
   where (p_pieces is null or p.id = any(p_pieces)) and p.origine = 'scan' and p.id_ovoko is null
     and not exists (select 1 from public.annonces_ebay e where e.piece_id = p.id);
  select '1'::jsonb $$;
revoke execute on all functions in schema public from public, anon, authenticated;
`;

export async function nouvelleBase({ donnees = true, comptes = true } = {}) {
  const db = new PGlite();
  await db.exec(DOUBLURES);
  const migr = readdirSync(join(RACINE, "supabase", "migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const f of migr) await db.exec(lire("supabase", "migrations", f));
  if (donnees) await db.exec(lire("supabase", "donnees", "scan_test_donnees.sql"));
  if (comptes) {
    await db.exec(`
      insert into auth.users values ('${IDS.ruben}', 'ruben@scan.detapieces.invalid'), ('${IDS.edward}', 'edward@scan.detapieces.invalid'),
                                    ('${IDS.annie}', 'annie@scan.detapieces.invalid'), ('${IDS.nouveau}', 'nouveau@scan.detapieces.invalid');
      insert into public.scan_profils (user_id, prenom, role, doit_changer_mdp) values
        ('${IDS.ruben}', 'ruben', 'responsable', false), ('${IDS.edward}', 'edward', 'equipe', false),
        ('${IDS.annie}', 'annie', 'annonces', false), ('${IDS.nouveau}', 'nouveau', 'equipe', true);`);
  }
  return db;
}

/** Exécute fn en tant qu'utilisateur connecté (rôle authenticated + auth.uid()), puis revient au superutilisateur. */
export async function en(db, uid, fn) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid ?? ""}', false);`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}

export async function enAnonyme(db, fn) {
  await db.exec(`set role anon; select set_config('request.jwt.claim.sub', '', false);`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}

/** scan_action en tant que uid ; renvoie le jsonb ou lève l'erreur (message de la base). */
export async function action(db, uid, id, act, empl = null, commentaire = null, phys = null, comm = null) {
  return en(db, uid, async () => {
    const r = await db.query("select public.scan_action($1, $2, $3, $4, 'test-appareil', $5, $6) as r", [id, act, empl, commentaire, phys, comm]);
    return r.rows[0].r;
  });
}

export async function piece(db, id) {
  return (await db.query("select * from public.scan_test_pieces_vue where id_interne = $1", [id])).rows[0];
}

/** Attend une erreur dont le message contient `morceau`. */
export async function refuse(promesse, morceau) {
  try { await promesse; } catch (e) {
    if (morceau && !String(e.message).includes(morceau)) throw new Error(`Message inattendu : « ${e.message} » (attendu : « ${morceau} »)`);
    return e.message;
  }
  throw new Error(`Aurait dû être refusé (${morceau})`);
}
