-- =====================================================================
-- SCAN Detapieces — onglet « Robots » (18/10/2026). À appliquer après 20261018190100_scan_actions.sql.
-- LECTURE SEULE des décisions de la marche à blanc en production (veille_decisions, veille_resumes) :
-- une fonction sécurisée, réservée au rôle « responsable ». Aucune écriture, aucune modification des tables de veille,
-- aucune politique ajoutée sur elles. Une transaction.
-- =====================================================================
begin;

create or replace function public.scan_robots_veille(p_jour date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_jour       date := coalesce(p_jour, (now() at time zone 'Europe/Paris')::date);
  v_decisions  jsonb;
  v_compte     jsonb;
  v_total      integer;
  v_certaines  integer;
  v_jours      jsonb;
  v_resume     text;
begin
  if not exists (select 1 from public.scan_profils
                  where user_id = auth.uid() and actif and role = 'responsable' and not doit_changer_mdp) then
    raise exception 'Droits insuffisants : onglet Robots réservé au responsable';
  end if;

  select coalesce(jsonb_agg(x order by x->>'heure' desc), '[]'::jsonb) into v_decisions from (
    select jsonb_build_object(
             'id', d.id, 'jour', d.jour, 'heure', to_char(d.heure, 'HH24:MI:SS'), 'simulation', d.simulation,
             'evenement', d.evenement, 'id_interne', d.id_interne,
             'plateforme', coalesce(d.jumelle_plateforme, d.plateforme_vente), 'site', d.jumelle_site,
             'canal_vente', d.canal_vente, 'annonce', d.jumelle_ref, 'categorie', d.categorie,
             'categorie_si_active', d.categorie_si_active, 'motif', d.motif, 'constat', d.constat,
             'deja_fait_hors_robot', d.deja_fait_hors_robot) as x
      from public.veille_decisions d
     where d.jour = v_jour
     order by d.heure desc
     limit 500) s;

  select coalesce(jsonb_object_agg(categorie, n), '{}'::jsonb), coalesce(sum(n), 0),
         coalesce(sum(n) filter (where categorie in ('aurait_ferme', 'rien')), 0)
    into v_compte, v_total, v_certaines
    from (select categorie, count(*)::integer as n from public.veille_decisions
           where jour = v_jour and not simulation group by categorie) c;

  select coalesce(jsonb_agg(jsonb_build_object('jour', jour, 'n', n) order by jour desc), '[]'::jsonb) into v_jours
    from (select jour, count(*)::integer as n from public.veille_decisions
           where jour >= v_jour - 14 group by jour order by jour desc) j;

  select texte into v_resume from public.veille_resumes where jour = v_jour;

  return jsonb_build_object(
    'jour', v_jour,
    'decisions', v_decisions,
    'resume', jsonb_build_object('total', v_total, 'par_categorie', v_compte, 'certaines', v_certaines,
                                 'pourcentage_certaines', case when v_total > 0 then round(100.0 * v_certaines / v_total, 1) end,
                                 'texte_resume_veille', v_resume),
    'jours', v_jours);
end $$;

revoke execute on function public.scan_robots_veille(date) from public, anon;
grant execute on function public.scan_robots_veille(date) to authenticated;

commit;
