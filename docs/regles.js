// Règles d'affichage des actions — MIROIR de la fonction SQL public.scan_regle (la base reste seule juge).
// Un test (tests/regles_parite.test.mjs) vérifie que les deux donnent le même verdict pour toutes les combinaisons.

export const ETATS_PHYSIQUES = {
  attendue: "Attendue",
  supposee_presente: "Supposée présente",
  receptionnee: "Réceptionnée",
  rangee: "Rangée",
  absente: "Absente",
  partie: "Partie",
  en_retour: "En retour",
  rebut: "Rebut",
};

export const ETATS_COMMERCIAUX = {
  annonce_non_creee: "Annonce pas encore créée",
  prete_a_publier: "Prête à publier",
  prete_a_republier: "Prête à republier",
  en_vente: "En vente",
  reservee: "Réservée",
  vendue: "Vendue",
  retiree: "Retirée de la vente",
  retour_attente_decision: "Retour en attente de décision",
};

export const ROLES = { equipe: "Équipe (sur site)", annonces: "Annonces (à distance)", responsable: "Responsable" };

const EQUIPE = ["receptionner", "ranger", "preparer_commande", "vente_comptoir", "reserver", "annuler_reservation",
                "retour_recu", "signaler_absente", "annulation_avant_expedition"];
const ANNONCES = ["marquer_prete_a_publier", "basculer_ovoko_uniquement", "basculer_gardee_de_cote",
                  "decider_republier", "decider_rebut"];
export const TOUTES_ACTIONS = [...EQUIPE, ...ANNONCES, "corriger_statut"];

// Libellés des boutons (l'ordre = l'ordre d'affichage)
export const ACTIONS = {
  receptionner: { libelle: "Réceptionner", couleur: "vert" },
  ranger: { libelle: "Ranger / changer d'emplacement", couleur: "bleu", emplacement: true },
  preparer_commande: { libelle: "Préparer une commande", couleur: "bleu" },
  vente_comptoir: { libelle: "Vente comptoir", couleur: "orange" },
  reserver: { libelle: "Réserver", couleur: "bleu" },
  annuler_reservation: { libelle: "Annuler la réservation", couleur: "gris" },
  retour_recu: { libelle: "Déclarer un RETOUR reçu", couleur: "orange" },
  signaler_absente: { libelle: "Signaler absente", couleur: "rouge" },
  annulation_avant_expedition: { libelle: "Annulation avant expédition", couleur: "gris", emplacement: true },
  decider_republier: { libelle: "Retour : REPUBLIER (pièce bonne)", couleur: "vert" },
  decider_rebut: { libelle: "Retour : REBUT (pièce cassée)", couleur: "rouge" },
  marquer_prete_a_publier: { libelle: "Marquer « prête à publier »", couleur: "vert" },
  basculer_ovoko_uniquement: { libelle: "Ovoko uniquement : oui / non", couleur: "gris" },
  basculer_gardee_de_cote: { libelle: "Gardée de côté : oui / non", couleur: "gris" },
  corriger_statut: { libelle: "Corriger le statut (responsable)", couleur: "gris", correction: true },
};

/** null = action permise ; sinon le message d'erreur (mêmes textes que la base). */
export function regle(role, physique, commercial, decision, sortie, action) {
  const presente = physique === "receptionnee" || physique === "rangee";
  if (!TOUTES_ACTIONS.includes(action)) return "Action inconnue";
  if (!role) return "Droits insuffisants : compte inconnu ou désactivé";
  if (role === "equipe" && !EQUIPE.includes(action)) return "Droits insuffisants : action réservée à l'équipe annonces ou au responsable";
  if (role === "annonces" && !ANNONCES.includes(action)) return "Droits insuffisants : action réservée à l'équipe sur site ou au responsable";
  if (action === "corriger_statut" && role !== "responsable") return "Droits insuffisants : correction de statut réservée au responsable";

  switch (action) {
    case "receptionner":
      if (!["attendue", "supposee_presente", "absente"].includes(physique)) return "Action impossible : la pièce est déjà réceptionnée ou n'est pas attendue";
      break;
    case "ranger":
      if (physique === "en_retour") {
        if (decision !== "republier") return "Action impossible : retour sans décision « Republier » — décision d'abord (équipe annonces ou responsable)";
      } else if (!presente) return "Action impossible : réceptionnez d'abord la pièce";
      break;
    case "preparer_commande":
      if (!presente) return "Action impossible : la pièce n'est pas au dépôt";
      if (!["en_vente", "reservee", "vendue"].includes(commercial)) return "Action impossible : la pièce n'est ni en vente, ni réservée, ni vendue";
      break;
    case "vente_comptoir":
      if (!presente) return "Action impossible : la pièce n'est pas au dépôt";
      if (!["annonce_non_creee", "prete_a_publier", "prete_a_republier", "en_vente", "reservee"].includes(commercial)) return "Action impossible : la pièce est déjà vendue ou retirée de la vente";
      break;
    case "reserver":
      if (!presente) return "Action impossible : la pièce n'est pas au dépôt";
      if (!["annonce_non_creee", "prete_a_publier", "prete_a_republier", "en_vente"].includes(commercial)) return "Action impossible : la pièce n'est pas disponible à la réservation";
      break;
    case "annuler_reservation":
      if (commercial !== "reservee") return "Action impossible : la pièce n'est pas réservée";
      break;
    case "retour_recu":
      if (!(physique === "partie" && commercial === "vendue")) return "Action impossible : seule une pièce vendue et partie peut revenir en retour";
      break;
    case "signaler_absente":
      if (!["supposee_presente", "receptionnee", "rangee"].includes(physique)) return "Action impossible : la pièce n'est pas censée être au dépôt";
      break;
    case "decider_republier":
    case "decider_rebut":
      if (!(physique === "en_retour" && commercial === "retour_attente_decision")) return "Action impossible : aucun retour en attente de décision pour cette pièce";
      if (decision) return "Action impossible : décision déjà prise (« Republier ») — rangement au scan attendu";
      break;
    case "annulation_avant_expedition":
      if (!(physique === "partie" && commercial === "vendue" && sortie === "commande")) return "Action impossible : seule une commande préparée et pas encore expédiée peut être annulée ici";
      break;
    case "marquer_prete_a_publier":
      if (commercial !== "annonce_non_creee") return "Action impossible : l'annonce n'est pas « pas encore créée »";
      if (!presente) return "Action impossible : la pièce doit d'abord être réceptionnée au scan";
      break;
  }
  return null;
}

/** Actions à proposer pour un rôle et une pièce (telle que lue dans scan_test_pieces_vue). */
export function actionsPossibles(role, piece) {
  return Object.keys(ACTIONS).filter((a) =>
    regle(role, piece.etat_physique, piece.etat_commercial, piece.retour_decision ?? null, piece.derniere_sortie ?? null, a) === null);
}

export const RE_ID_INTERNE = /^[A-Za-z0-9]+-[0-9]{1,4}$/;
