-- Types « Ovoko uniquement » — généré par outils/generer_types_ovoko.py (ne pas modifier à la main).
-- Source (lecture seule) : Suivi/01_ID_Interne/Types_Pieces/Nomenclature_ID_Interne_GRAVEE_2026-10-10.xlsx,
-- onglet « Nomenclature », colonne « Ovoko uniquement » = Oui. Validé par Ruben le 19/10/2026.
-- Table scan_test_types_ovoko_uniquement UNIQUEMENT. Idempotent. Une transaction.
begin;
insert into public.scan_test_types_ovoko_uniquement (code_piece, libelle) values
  ('202', 'Airbag piéton'),
  ('312', 'Module / calculateur airbag'),
  ('419', 'Capteur airbag'),
  ('501', 'Airbag rideau gauche (toit latéral)'),
  ('502', 'Airbag rideau droit (toit latéral)'),
  ('503', 'Airbag volant (conducteur)'),
  ('505', 'Ceinture de sécurité avant gauche'),
  ('506', 'Ceinture de sécurité avant droite'),
  ('508', 'Airbag passager (tableau de bord)'),
  ('515', 'Ceinture de sécurité arrière gauche'),
  ('516', 'Ceinture de sécurité arrière droite'),
  ('517', 'Ceinture de sécurité arrière centrale'),
  ('523', 'Airbag genoux gauche'),
  ('524', 'Airbag genoux droit'),
  ('525', 'Airbag genoux – centre / sans côté'),
  ('539', 'Airbag latéral gauche (siège / porte) n° 1'),
  ('540', 'Airbag latéral droit (siège / porte) n° 1'),
  ('541', 'Airbag latéral gauche (siège / porte) n° 2'),
  ('542', 'Airbag latéral droit (siège / porte) n° 2'),
  ('543', 'Réglage / module de ceinture de sécurité côté gauche'),
  ('544', 'Réglage / module de ceinture de sécurité côté droit'),
  ('547', 'Boucle de ceinture de sécurité gauche'),
  ('548', 'Boucle de ceinture de sécurité droite')
on conflict (code_piece) do nothing;
commit;
