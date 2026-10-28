-- =====================================================================
-- SCAN Detapieces — branchement sur la VRAIE table des pièces (28/10/2026, plan validé par Ruben le 28/10).
-- La page reconnaît les pièces de public.pieces (ID interne comparé NORMALISÉ : majuscules, tirets et espaces retirés).
-- Seuls gestes permis sur une vraie pièce : « présence confirmée » et « emplacement ». Un responsable peut enregistrer une pièce
-- présente sur place mais absente de la base (ID interne scanné + type) : origine = 'scan', présente confirmée, annonce pas
-- encore créée. AUCUN état vendu / réservé / parti n'existe ici (contrainte CHECK) : rien ne peut être pris pour une vente.
-- Les robots ne lisent pas scan_pieces_etat / scan_pieces_evenements. Aucune des 11 fonctions SECURITY DEFINER existantes
-- n'est modifiée ; scan_test_* et la structure de public.pieces ne changent pas.
-- Droits (règle Supabase du 23/10) : tables RLS + REVOKE public / anon / authenticated (tables et séquences) + GRANT au seul
-- service_role + règle RLS explicite ; la page passe uniquement par les fonctions ci-dessous (EXECUTE au seul authenticated).
-- Dépend de : public.pieces, public.annonces_ebay, public.ref_lots_stock, robots_id_norme / robots_id_valide / robots_lot_de /
-- robots_lot_connu / robots_calculer_fiabilite (04_Robots_Action, migration 20261028110000_attente_annonce_scan.sql d'abord).
-- Retour arrière : supabase/annuler/annuler_scan_reel.sql. Une transaction.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------
create table if not exists public.scan_pieces_etat (
  piece_id         bigint primary key references public.pieces (id),
  etat_physique    text not null default 'presente_confirmee' check (etat_physique in ('presente_confirmee')),
  etat_commercial  text check (etat_commercial is null or etat_commercial in ('annonce_non_creee')),  -- null = inconnu (non inventé)
  emplacement_id   bigint references public.scan_test_emplacements (id),
  confirme_le      timestamptz not null default now(),
  confirme_par     uuid,
  confirme_prenom  text,
  maj_le           timestamptz not null default now(),
  maj_par          uuid
);
comment on table public.scan_pieces_etat is
  'Scan sur les VRAIES pièces (public.pieces) : présence confirmée et emplacement seulement. Jamais lu par les robots eBay / Ovoko.';

create table if not exists public.scan_pieces_evenements (
  id                bigint generated always as identity primary key,
  cree_le           timestamptz not null default now(),
  piece_id          bigint not null,                    -- sans clé étrangère : l'historique survit à tout
  id_interne        text not null,
  action            text not null check (action in ('enregistrement', 'confirmation_presence', 'rangement', 'changement_emplacement')),
  physique_avant    text, physique_apres text, commercial_avant text, commercial_apres text,
  emplacement_avant text, emplacement_apres text,
  user_id           uuid not null, prenom text not null, role text not null, appareil text, commentaire text
);
create index if not exists scan_pieces_evenements_piece on public.scan_pieces_evenements (piece_id);
create index if not exists scan_pieces_etat_emplacement on public.scan_pieces_etat (emplacement_id);

create or replace function public.scan_reel_journal_immuable() returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception 'Journal du scan réel : modification interdite (l''historique ne se réécrit pas)';
end $$;
drop trigger if exists scan_pieces_evenements_immuable on public.scan_pieces_evenements;
create trigger scan_pieces_evenements_immuable before update on public.scan_pieces_evenements
  for each row execute function public.scan_reel_journal_immuable();
drop trigger if exists scan_pieces_evenements_sans_suppression on public.scan_pieces_evenements;
create trigger scan_pieces_evenements_sans_suppression before delete on public.scan_pieces_evenements
  for each row execute function public.scan_interdire_suppression();

-- Droits des tables : service_role seul (la page passe par les fonctions)
alter table public.scan_pieces_etat enable row level security;
alter table public.scan_pieces_evenements enable row level security;
revoke all on public.scan_pieces_etat, public.scan_pieces_evenements from public, anon, authenticated;
revoke all on sequence public.scan_pieces_evenements_id_seq from public, anon, authenticated;
grant select, insert, update, delete on public.scan_pieces_etat, public.scan_pieces_evenements to service_role;
grant usage, select on sequence public.scan_pieces_evenements_id_seq to service_role;
drop policy if exists service_role_seul on public.scan_pieces_etat;
create policy service_role_seul on public.scan_pieces_etat for all to service_role using (true) with check (true);
drop policy if exists service_role_seul on public.scan_pieces_evenements;
create policy service_role_seul on public.scan_pieces_evenements for all to service_role using (true) with check (true);
revoke execute on function public.scan_reel_journal_immuable() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Outils internes (non exposés)
-- ---------------------------------------------------------------------
-- Profil actif de l'appelant ; p_ecriture : mot de passe changé et rôle équipe / responsable exigés
create or replace function public.scan_reel_profil(p_ecriture boolean)
returns public.scan_profils language plpgsql stable security definer set search_path = public as $$
declare v public.scan_profils;
begin
  select * into v from public.scan_profils where user_id = auth.uid();
  if not found or not v.actif then raise exception 'Droits insuffisants : compte inconnu ou désactivé'; end if;
  if p_ecriture then
    if v.doit_changer_mdp then raise exception 'Changez d''abord votre mot de passe (obligatoire à la première connexion)'; end if;
    if v.role not in ('equipe', 'responsable') then
      raise exception 'Droits insuffisants : action réservée à l''équipe sur site ou au responsable';
    end if;
  end if;
  return v;
end $$;

-- La pièce réelle désignée par un ID (normalisé) : exactement une ligne, sinon refus
create or replace function public.scan_reel_une_piece(p_id_interne text)
returns public.pieces language plpgsql stable security definer set search_path = public as $$
declare v_n text := public.robots_id_norme(p_id_interne); v_nb integer; p public.pieces;
begin
  if v_n is null or not public.robots_id_valide(v_n) then
    raise exception 'ID interne non valide : %', coalesce(nullif(trim(p_id_interne), ''), '(vide)');
  end if;
  select count(*) into v_nb from public.pieces where id_interne_norme = v_n;
  if v_nb = 0 then raise exception 'Pièce inconnue dans la base : %', p_id_interne; end if;
  if v_nb > 1 then raise exception 'ID interne % porté par % lignes (doublon) : aucune action possible au scan', p_id_interne, v_nb; end if;
  select * into p from public.pieces where id_interne_norme = v_n;
  if not (btrim(coalesce(p.stock_partenaire, '')) = '' or p.stock_partenaire = 'non') then
    raise exception 'Pièce % : stock partenaire (%), pas notre stock', p.id_interne, p.stock_partenaire;
  end if;
  return p;
end $$;

revoke execute on function public.scan_reel_profil(boolean) from public, anon, authenticated;
revoke execute on function public.scan_reel_une_piece(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Lecture : fiche d'une vraie pièce (tous les comptes actifs)
-- ---------------------------------------------------------------------
create or replace function public.scan_reel_lire(p_code text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_n    text := public.robots_id_norme(p_code);
  v_lot  text;
  v_res  jsonb;
begin
  perform public.scan_reel_profil(false);
  if v_n is null then return jsonb_build_object('trouve', 0, 'id_valide', false); end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'id_interne', p.id_interne, 'lot', p.lot, 'type_piece', p.type_piece, 'cote', p.cote, 'vehicule', p.vehicule,
           'canal', p.canal, 'id_ovoko', p.id_ovoko, 'sku_ebay_fr', p.sku_ebay_fr, 'interdit_ebay', p.interdit_ebay,
           'stock_partenaire', p.stock_partenaire, 'etat_fiabilite', p.etat_fiabilite, 'origine', p.origine,
           'ebay_fr', (select string_agg(e.item_id, ' / ' order by e.rang_fr, e.item_id) from public.annonces_ebay e
                        where e.piece_id = p.id and e.role = 'FR' and e.remplace_par is null),
           'copies', (select string_agg(e.site || ' ' || e.item_id, ', ' order by e.site, e.item_id) from public.annonces_ebay e
                       where e.piece_id = p.id and e.role <> 'FR' and e.remplace_par is null),
           'etat_physique', s.etat_physique, 'etat_commercial', s.etat_commercial, 'emplacement', em.code,
           'confirme_le', s.confirme_le, 'confirme_prenom', s.confirme_prenom,
           'id_test', (select t.id_interne from public.scan_test_pieces t
                        where upper(regexp_replace(t.id_interne, '[[:space:]-]', '', 'g')) = v_n limit 1))
           order by p.id), '[]'::jsonb)
    into v_res
    from public.pieces p
    left join public.scan_pieces_etat s on s.piece_id = p.id
    left join public.scan_test_emplacements em on em.id = s.emplacement_id
   where p.id_interne_norme = v_n;
  if jsonb_array_length(v_res) > 0 then
    return jsonb_build_object('trouve', jsonb_array_length(v_res), 'pieces', v_res);
  end if;
  v_lot := public.robots_lot_de(v_n);
  return jsonb_build_object('trouve', 0, 'id_valide', public.robots_id_valide(v_n), 'lot', v_lot,
    'id_formate', case when v_lot is not null then v_lot || '-' || right(v_n, 3) end,
    'lot_connu', coalesce(public.robots_lot_connu(v_lot), false),
    'lot_partenaire', exists (select 1 from public.ref_lots_stock r where public.robots_id_norme(r.lot) = v_lot and r.stock_arrivage ~* 'ECO'));
