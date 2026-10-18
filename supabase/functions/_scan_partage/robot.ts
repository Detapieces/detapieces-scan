// Robot de scan — logique pure (aucun accès réseau, aucune base) : utilisée par la fonction scan-robot-veille et par les tests.
// MODE VEILLE : il ne fait RIEN sur les plateformes ; il dit seulement ce qu'il AURAIT fait.
// Reconnaissance d'une annonce : par l'ID interne (SKU eBay, Code additionnel Ovoko au format lot-NNN), jamais par le n° seul.
// Règle multi-vérification de la marche à blanc : deux preuves fortes pour « aurait fermé / aurait relié »,
// sinon « aurait demandé confirmation ».

export type Evenement = {
  id: number;
  id_interne: string;
  action: string;
  cree_le: string;
};

export type Piece = {
  id_interne: string;
  lot: string;
  etat_physique: string;
  etat_commercial: string;
  ebay_fr: string | null;
  ebay_de: string | null;
  ebay_it: string | null;
  ebay_es: string | null;
  ovoko_id: string | null;
};

export type Annonce = {
  plateforme: "ebay" | "ovoko";
  site: "FR" | "DE" | "IT" | "ES" | "OVOKO";
  annonce_ref: string;
  sku: string | null;
  code_additionnel: string | null;
  lot: string | null;
  statut: "active" | "terminee" | "vendue";
  ancienne_ref: string | null;
  cree_le: string;
};

export type Preuve = { identifiant: string; attendu: string; lu: string | null; resultat: "concorde" | "absent" | "contredit" };

export type Decision = "aurait_ferme" | "aurait_relie" | "aurait_demande_confirmation" | "aurait_alerte" | "rien";

export type Trace = {
  cle: string;
  evenement_id: number;
  id_interne: string;
  declencheur: string;
  plateforme: string | null;
  site: string | null;
  annonce_ref: string | null;
  decision: Decision;
  motif: string;
  preuves: Preuve[];
  alerte: string | null;
};

export type Resultat = { traces: Trace[]; traite: boolean; resultat: string };

// Événements que le robot de scan regarde ; les autres sont marqués traités « aucune action robot ».
export const EVENEMENTS_ROBOT = ["retour_recu", "retour_republication", "retour_rebut", "vente_comptoir", "annulation_avant_expedition"];

