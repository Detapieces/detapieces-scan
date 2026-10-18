-- =====================================================================
-- SCAN Detapieces — règles et actions (18/10/2026). À appliquer après 20261018190000_scan_base.sql.
-- Toute écriture passe par scan_action / scan_emplacement_* (security definer) : rôle, état de la pièce
-- et changement de mot de passe vérifiés ; chaque geste est signé (qui, quand, appareil) dans scan_test_evenements.
-- Le tri du canal eBay / Ovoko ne se fait JAMAIS ici. Aucun appel à eBay ni à Ovoko.
-- Une transaction.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Règle pure : l'action est-elle permise ? (null = oui, sinon le message d'erreur à afficher)
--    Doublée côté page par docs/regles.js — un test vérifie que les deux disent la même chose.
-- ---------------------------------------------------------------------
create or replace function public.scan_regle(p_role text, p_physique text, p_commercial text, p_decision text,
                                             p_sortie text, p_action text)
returns text language plpgsql immutable as $$
declare
  equipe   text[] := array['receptionner', 'ranger', 'preparer_commande', 'vente_comptoir', 'reserver', 'annuler_reservation',
                           'retour_recu', 'signaler_absente', 'annulation_avant_expedition'];
  annonces text[] := array['marquer_prete_a_publier', 'basculer_ovoko_uniquement', 'basculer_gardee_de_cote',
                           'decider_republier', 'decider_rebut'];
  presente boolean := p_physique in ('receptionnee', 'rangee');
begin
  if not (p_action = any(equipe || annonces || array['corriger_statut'])) then
    return 'Action inconnue';
  end if;
  if p_role is null then
    return 'Droits insuffisants : compte inconnu ou désactivé';
  end if;
  if p_role = 'equipe' and not (p_action = any(equipe)) then
    return 'Droits insuffisants : action réservée à l''équipe annonces ou au responsable';
  end if;
  if p_role = 'annonces' and not (p_action = any(annonces)) then
    return 'Droits insuffisants : action réservée à l''équipe sur site ou au responsable';
  end if;
  if p_action = 'corriger_statut' and p_role <> 'responsable' then
    return 'Droits insuffisants : correction de statut réservée au responsable';
  end if;

  case p_action
    when 'receptionner' then
      if p_physique not in ('attendue', 'supposee_presente', 'absente') then
        return 'Action impossible : la pièce est déjà réceptionnée ou n''est pas attendue';
      end if;
    when 'ranger' then
      if p_physique = 'en_retour' then
        if p_decision is distinct from 'republier' then
          return 'Action impossible : retour sans décision « Republier » — décision d''abord (équipe annonces ou responsable)';
        end if;
      elsif not presente then
        return 'Action impossible : réceptionnez d''abord la pièce';
      end if;
    when 'preparer_commande' then
      if not presente then return 'Action impossible : la pièce n''est pas au dépôt'; end if;
      if p_commercial not in ('en_vente', 'reservee', 'vendue') then
        return 'Action impossible : la pièce n''est ni en vente, ni réservée, ni vendue';
      end if;
    when 'vente_comptoir' then
      if not presente then return 'Action impossible : la pièce n''est pas au dépôt'; end if;
      if p_commercial not in ('annonce_non_creee', 'prete_a_publier', 'prete_a_republier', 'en_vente', 'reservee') then
        return 'Action impossible : la pièce est déjà vendue ou retirée de la vente';
      end if;
    when 'reserver' then
      if not presente then return 'Action impossible : la pièce n''est pas au dépôt'; end if;
      if p_commercial not in ('annonce_non_creee', 'prete_a_publier', 'prete_a_republier', 'en_vente') then
        return 'Action impossible : la pièce n''est pas disponible à la réservation';
      end if;
    when 'annuler_reservation' then
      if p_commercial <> 'reservee' then return 'Action impossible : la pièce n''est pas réservée'; end if;
    when 'retour_recu' then
      if not (p_physique = 'partie' and p_commercial = 'vendue') then
        return 'Action impossible : seule une pièce vendue et partie peut revenir en retour';
      end if;
    when 'signaler_absente' then
      if p_physique not in ('supposee_presente', 'receptionnee', 'rangee') then
        return 'Action impossible : la pièce n''est pas censée être au dépôt';
      end if;
    when 'decider_republier', 'decider_rebut' then
      if not (p_physique = 'en_retour' and p_commercial = 'retour_attente_decision') then
        return 'Action impossible : aucun retour en attente de décision pour cette pièce';
      end if;
      if p_decision is not null then
        return 'Action impossible : décision déjà prise (« Republier ») — rangement au scan attendu';
      end if;
    when 'annulation_avant_expedition' then
      if not (p_physique = 'partie' and p_commercial = 'vendue' and coalesce(p_sortie, '') = 'commande') then
        return 'Action impossible : seule une commande préparée et pas encore expédiée peut être annulée ici';
      end if;
    when 'marquer_prete_a_publier' then
      if p_commercial <> 'annonce_non_creee' then
        return 'Action impossible : l''annonce n''est pas « pas encore créée »';
      end if;
      if not presente then
        return 'Action impossible : la pièce doit d''abord être réceptionnée au scan';
      end if;
    else
      null;  -- basculer_*, corriger_statut : toujours permis au bon rôle
  end case;
  return null;
