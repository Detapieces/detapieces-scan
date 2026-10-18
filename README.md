# SCAN Detapieces

Page unique (téléphone et PC) : connexion, scan, suivi du stock (onglet « Robots »), étiquettes Zebra, comptes, profil.
Elle ne parle **qu'à Supabase**, jamais à eBay ni à Ovoko : elle écrit des statuts et des événements de scan.
Les robots agiront plus tard sur les plateformes à partir de ces événements.

## Contenu

| Dossier | Rôle |
|---|---|
| `docs/` | La page publiée par GitHub Pages (HTML + JS, sans compilation). `config.js` = adresse Supabase + clé **publique** uniquement. |
| `supabase/migrations/` | Tables `scan_profils` / `scan_journal_comptes` (définitives) et `scan_test_*` (données pièces de TEST), règles, RLS, fonction de lecture de l'onglet Robots. |
| `supabase/donnees/` | Données d'essai : portes du STOCK 16 (« attendue ») + 11 emplacements fictifs. Générées par `outils/generer_donnees_essai.py`. |
| `supabase/functions/scan-comptes` | Gestion des comptes et changement de mot de passe (clé de service côté serveur uniquement). |
| `supabase/functions/scan-robot-veille` | Robot de scan en **veille**, **non planifié** : écrit seulement ce qu'il aurait fait. Annonces **simulées**. |
| `tests/` | Tests hors ligne (Postgres en mémoire PGlite + vraies migrations). |
| `outils/` | Données d'essai, planche de QR de test, comptes initiaux. |

## Commandes

```
npm install
npm test                                  # tests hors ligne
python -I outils/generer_donnees_essai.py  # régénère les données d'essai
node outils/generer_etiquettes_essai.mjs   # planche de QR + aperçus PDF + ZPL d'essai (dans sorties/, non versionné)
```

## Sécurité

- RLS sur toutes les tables `scan_*` ; aucune écriture directe : tout passe par `scan_action` et `scan_emplacement_*`.
- Aucune clé de service, aucun mot de passe dans ce dépôt.
- Comptes : identifiant = prénom ; compte technique `<prénom>@scan.detapieces.invalid` (aucun e-mail envoyé).
