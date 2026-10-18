-- =====================================================================
-- SCAN Detapieces — base (18/10/2026).
-- Crée UNIQUEMENT de nouveaux objets :
--   * DÉFINITIFS (serviront en production) : scan_profils, scan_journal_comptes, fonctions d'identité scan_*.
--   * DE TEST (données pièces) : tables scan_test_*.
-- Ne touche à AUCUNE table existante, ni au bot des commandes, ni à la veille (bot_reglages intact).
-- RLS active sur toutes les nouvelles tables ; aucune écriture directe depuis la page : tout passe par des fonctions contrôlées.
-- Une transaction.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Profils (DÉFINITIFS)
-- ---------------------------------------------------------------------
create table if not exists public.scan_profils (
  user_id           uuid primary key references auth.users(id) on delete restrict,
  prenom            text not null unique check (prenom ~ '^[a-z][a-z0-9-]{1,30}$'),
  role              text not null check (role in ('equipe', 'annonces', 'responsable')),
  actif             boolean not null default true,
  doit_changer_mdp  boolean not null default true,
  cree_le           timestamptz not null default now(),
  cree_par          uuid,
  maj_le            timestamptz not null default now()
);

-- Journal des actions sur les comptes (jamais de mot de passe ici)
create table if not exists public.scan_journal_comptes (
  id            bigint generated always as identity primary key,
  cree_le       timestamptz not null default now(),
  par_user      uuid,
  par_prenom    text,
  cible_user    uuid,
  cible_prenom  text,
  action        text not null check (action in ('creation', 'desactivation', 'reactivation', 'reinitialisation_mdp',
                                                'changement_role', 'changement_mdp')),
  detail        text,
  appareil      text
);

-- Identité de l'appelant (security definer : lit scan_profils sans dépendre de la RLS)
create or replace function public.scan_role_actif() returns text
language sql stable security definer set search_path = public as $$
  select p.role from public.scan_profils p where p.user_id = auth.uid() and p.actif
$$;

create or replace function public.scan_est_actif() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.scan_profils p where p.user_id = auth.uid() and p.actif)
$$;

create or replace function public.scan_est_responsable() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.scan_profils p where p.user_id = auth.uid() and p.actif and p.role = 'responsable')
$$;

-- ---------------------------------------------------------------------
-- 2. Configuration (TEST) : niveaux d'emplacement et réglages — modifiables sans toucher au code
-- ---------------------------------------------------------------------
create table if not exists public.scan_test_config_niveaux (
  rang            integer primary key check (rang between 1 and 9),
  cle             text not null unique,
  libelle         text not null,
  prefixe         text not null default '' check (prefixe ~ '^[A-Z]{0,4}$'),
  chiffres        integer not null default 2 check (chiffres between 1 and 4),
  parent_rang     integer references public.scan_test_config_niveaux(rang),
  libre           boolean not null default false,   -- niveau libre (réserve) : code saisi librement, sans parent imposé
  accepte_pieces  boolean not null default true
);

create table if not exists public.scan_test_config (
  cle          text primary key,
  valeur       text not null,
  description  text
);

insert into public.scan_test_config_niveaux (rang, cle, libelle, prefixe, chiffres, parent_rang, libre, accepte_pieces) values
  (1, 'local',   'Local',          'L', 1, null, false, true),
  (2, 'rangee',  'Rangée / rack',  'R', 2, 1,    false, true),
  (3, 'etage',   'Étage',          'E', 1, 2,    false, true),
  (4, 'bac',     'Bac',            'B', 2, 3,    false, true),
  (5, 'reserve', 'Réserve (libre)','',  2, null, true,  true)
on conflict (rang) do nothing;

insert into public.scan_test_config (cle, valeur, description) values
  ('separateur_emplacement', '-',  'Séparateur entre niveaux dans un code d''emplacement (ex. L1-R02-E3-B05)'),
  ('delai_republication_heures', '24', 'Délai après « Republier » au-delà duquel le robot de scan alerte s''il ne trouve aucune annonce régénérée'),
  ('robot_scan_mode', 'veille', 'Robot de scan : « veille » = écrit seulement ce qu''il aurait fait (aucune autre valeur prévue à ce stade)')
on conflict (cle) do nothing;