end $$;

-- Vraies pièces rangées dans un emplacement (onglet emplacement de la page)
create or replace function public.scan_reel_emplacement(p_emplacement_id bigint)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.scan_reel_profil(false);
  return coalesce((select jsonb_agg(jsonb_build_object('id_interne', p.id_interne, 'type_piece', p.type_piece) order by p.id_interne)
                     from public.scan_pieces_etat s join public.pieces p on p.id = s.piece_id
                    where s.emplacement_id = p_emplacement_id), '[]'::jsonb);
end $$;

-- Types de pièce déjà utilisés dans la base (liste déroulante de l'enregistrement)
create or replace function public.scan_reel_types()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.scan_reel_profil(false);
  return coalesce((select jsonb_agg(t order by t) from (select distinct btrim(type_piece) t from public.pieces
                     where nullif(btrim(type_piece), '') is not null) x), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- 4. Gestes sur une vraie pièce : présence confirmée, emplacement (équipe et responsable)
-- ---------------------------------------------------------------------
create or replace function public.scan_reel_confirmer_presence(p_id_interne text, p_appareil text default null,
                                                               p_commentaire text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prof public.scan_profils := public.scan_reel_profil(true);
  p      public.pieces := public.scan_reel_une_piece(p_id_interne);
  s      public.scan_pieces_etat;
  v_empl text;
  v_id   bigint;
begin
  select * into s from public.scan_pieces_etat where piece_id = p.id for update;
  select code into v_empl from public.scan_test_emplacements where id = s.emplacement_id;
  insert into public.scan_pieces_etat as x (piece_id, etat_physique, confirme_le, confirme_par, confirme_prenom, maj_le, maj_par)
  values (p.id, 'presente_confirmee', now(), v_prof.user_id, v_prof.prenom, now(), v_prof.user_id)
  on conflict (piece_id) do update set etat_physique = 'presente_confirmee', confirme_le = now(), confirme_par = v_prof.user_id,
         confirme_prenom = v_prof.prenom, maj_le = now(), maj_par = v_prof.user_id;
  insert into public.scan_pieces_evenements (piece_id, id_interne, action, physique_avant, physique_apres, commercial_avant, commercial_apres,
                                             emplacement_avant, emplacement_apres, user_id, prenom, role, appareil, commentaire)
  values (p.id, p.id_interne, 'confirmation_presence', s.etat_physique, 'presente_confirmee', s.etat_commercial, s.etat_commercial,
          v_empl, v_empl, v_prof.user_id, v_prof.prenom, v_prof.role, left(nullif(trim(coalesce(p_appareil, '')), ''), 120),
          nullif(trim(coalesce(p_commentaire, '')), ''))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'evenement_id', v_id, 'evenement', 'confirmation_presence', 'id_interne', p.id_interne);
end $$;

-- Ranger / changer d'emplacement : vaut aussi confirmation de présence (la pièce est dans les mains)
create or replace function public.scan_reel_ranger(p_id_interne text, p_emplacement text, p_appareil text default null,
                                                   p_commentaire text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prof public.scan_profils := public.scan_reel_profil(true);
  p      public.pieces := public.scan_reel_une_piece(p_id_interne);
  s      public.scan_pieces_etat;
  e      public.scan_test_emplacements;
  v_avant text;
  v_evt  text;
  v_id   bigint;
begin
  select em.* into e from public.scan_test_emplacements em
    join public.scan_test_config_niveaux n on n.rang = em.niveau_rang
   where em.code = upper(trim(coalesce(p_emplacement, ''))) and em.actif and n.accepte_pieces and not em.essai;
  if not found then
    raise exception 'Emplacement inconnu, désactivé, d''essai ou qui ne reçoit pas de pièces : %',
      coalesce(nullif(trim(p_emplacement), ''), '(vide — scannez l''emplacement)');
  end if;
  select * into s from public.scan_pieces_etat where piece_id = p.id for update;
  select code into v_avant from public.scan_test_emplacements where id = s.emplacement_id;
  v_evt := case when s.emplacement_id is not null then 'changement_emplacement' else 'rangement' end;
  insert into public.scan_pieces_etat as x (piece_id, etat_physique, emplacement_id, confirme_le, confirme_par, confirme_prenom, maj_le, maj_par)
  values (p.id, 'presente_confirmee', e.id, now(), v_prof.user_id, v_prof.prenom, now(), v_prof.user_id)
  on conflict (piece_id) do update set etat_physique = 'presente_confirmee', emplacement_id = e.id, confirme_le = now(),
         confirme_par = v_prof.user_id, confirme_prenom = v_prof.prenom, maj_le = now(), maj_par = v_prof.user_id;
  insert into public.scan_pieces_evenements (piece_id, id_interne, action, physique_avant, physique_apres, commercial_avant, commercial_apres,
                                             emplacement_avant, emplacement_apres, user_id, prenom, role, appareil, commentaire)
  values (p.id, p.id_interne, v_evt, s.etat_physique, 'presente_confirmee', s.etat_commercial, s.etat_commercial, v_avant, e.code,
          v_prof.user_id, v_prof.prenom, v_prof.role, left(nullif(trim(coalesce(p_appareil, '')), ''), 120),
          nullif(trim(coalesce(p_commentaire, '')), ''))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'evenement_id', v_id, 'evenement', v_evt, 'id_interne', p.id_interne, 'emplacement', e.code);
end $$;

-- ---------------------------------------------------------------------
-- 5. Enregistrer une pièce présente sur place mais absente de la base (responsable seulement)
--    Rien d'inventé : véhicule, canal, prix, ID Ovoko, SKU restent vides. Lot = celui de l'ID, qui doit être connu.
-- ---------------------------------------------------------------------
create or replace function public.scan_reel_enregistrer(p_id_interne text, p_type_piece text, p_appareil text default null,
                                                        p_commentaire text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prof public.scan_profils := public.scan_reel_profil(true);
  v_n    text := public.robots_id_norme(p_id_interne);
  v_lot  text;
  v_id_f text;
  v_type text := nullif(btrim(coalesce(p_type_piece, '')), '');
  v_pid  bigint;
  v_id   bigint;
begin
  if v_prof.role <> 'responsable' then
    raise exception 'Droits insuffisants : enregistrement d''une pièce réservé au responsable';
  end if;
  if v_n is null or not public.robots_id_valide(v_n) then
    raise exception 'ID interne non valide : % (format attendu : lot + 3 chiffres ; TMP- et paires A+B refusés)',
      coalesce(nullif(trim(p_id_interne), ''), '(vide)');
  end if;
  v_lot := public.robots_lot_de(v_n);
  v_id_f := v_lot || '-' || right(v_n, 3);
  perform pg_advisory_xact_lock(5028, hashtext(v_n));
  if exists (select 1 from public.pieces where id_interne_norme = v_n) then
    raise exception 'Pièce % déjà dans la base : rien n''est créé', v_id_f;
  end if;
  if not coalesce(public.robots_lot_connu(v_lot), false) then
    raise exception 'Lot % inconnu (ni dans la base, ni dans le fichier de stock) : rien n''est créé', v_lot;
  end if;
  if exists (select 1 from public.ref_lots_stock r where public.robots_id_norme(r.lot) = v_lot and r.stock_arrivage ~* 'ECO') then
    raise exception 'Lot % : stock partenaire ECO, pas notre stock — rien n''est créé', v_lot;
  end if;
  if v_type is null or not exists (select 1 from public.pieces where btrim(type_piece) = v_type) then
    raise exception 'Type de pièce « % » inconnu : choisissez un type de la liste', coalesce(v_type, '(vide)');
  end if;

  insert into public.pieces (id_interne, lot, id_interne_norme, type_piece, stock_partenaire, source_import, origine, id_interne_en_double)
  values (v_id_f, v_lot, v_n, v_type, 'non',
          format('scan %s %s', to_char(now() at time zone 'Europe/Paris', 'YYYY-MM-DD HH24:MI'), v_prof.prenom), 'scan', false)
  returning id into v_pid;
  insert into public.scan_pieces_etat (piece_id, etat_physique, etat_commercial, confirme_le, confirme_par, confirme_prenom, maj_le, maj_par)
  values (v_pid, 'presente_confirmee', 'annonce_non_creee', now(), v_prof.user_id, v_prof.prenom, now(), v_prof.user_id);
  insert into public.scan_pieces_evenements (piece_id, id_interne, action, physique_apres, commercial_apres, user_id, prenom, role, appareil, commentaire)
  values (v_pid, v_id_f, 'enregistrement', 'presente_confirmee', 'annonce_non_creee', v_prof.user_id, v_prof.prenom, v_prof.role,
          left(nullif(trim(coalesce(p_appareil, '')), ''), 120), nullif(trim(coalesce(p_commentaire, '')), ''))
  returning id into v_id;
  -- état de fiabilité de CETTE pièce seulement (« en_attente_annonce ») ; aucune action, aucune alerte
  perform public.robots_calculer_fiabilite(array[v_pid]);
  return jsonb_build_object('ok', true, 'evenement_id', v_id, 'evenement', 'enregistrement', 'id_interne', v_id_f, 'piece_id', v_pid);
end $$;

-- ---------------------------------------------------------------------
-- 6. Droits des fonctions : appelables par la page (authenticated), jamais par anon
-- ---------------------------------------------------------------------
revoke execute on function public.scan_reel_lire(text), public.scan_reel_emplacement(bigint), public.scan_reel_types(),
                           public.scan_reel_confirmer_presence(text, text, text), public.scan_reel_ranger(text, text, text, text),
                           public.scan_reel_enregistrer(text, text, text, text) from public, anon;
grant execute on function public.scan_reel_lire(text), public.scan_reel_emplacement(bigint), public.scan_reel_types(),
                          public.scan_reel_confirmer_presence(text, text, text), public.scan_reel_ranger(text, text, text, text),
                          public.scan_reel_enregistrer(text, text, text, text) to authenticated;

commit;