end $$;

-- ---------------------------------------------------------------------
-- 2. Action de scan (toujours un geste volontaire, confirmé côté page)
-- ---------------------------------------------------------------------
create or replace function public.scan_action(p_id_interne text, p_action text, p_emplacement text default null,
                                              p_commentaire text default null, p_appareil text default null,
                                              p_physique text default null, p_commercial text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prof        public.scan_profils;
  v_p           public.scan_test_pieces;
  v_err         text;
  v_empl        public.scan_test_emplacements;
  v_empl_avant  text;
  v_empl_apres  text;
  v_phys        text;
  v_comm        text;
  v_empl_id     bigint;
  v_decision    text;
  v_sortie      text;
  v_avant_res   text;
  v_ovoko       boolean;
  v_cote        boolean;
  v_evt         text;
  v_comment     text := nullif(trim(coalesce(p_commentaire, '')), '');
  v_id          bigint;
begin
  select * into v_prof from public.scan_profils where user_id = auth.uid();
  if not found or not v_prof.actif then
    raise exception 'Droits insuffisants : compte inconnu ou désactivé';
  end if;
  if v_prof.doit_changer_mdp then
    raise exception 'Changez d''abord votre mot de passe (obligatoire à la première connexion)';
  end if;

  select * into v_p from public.scan_test_pieces where id_interne = trim(coalesce(p_id_interne, '')) for update;
  if not found then
    raise exception 'Pièce inconnue : %', coalesce(nullif(trim(p_id_interne), ''), '(vide)');
  end if;

  v_err := public.scan_regle(v_prof.role, v_p.etat_physique, v_p.etat_commercial, v_p.retour_decision, v_p.derniere_sortie, p_action);
  if v_err is not null then
    raise exception '%', v_err;
  end if;

  select code into v_empl_avant from public.scan_test_emplacements where id = v_p.emplacement_id;
  v_phys := v_p.etat_physique;  v_comm := v_p.etat_commercial;  v_empl_id := v_p.emplacement_id;
  v_decision := v_p.retour_decision;  v_sortie := v_p.derniere_sortie;  v_avant_res := v_p.commercial_avant_reservation;
  v_ovoko := v_p.ovoko_uniquement;  v_cote := v_p.gardee_de_cote;

  if p_action in ('ranger', 'annulation_avant_expedition') then
    select e.* into v_empl from public.scan_test_emplacements e
      join public.scan_test_config_niveaux n on n.rang = e.niveau_rang
     where e.code = upper(trim(coalesce(p_emplacement, ''))) and e.actif and n.accepte_pieces;
    if not found then
      raise exception 'Emplacement inconnu, désactivé ou qui ne reçoit pas de pièces : %',
        coalesce(nullif(trim(p_emplacement), ''), '(vide — scannez l''emplacement)');
    end if;
  end if;

  case p_action
    when 'receptionner' then
      v_phys := 'receptionnee';  v_evt := 'reception';
    when 'ranger' then
      if v_p.etat_physique = 'en_retour' then
        v_phys := 'rangee';  v_comm := 'prete_a_republier';  v_decision := null;  v_evt := 'retour_republication';
      else
        v_evt := case when v_p.etat_physique = 'rangee' then 'changement_emplacement' else 'rangement' end;
        v_phys := 'rangee';
      end if;
      v_empl_id := v_empl.id;
    when 'preparer_commande' then
      v_phys := 'partie';  v_comm := 'vendue';  v_empl_id := null;  v_sortie := 'commande';  v_avant_res := null;
      v_evt := 'preparation_commande';
    when 'vente_comptoir' then
      v_phys := 'partie';  v_comm := 'vendue';  v_empl_id := null;  v_sortie := 'comptoir';  v_avant_res := null;
      v_evt := 'vente_comptoir';
    when 'reserver' then
      v_avant_res := v_p.etat_commercial;  v_comm := 'reservee';  v_evt := 'reservation';
    when 'annuler_reservation' then
      v_comm := coalesce(v_p.commercial_avant_reservation, 'en_vente');  v_avant_res := null;  v_evt := 'annulation_reservation';
    when 'retour_recu' then
      v_phys := 'en_retour';  v_comm := 'retour_attente_decision';  v_sortie := null;  v_decision := null;  v_evt := 'retour_recu';
    when 'signaler_absente' then
      v_phys := 'absente';  v_empl_id := null;  v_evt := 'signalement_absente';
    when 'decider_republier' then
      v_decision := 'republier';  v_evt := 'retour_decision_republier';
    when 'decider_rebut' then
      v_phys := 'rebut';  v_comm := 'retiree';  v_empl_id := null;  v_evt := 'retour_rebut';
    when 'annulation_avant_expedition' then
      v_phys := 'rangee';  v_comm := 'en_vente';  v_empl_id := v_empl.id;  v_sortie := null;  v_evt := 'annulation_avant_expedition';
    when 'marquer_prete_a_publier' then
      v_comm := 'prete_a_publier';  v_evt := 'marquage_prete_a_publier';
    when 'basculer_ovoko_uniquement' then
      v_ovoko := not v_p.ovoko_uniquement;
      v_evt := case when v_ovoko then 'marquage_ovoko_uniquement' else 'retrait_ovoko_uniquement' end;
    when 'basculer_gardee_de_cote' then
      v_cote := not v_p.gardee_de_cote;
      v_evt := case when v_cote then 'marquage_gardee_de_cote' else 'retrait_gardee_de_cote' end;
    when 'corriger_statut' then
      if v_comment is null then
        raise exception 'Correction de statut : un commentaire est obligatoire';
      end if;
      if p_physique is not null and p_physique not in ('attendue', 'supposee_presente', 'receptionnee', 'rangee', 'absente',
                                                       'partie', 'en_retour', 'rebut') then
        raise exception 'État physique inconnu : %', p_physique;
      end if;
      if p_commercial is not null and p_commercial not in ('annonce_non_creee', 'prete_a_publier', 'prete_a_republier',
                                                           'en_vente', 'reservee', 'vendue', 'retiree', 'retour_attente_decision') then
        raise exception 'État commercial inconnu : %', p_commercial;
      end if;
      v_phys := coalesce(p_physique, v_phys);  v_comm := coalesce(p_commercial, v_comm);
      if v_phys not in ('receptionnee', 'rangee', 'supposee_presente') then v_empl_id := null; end if;
      if v_comm <> 'retour_attente_decision' then v_decision := null; end if;
      if v_comm <> 'reservee' then v_avant_res := null; end if;
      if v_phys <> 'partie' then v_sortie := null; end if;
      v_evt := 'correction_statut';
  end case;

  update public.scan_test_pieces set
    etat_physique = v_phys, etat_commercial = v_comm, emplacement_id = v_empl_id, retour_decision = v_decision,
    derniere_sortie = v_sortie, commercial_avant_reservation = v_avant_res, ovoko_uniquement = v_ovoko, gardee_de_cote = v_cote,
    maj_le = now(), maj_par = v_prof.user_id
  where id_interne = v_p.id_interne;

  select code into v_empl_apres from public.scan_test_emplacements where id = v_empl_id;

  insert into public.scan_test_evenements (id_interne, action, physique_avant, physique_apres, commercial_avant, commercial_apres,
                                           emplacement_avant, emplacement_apres, user_id, prenom, role, appareil, commentaire)
  values (v_p.id_interne, v_evt, v_p.etat_physique, v_phys, v_p.etat_commercial, v_comm, v_empl_avant, v_empl_apres,
          v_prof.user_id, v_prof.prenom, v_prof.role, left(nullif(trim(coalesce(p_appareil, '')), ''), 120), v_comment)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'evenement_id', v_id, 'evenement', v_evt, 'id_interne', v_p.id_interne,
                            'physique', v_phys, 'commercial', v_comm, 'emplacement', v_empl_apres);
