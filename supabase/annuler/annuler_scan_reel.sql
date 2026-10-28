-- Retour arrière de 20261028120000_scan_reel.sql : retire les fonctions et les tables du scan sur les vraies pièces.
-- NE TOUCHE PAS public.pieces : les pièces enregistrées au scan (origine = 'scan') restent. Leur suppression éventuelle est une
-- décision séparée de Ruben (voir le rapport), seulement si aucune annonce ni ID Ovoko ne leur a été rattaché.
-- scan_test_* et les 11 fonctions SECURITY DEFINER existantes ne sont pas touchées.
begin;
drop function if exists public.scan_reel_enregistrer(text, text, text, text);
drop function if exists public.scan_reel_ranger(text, text, text, text);
drop function if exists public.scan_reel_confirmer_presence(text, text, text);
drop function if exists public.scan_reel_types();
drop function if exists public.scan_reel_emplacement(bigint);
drop function if exists public.scan_reel_lire(text);
drop function if exists public.scan_reel_une_piece(text);
drop function if exists public.scan_reel_profil(boolean);
drop table if exists public.scan_pieces_evenements;
drop table if exists public.scan_pieces_etat;
drop function if exists public.scan_reel_journal_immuable();
commit;