function refsConnues(p: Piece): string[] {
  return [p.ebay_fr, p.ebay_de, p.ebay_it, p.ebay_es, p.ovoko_id]
    .flatMap((v) => (v ?? "").split("|"))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function idLu(a: Annonce): string | null {
  const v = a.plateforme === "ebay" ? a.sku : a.code_additionnel;
  const t = (v ?? "").trim();
  return t.length ? t : null;
}

// Vrai si l'annonce semble concerner la pièce (candidate à examiner) : même ID interne, n° connu, ou régénérée depuis un n° connu.
export function concerne(a: Annonce, p: Piece): boolean {
  const refs = refsConnues(p);
  return idLu(a) === p.id_interne || refs.includes(a.annonce_ref) || (a.ancienne_ref !== null && refs.includes(a.ancienne_ref));
}

export type Evaluation = { preuves: Preuve[]; fortes: number; idConcorde: boolean; contradiction: boolean };

export function evaluer(a: Annonce, p: Piece): Evaluation {
  const refs = refsConnues(p);
  const lu = idLu(a);
  const preuves: Preuve[] = [];
  preuves.push({
    identifiant: a.plateforme === "ebay" ? "SKU = ID interne" : "Code additionnel Ovoko = ID interne",
    attendu: p.id_interne, lu,
    resultat: lu === null ? "absent" : lu === p.id_interne ? "concorde" : "contredit",
  });
  const lotLu = (a.lot ?? "").trim() || null;
  preuves.push({ identifiant: "lot", attendu: p.lot, lu: lotLu,
                 resultat: lotLu === null ? "absent" : lotLu === p.lot ? "concorde" : "contredit" });
  const numero = refs.includes(a.annonce_ref) ? a.annonce_ref : (a.ancienne_ref && refs.includes(a.ancienne_ref) ? a.ancienne_ref : null);
  preuves.push({ identifiant: a.ancienne_ref && !refs.includes(a.annonce_ref) ? "n° d'origine (régénérée)" : "n° d'annonce connu",
                 attendu: refs.join("|") || "—", lu: numero ?? a.annonce_ref, resultat: numero ? "concorde" : "absent" });
  const fortes = preuves.filter((x) => x.resultat === "concorde").length;
  return { preuves, fortes, idConcorde: preuves[0].resultat === "concorde", contradiction: preuves.some((x) => x.resultat === "contredit") };
}

// Fermeture : deux preuves fortes (dont au moins une autre que le n°, garanti puisque le n° ne compte qu'une fois)
function decisionFermeture(e: Evaluation): Decision {
  return e.fortes >= 2 ? "aurait_ferme" : "aurait_demande_confirmation";
}

function nomAnnonce(a: Annonce): string {
  return a.plateforme === "ovoko" ? `Ovoko ${a.annonce_ref}` : `eBay ${a.site} ${a.annonce_ref}`;
}

function trace(evt: Evenement, a: Annonce | null, decision: Decision, motif: string, preuves: Preuve[], alerte: string | null,
               suffixe = ""): Trace {
  return {
    cle: `scan:${evt.id}:${a ? `${a.plateforme}:${a.site}:${a.annonce_ref}` : "-"}:${decision}${suffixe}`,
    evenement_id: evt.id, id_interne: evt.id_interne, declencheur: evt.action,
    plateforme: a?.plateforme ?? null, site: a?.site ?? null, annonce_ref: a?.annonce_ref ?? null,
    decision, motif, preuves, alerte,
  };
}

// Fermer toutes les annonces actives qui concernent la pièce (FR, copies MAG, Ovoko).
function fermerTout(evt: Evenement, p: Piece, annonces: Annonce[], raison: string): Trace[] {
  const actives = annonces.filter((a) => a.statut === "active" && concerne(a, p));
  return actives.map((a) => {
    const ev = evaluer(a, p);
    const d = decisionFermeture(ev);
    return trace(evt, a, d,
      d === "aurait_ferme" ? `${raison} : ${nomAnnonce(a)} aurait été fermée (${ev.fortes} preuves fortes)`
                           : `${raison} : ${nomAnnonce(a)} — preuves insuffisantes (${ev.fortes}), confirmation demandée`,
      ev.preuves, d === "aurait_ferme" ? null : `Confirmer la fermeture de ${nomAnnonce(a)} (${p.id_interne})`);
  });
}

/**
 * Décide pour UN événement.
 * @param suivants événements de la même pièce postérieurs à evt (pour savoir si une décision de retour a été prise)
 */
export function deciderEvenement(evt: Evenement, p: Piece | null, annonces: Annonce[], suivants: Evenement[],
                                 maintenant: Date, delaiHeures: number): Resultat {
  if (!EVENEMENTS_ROBOT.includes(evt.action)) {
    return { traces: [], traite: true, resultat: "aucune action robot" };
  }
  if (!p) {
    return { traces: [trace(evt, null, "aurait_alerte", "Pièce introuvable dans la base", [], `Pièce ${evt.id_interne} introuvable`)],
             traite: true, resultat: "pièce introuvable : alerte" };
  }
  const apres = annonces.filter((a) => new Date(a.cree_le).getTime() >= new Date(evt.cree_le).getTime());

  switch (evt.action) {
    case "retour_recu": {
      // a) surveillance pendant le retour ; b) remise en vente par la plateforme AVANT décision au scan
      const decide = suivants.some((s) => ["retour_decision_republier", "retour_republication", "retour_rebut", "correction_statut"]
        .includes(s.action));
      const actives = annonces.filter((a) => a.statut === "active" && concerne(a, p));
      if (actives.length > 0 && !decide) {
        const traces = actives.map((a) => {
          const ev = evaluer(a, p);
          const d = decisionFermeture(ev);
          return trace(evt, a, d,
            `Remise en vente par la plateforme pendant le retour, avant toute décision au scan : ${nomAnnonce(a)}` +
              (d === "aurait_ferme" ? ` aurait été fermée (${ev.fortes} preuves fortes)` : ` — preuves insuffisantes, confirmation demandée`),
            ev.preuves, `Retour ${p.id_interne} : ${nomAnnonce(a)} remise en vente par la plateforme sans décision au scan`);
        });
        return { traces, traite: false, resultat: `surveillance : ${traces.length} remise(s) en vente constatée(s), fermeture(s) simulée(s)` };
      }
      if (decide) return { traces: [], traite: true, resultat: "surveillance terminée : décision prise au scan" };
      return { traces: [], traite: false, resultat: "surveillance : aucune remise en vente constatée" };
    }

    case "retour_republication": {
      const refs = refsConnues(p);
      const nouvellesFR = apres.filter((a) => a.plateforme === "ebay" && a.site === "FR" && a.statut === "active" &&
                                             !refs.includes(a.annonce_ref) && concerne(a, p));
      if (nouvellesFR.length === 0) {
        const ecoule = (maintenant.getTime() - new Date(evt.cree_le).getTime()) / 3_600_000;
        if (ecoule >= delaiHeures) {
          return {
            traces: [trace(evt, null, "aurait_alerte",
              `Aucune annonce régénérée après ${delaiHeures} h : « prête à republier » maintenu`, [],
              `Équipe annonces : ${p.id_interne} prête à republier, aucune annonce régénérée trouvée après ${delaiHeures} h`)],
            traite: true, resultat: `aucune annonce après ${delaiHeures} h : alerte équipe annonces`,
          };
        }
        return { traces: [], traite: false, resultat: "en attente d'une annonce régénérée" };
      }
      const traces: Trace[] = [];
      let relie = false;
      for (const fr of nouvellesFR) {
        const ev = evaluer(fr, p);
        const lotOk = ev.preuves[1].resultat !== "contredit";
        if (ev.idConcorde && lotOk && !ev.contradiction && ev.fortes >= 2) {
          relie = true;
          traces.push(trace(evt, fr, "aurait_relie",
            `Annonce régénérée ${nomAnnonce(fr)} (même SKU) : nouveau n° FR relié dans la base, infos de la pièce mises à jour`, ev.preuves, null));
          // copies MAG DE/IT/ES retrouvées par le même SKU, et Ovoko par le Code additionnel
          const autres = apres.filter((a) => a.statut === "active" && a !== fr && (a.site !== "FR") && idLu(a) === p.id_interne);
          for (const c of autres) {
            const evc = evaluer(c, p);
            const ok = evc.idConcorde && !evc.contradiction && evc.fortes >= 2;
            traces.push(trace(evt, c, ok ? "aurait_relie" : "aurait_demande_confirmation",
              ok ? `${c.plateforme === "ovoko" ? "Pièce Ovoko" : "Copie MAG"} ${nomAnnonce(c)} reliée (même ID interne)`
                 : `${nomAnnonce(c)} : même ID interne mais preuves insuffisantes (${evc.fortes}), confirmation demandée`,
              evc.preuves, ok ? null : `Confirmer la liaison de ${nomAnnonce(c)} à ${p.id_interne}`));
          }
        } else {
          // régénérée mais impossible à relier avec certitude (SKU absent ou différent, lot qui ne concorde pas)
          const d = decisionFermeture(ev);
          const pourquoi = !ev.idConcorde ? (ev.preuves[0].resultat === "absent" ? "SKU absent" : "SKU différent") : "lot qui ne concorde pas";
          traces.push(trace(evt, fr, d,
            `Annonce régénérée ${nomAnnonce(fr)} impossible à relier avec certitude (${pourquoi}) : ` +
              (d === "aurait_ferme" ? "aurait été fermée" : "preuves insuffisantes, confirmation demandée"),
            ev.preuves, `Retour ${p.id_interne} : annonce régénérée ${nomAnnonce(fr)} non reliable (${pourquoi})`));
          // ses copies MAG (régénérées depuis une copie connue ou portant le même SKU lu que la FR)
          const copies = apres.filter((a) => a.plateforme === "ebay" && a.site !== "FR" && a.statut === "active" &&
            ((a.ancienne_ref !== null && refs.includes(a.ancienne_ref)) || (fr.sku !== null && a.sku === fr.sku)));
          for (const c of copies) {
            const evc = evaluer(c, p);
            const dc = decisionFermeture(evc);
            traces.push(trace(evt, c, dc,
              `Copie MAG ${nomAnnonce(c)} de l'annonce non reliable : ` +
                (dc === "aurait_ferme" ? "aurait été fermée" : "preuves insuffisantes, confirmation demandée"),
              evc.preuves, null));
          }
        }
      }
      return { traces, traite: true,
               resultat: relie ? "annonce régénérée reliée (simulation)" : "annonce régénérée non reliable : fermeture simulée + alerte" };
    }

    case "retour_rebut": {
      const traces = fermerTout(evt, p, annonces, "Retour jugé cassé (rebut)");
      if (traces.length === 0) {
        return { traces: [trace(evt, null, "rien", "Rebut : aucune annonce active trouvée", [], null)], traite: true,
                 resultat: "rebut : rien à fermer" };
      }
      return { traces, traite: true, resultat: `rebut : ${traces.length} annonce(s) à fermer (simulation)` };
    }

    case "vente_comptoir": {
      const traces = fermerTout(evt, p, annonces, "Vente comptoir");
      if (traces.length === 0) {
        return { traces: [trace(evt, null, "rien", "Vente comptoir : aucune annonce active trouvée", [], null)], traite: true,
                 resultat: "vente comptoir : rien à fermer" };
      }
      return { traces, traite: true, resultat: `vente comptoir : ${traces.length} annonce(s) à fermer (simulation)` };
    }

    case "annulation_avant_expedition":
      return { traces: [trace(evt, null, "rien", "Annulation avant expédition : pièce rangée et remise en vente au dépôt, aucune action plateforme", [], null)],
               traite: true, resultat: "annulation avant expédition : rien" };
  }
  return { traces: [], traite: true, resultat: "aucune action robot" };
}

/** Un tour complet : tous les événements non traités, dans l'ordre. */
export function tourRobot(evenementsNonTraites: Evenement[], tousEvenements: Evenement[], pieces: Map<string, Piece>,
                          annonces: Annonce[], maintenant: Date, delaiHeures: number): { id: number; r: Resultat }[] {
  return [...evenementsNonTraites].sort((a, b) => a.id - b.id).map((evt) => {
    const p = pieces.get(evt.id_interne) ?? null;
    const suivants = tousEvenements.filter((s) => s.id_interne === evt.id_interne && s.id > evt.id);
    return { id: evt.id, r: deciderEvenement(evt, p, annonces, suivants, maintenant, delaiHeures) };
  });
}