-- Types de pièces « Ovoko uniquement » (airbags, modules d'airbag, ceintures) : codes nomenclature à renseigner par Ruben.
create table if not exists public.scan_test_types_ovoko_uniquement (
  code_piece  text primary key,
  libelle     text not null
);

-- ---------------------------------------------------------------------
-- 3. Emplacements (TEST) — un id stable ; renommer / déplacer garde l'historique
-- ---------------------------------------------------------------------
create table if not exists public.scan_test_emplacements (
  id           bigint generated always as identity primary key,
  code         text not null unique check (code ~ '^[A-Z0-9][A-Z0-9-]{0,39}$'),
  niveau_rang  integer not null references public.scan_test_config_niveaux(rang),
  parent_id    bigint references public.scan_test_emplacements(id),
  libelle      text,
  actif        boolean not null default true,
  essai        boolean not null default false,
  cree_le      timestamptz not null default now()
);

create table if not exists public.scan_test_emplacements_historique (
  id                 bigint generated always as identity primary key,
  cree_le            timestamptz not null default now(),
  emplacement_id     bigint not null references public.scan_test_emplacements(id),
  action             text not null check (action in ('creation', 'renommage', 'deplacement', 'desactivation', 'reactivation')),
  ancien_code        text,
  nouveau_code       text,
  ancien_parent_id   bigint,
  nouveau_parent_id  bigint,
  par_user           uuid,
  par_prenom         text
);

-- ---------------------------------------------------------------------
-- 4. Pièces (TEST)
-- ---------------------------------------------------------------------
create table if not exists public.scan_test_pieces (
  id_interne                    text primary key check (id_interne ~ '^[A-Za-z0-9]+-[0-9]{1,4}$'),
  lot                           text not null,
  code_piece                    text not null,
  libelle                       text not null,
  cote                          text,
  marque                        text,
  modele                        text,
  annee                         text,
  motorisation                  text,
  etat_physique                 text not null default 'attendue' check (etat_physique in
                                  ('attendue', 'supposee_presente', 'receptionnee', 'rangee', 'absente', 'partie', 'en_retour', 'rebut')),
  etat_commercial               text not null default 'annonce_non_creee' check (etat_commercial in
                                  ('annonce_non_creee', 'prete_a_publier', 'prete_a_republier', 'en_vente', 'reservee', 'vendue',
                                   'retiree', 'retour_attente_decision')),
  ovoko_uniquement              boolean not null default false,
  gardee_de_cote                boolean not null default false,
  emplacement_id                bigint references public.scan_test_emplacements(id),
  retour_decision               text check (retour_decision in ('republier')),
  derniere_sortie               text check (derniere_sortie in ('commande', 'comptoir')),
  commercial_avant_reservation  text,
  ebay_fr                       text,
  ebay_de                       text,      -- plusieurs n° séparés par « | » (comme liaison_pieces)
  ebay_it                       text,
  ebay_es                       text,
  ovoko_id                      text,
  remarques                     text,
  source                        text,
  cree_le                       timestamptz not null default now(),
  maj_le                        timestamptz not null default now(),
  maj_par                       uuid,
  constraint scan_test_pieces_id_lot check (id_interne = lot || '-' || code_piece)
);
create index if not exists scan_test_pieces_lot on public.scan_test_pieces (lot);
create index if not exists scan_test_pieces_empl on public.scan_test_pieces (emplacement_id);

-- ---------------------------------------------------------------------
-- 5. Événements de scan (TEST) — une ligne par geste ; c'est la file que les robots liront. Rien ne s'efface.
-- ---------------------------------------------------------------------
create table if not exists public.scan_test_evenements (
  id                 bigint generated always as identity primary key,
  cree_le            timestamptz not null default now(),
  id_interne         text not null references public.scan_test_pieces(id_interne),
  action             text not null,
  physique_avant     text,
  physique_apres     text,
  commercial_avant   text,
  commercial_apres   text,
  emplacement_avant  text,
  emplacement_apres  text,
  user_id            uuid,
  prenom             text,
  role               text,
  appareil           text,
  commentaire        text,
  traite_robot       boolean not null default false,
  resultat_robot     text,
  traite_le          timestamptz
);
create index if not exists scan_test_evenements_piece on public.scan_test_evenements (id_interne, id);
create index if not exists scan_test_evenements_file on public.scan_test_evenements (id) where not traite_robot;

-- ---------------------------------------------------------------------
-- 6. Robot de scan (TEST) : annonces SIMULÉES (aucun appel réel) et traces de ce qu'il aurait fait
-- ---------------------------------------------------------------------
create table if not exists public.scan_test_plateformes_simulees (
  id                bigint generated always as identity primary key,
  plateforme        text not null check (plateforme in ('ebay', 'ovoko')),
  site              text not null check (site in ('FR', 'DE', 'IT', 'ES', 'OVOKO')),
  annonce_ref       text not null,
  sku               text,             -- eBay : SKU ; Ovoko : vide
  code_additionnel  text,             -- Ovoko : Code additionnel (lot-NNN) ; eBay : vide
  lot               text,             -- lot lu dans l'annonce (caractéristique, titre…), indépendant du SKU
  titre             text,
  statut            text not null check (statut in ('active', 'terminee', 'vendue')),
  ancienne_ref      text,             -- n° de l'annonce d'origine quand la plateforme a régénéré l'annonce
  cree_le           timestamptz not null default now(),
  unique (plateforme, site, annonce_ref)
);

create table if not exists public.scan_test_robot_traces (
  id            bigint generated always as identity primary key,
  cle           text not null unique,     -- une trace par (événement, annonce, décision) : le robot est rejouable sans doublon
  cree_le       timestamptz not null default now(),
  evenement_id  bigint references public.scan_test_evenements(id),
  id_interne    text,
  declencheur   text,
  plateforme    text,
  site          text,
  annonce_ref   text,
  decision      text not null check (decision in ('aurait_ferme', 'aurait_relie', 'aurait_demande_confirmation', 'aurait_alerte', 'rien')),
  motif         text not null,
  preuves       jsonb not null default '[]'::jsonb,
  alerte        text,
  mode          text not null default 'veille' check (mode = 'veille')
);

-- ---------------------------------------------------------------------
-- 7. Rien ne s'efface : triggers d'interdiction
-- ---------------------------------------------------------------------
create or replace function public.scan_interdire_suppression() returns trigger
language plpgsql as $$
begin
  raise exception 'Suppression interdite sur % : l''historique ne s''efface pas', tg_table_name;
end $$;

create or replace function public.scan_evenement_immuable() returns trigger
language plpgsql as $$
begin
  -- seules les colonnes du robot peuvent évoluer
  if (new.id, new.cree_le, new.id_interne, new.action, new.physique_avant, new.physique_apres, new.commercial_avant,
      new.commercial_apres, new.emplacement_avant, new.emplacement_apres, new.user_id, new.prenom, new.role, new.appareil,
      new.commentaire)
     is distinct from
     (old.id, old.cree_le, old.id_interne, old.action, old.physique_avant, old.physique_apres, old.commercial_avant,
      old.commercial_apres, old.emplacement_avant, old.emplacement_apres, old.user_id, old.prenom, old.role, old.appareil,
      old.commentaire) then
    raise exception 'Un événement de scan ne se modifie pas (seuls traite_robot / resultat_robot / traite_le évoluent)';
  end if;
  return new;
end $$;

drop trigger if exists scan_test_evenements_sans_suppression on public.scan_test_evenements;
create trigger scan_test_evenements_sans_suppression before delete on public.scan_test_evenements
  for each row execute function public.scan_interdire_suppression();
drop trigger if exists scan_test_evenements_immuable on public.scan_test_evenements;
create trigger scan_test_evenements_immuable before update on public.scan_test_evenements
  for each row execute function public.scan_evenement_immuable();
drop trigger if exists scan_test_pieces_sans_suppression on public.scan_test_pieces;
create trigger scan_test_pieces_sans_suppression before delete on public.scan_test_pieces
  for each row execute function public.scan_interdire_suppression();
drop trigger if exists scan_test_empl_hist_sans_suppression on public.scan_test_emplacements_historique;
create trigger scan_test_empl_hist_sans_suppression before delete on public.scan_test_emplacements_historique
  for each row execute function public.scan_interdire_suppression();
drop trigger if exists scan_test_robot_traces_sans_suppression on public.scan_test_robot_traces;
create trigger scan_test_robot_traces_sans_suppression before delete on public.scan_test_robot_traces
  for each row execute function public.scan_interdire_suppression();
drop trigger if exists scan_journal_comptes_sans_suppression on public.scan_journal_comptes;
create trigger scan_journal_comptes_sans_suppression before delete on public.scan_journal_comptes
  for each row execute function public.scan_interdire_suppression();

-- ---------------------------------------------------------------------
-- 8. RLS : lecture pour les comptes actifs, AUCUNE écriture directe (anon : rien)
-- ---------------------------------------------------------------------
alter table public.scan_profils                      enable row level security;
alter table public.scan_journal_comptes              enable row level security;
alter table public.scan_test_config_niveaux          enable row level security;
alter table public.scan_test_config                  enable row level security;
alter table public.scan_test_types_ovoko_uniquement  enable row level security;
alter table public.scan_test_emplacements            enable row level security;
alter table public.scan_test_emplacements_historique enable row level security;
alter table public.scan_test_pieces                  enable row level security;
alter table public.scan_test_evenements              enable row level security;
alter table public.scan_test_plateformes_simulees    enable row level security;
alter table public.scan_test_robot_traces            enable row level security;

revoke all on public.scan_profils, public.scan_journal_comptes, public.scan_test_config_niveaux, public.scan_test_config,
              public.scan_test_types_ovoko_uniquement, public.scan_test_emplacements, public.scan_test_emplacements_historique,
              public.scan_test_pieces, public.scan_test_evenements, public.scan_test_plateformes_simulees,
              public.scan_test_robot_traces
  from anon, authenticated;
grant select on public.scan_profils, public.scan_journal_comptes, public.scan_test_config_niveaux, public.scan_test_config,
                public.scan_test_types_ovoko_uniquement, public.scan_test_emplacements, public.scan_test_emplacements_historique,
                public.scan_test_pieces, public.scan_test_evenements, public.scan_test_robot_traces
  to authenticated;

drop policy if exists scan_profils_lecture on public.scan_profils;
create policy scan_profils_lecture on public.scan_profils for select to authenticated
  using (user_id = auth.uid() or public.scan_est_responsable());
drop policy if exists scan_journal_comptes_lecture on public.scan_journal_comptes;
create policy scan_journal_comptes_lecture on public.scan_journal_comptes for select to authenticated
  using (public.scan_est_responsable());

do $$
declare t text;
begin
  foreach t in array array['scan_test_config_niveaux', 'scan_test_config', 'scan_test_types_ovoko_uniquement',
                           'scan_test_emplacements', 'scan_test_emplacements_historique', 'scan_test_pieces',
                           'scan_test_evenements', 'scan_test_robot_traces'] loop
    execute format('drop policy if exists %I on public.%I', t || '_lecture', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.scan_est_actif())', t || '_lecture', t);
  end loop;
end $$;
-- scan_test_plateformes_simulees : aucune politique (lue seulement par le robot, côté serveur).

-- ---------------------------------------------------------------------
-- 9. Vue de lecture (security_invoker : la RLS de l'appelant s'applique)
-- ---------------------------------------------------------------------
create or replace view public.scan_test_pieces_vue as
select p.id_interne, p.lot, p.code_piece, p.libelle, p.cote, p.marque, p.modele, p.annee, p.motorisation,
       concat_ws(' ', p.marque, p.modele, p.annee, p.motorisation) as vehicule,
       p.etat_physique, p.etat_commercial,
       (p.ovoko_uniquement or t.code_piece is not null) as ovoko_uniquement,
       p.ovoko_uniquement as ovoko_uniquement_marque, (t.code_piece is not null) as ovoko_uniquement_type,
       p.gardee_de_cote, e.code as emplacement, p.emplacement_id, p.retour_decision, p.derniere_sortie,
       p.ebay_fr, p.ebay_de, p.ebay_it, p.ebay_es, p.ovoko_id, p.remarques, p.maj_le
  from public.scan_test_pieces p
  left join public.scan_test_emplacements e on e.id = p.emplacement_id
  left join public.scan_test_types_ovoko_uniquement t on t.code_piece = p.code_piece;
alter view public.scan_test_pieces_vue set (security_invoker = true);
revoke all on public.scan_test_pieces_vue from anon, authenticated;
grant select on public.scan_test_pieces_vue to authenticated;

revoke execute on function public.scan_role_actif(), public.scan_est_actif(), public.scan_est_responsable() from public, anon;
grant execute on function public.scan_role_actif(), public.scan_est_actif(), public.scan_est_responsable() to authenticated;

commit;