end $$;

-- ---------------------------------------------------------------------
-- 3. Emplacements : création, renommage / déplacement (historique gardé), activation — responsable
-- ---------------------------------------------------------------------
create or replace function public.scan_test_regex_code(p_rang integer, p_parent_code text)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  n    public.scan_test_config_niveaux;
  sep  text := coalesce((select valeur from public.scan_test_config where cle = 'separateur_emplacement'), '-');
  esc  text;
begin
  select * into n from public.scan_test_config_niveaux where rang = p_rang;
  if not found then return null; end if;
  if n.libre then return '^[A-Z0-9][A-Z0-9-]{0,39}$'; end if;
  esc := regexp_replace(coalesce(p_parent_code, ''), '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g')
         || regexp_replace(sep, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g');
  if n.parent_rang is null then esc := ''; end if;
  return '^' || esc || n.prefixe || '[0-9]{' || n.chiffres || '}$';
end $$;

create or replace function public.scan_emplacement_creer(p_code text, p_niveau text, p_parent_code text default null,
                                                         p_libelle text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prof    public.scan_profils;
  n         public.scan_test_config_niveaux;
  v_parent  public.scan_test_emplacements;
  v_code    text := upper(trim(coalesce(p_code, '')));
  v_id      bigint;
begin
  select * into v_prof from public.scan_profils where user_id = auth.uid() and actif and role = 'responsable' and not doit_changer_mdp;
  if not found then raise exception 'Droits insuffisants : gestion des emplacements réservée au responsable'; end if;
  select * into n from public.scan_test_config_niveaux where cle = p_niveau;
  if not found then raise exception 'Niveau d''emplacement inconnu : %', p_niveau; end if;
  if n.parent_rang is not null and not n.libre then
    select * into v_parent from public.scan_test_emplacements where code = upper(trim(coalesce(p_parent_code, '')));
    if not found or v_parent.niveau_rang <> n.parent_rang then
      raise exception 'Emplacement parent manquant ou de mauvais niveau pour un(e) %', lower(n.libelle);
    end if;
  end if;
  if v_code !~ public.scan_test_regex_code(n.rang, v_parent.code) then
    raise exception 'Code « % » non conforme à la configuration du niveau %', v_code, n.libelle;
  end if;
  insert into public.scan_test_emplacements (code, niveau_rang, parent_id, libelle)
  values (v_code, n.rang, v_parent.id, p_libelle) returning id into v_id;
  insert into public.scan_test_emplacements_historique (emplacement_id, action, nouveau_code, nouveau_parent_id, par_user, par_prenom)
  values (v_id, 'creation', v_code, v_parent.id, v_prof.user_id, v_prof.prenom);
  return jsonb_build_object('ok', true, 'id', v_id, 'code', v_code);
end $$;

-- Renomme et/ou déplace ; les sous-emplacements suivent (leur code est préfixé par celui du parent), chacun historisé.
create or replace function public.scan_emplacement_modifier(p_code text, p_nouveau_code text, p_nouveau_parent_code text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prof     public.scan_profils;
  v_e        public.scan_test_emplacements;
  v_parent   public.scan_test_emplacements;
  n          public.scan_test_config_niveaux;
  v_nouveau  text := upper(trim(coalesce(p_nouveau_code, '')));
  sep        text := coalesce((select valeur from public.scan_test_config where cle = 'separateur_emplacement'), '-');
  r          record;
begin
  select * into v_prof from public.scan_profils where user_id = auth.uid() and actif and role = 'responsable' and not doit_changer_mdp;
  if not found then raise exception 'Droits insuffisants : gestion des emplacements réservée au responsable'; end if;
  select * into v_e from public.scan_test_emplacements where code = upper(trim(coalesce(p_code, ''))) for update;
  if not found then raise exception 'Emplacement inconnu : %', p_code; end if;
  select * into n from public.scan_test_config_niveaux where rang = v_e.niveau_rang;
  if p_nouveau_parent_code is not null then
    select * into v_parent from public.scan_test_emplacements where code = upper(trim(p_nouveau_parent_code));
    if not found or v_parent.niveau_rang is distinct from n.parent_rang then
      raise exception 'Nouveau parent inconnu ou de mauvais niveau';
    end if;
  else
    select * into v_parent from public.scan_test_emplacements where id = v_e.parent_id;
  end if;
  if v_nouveau !~ public.scan_test_regex_code(n.rang, v_parent.code) then
    raise exception 'Code « % » non conforme à la configuration du niveau %', v_nouveau, n.libelle;
  end if;

  -- sous-emplacements d'abord (codes préfixés)
  for r in select id, code from public.scan_test_emplacements
            where code like v_e.code || sep || '%' and id <> v_e.id order by length(code) loop
    update public.scan_test_emplacements set code = v_nouveau || substr(r.code, length(v_e.code) + 1) where id = r.id;
    insert into public.scan_test_emplacements_historique (emplacement_id, action, ancien_code, nouveau_code, par_user, par_prenom)
    values (r.id, 'renommage', r.code, v_nouveau || substr(r.code, length(v_e.code) + 1), v_prof.user_id, v_prof.prenom);
  end loop;

  update public.scan_test_emplacements set code = v_nouveau, parent_id = v_parent.id where id = v_e.id;
  insert into public.scan_test_emplacements_historique (emplacement_id, action, ancien_code, nouveau_code, ancien_parent_id,
                                                        nouveau_parent_id, par_user, par_prenom)
  values (v_e.id, case when v_parent.id is distinct from v_e.parent_id then 'deplacement' else 'renommage' end,
          v_e.code, v_nouveau, v_e.parent_id, v_parent.id, v_prof.user_id, v_prof.prenom);
  return jsonb_build_object('ok', true, 'id', v_e.id, 'ancien_code', v_e.code, 'code', v_nouveau);
end $$;

create or replace function public.scan_emplacement_activer(p_code text, p_actif boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prof public.scan_profils;
  v_e    public.scan_test_emplacements;
begin
  select * into v_prof from public.scan_profils where user_id = auth.uid() and actif and role = 'responsable' and not doit_changer_mdp;
  if not found then raise exception 'Droits insuffisants : gestion des emplacements réservée au responsable'; end if;
  select * into v_e from public.scan_test_emplacements where code = upper(trim(coalesce(p_code, ''))) for update;
  if not found then raise exception 'Emplacement inconnu : %', p_code; end if;
  if not p_actif and exists (select 1 from public.scan_test_pieces where emplacement_id = v_e.id) then
    raise exception 'Emplacement % non vide : déplacez d''abord ses pièces', v_e.code;
  end if;
  update public.scan_test_emplacements set actif = p_actif where id = v_e.id;
  insert into public.scan_test_emplacements_historique (emplacement_id, action, ancien_code, nouveau_code, par_user, par_prenom)
  values (v_e.id, case when p_actif then 'reactivation' else 'desactivation' end, v_e.code, v_e.code, v_prof.user_id, v_prof.prenom);
  return jsonb_build_object('ok', true, 'code', v_e.code, 'actif', p_actif);
end $$;

revoke execute on function public.scan_regle(text, text, text, text, text, text) from public, anon;
revoke execute on function public.scan_action(text, text, text, text, text, text, text) from public, anon;
revoke execute on function public.scan_test_regex_code(integer, text) from public, anon;
revoke execute on function public.scan_emplacement_creer(text, text, text, text) from public, anon;
revoke execute on function public.scan_emplacement_modifier(text, text, text) from public, anon;
revoke execute on function public.scan_emplacement_activer(text, boolean) from public, anon;
grant execute on function public.scan_regle(text, text, text, text, text, text) to authenticated;
grant execute on function public.scan_action(text, text, text, text, text, text, text) to authenticated;
grant execute on function public.scan_emplacement_creer(text, text, text, text) to authenticated;
grant execute on function public.scan_emplacement_modifier(text, text, text) to authenticated;
grant execute on function public.scan_emplacement_activer(text, boolean) to authenticated;

commit;
