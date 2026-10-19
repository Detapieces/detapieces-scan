// SCAN Detapieces — page unique : connexion, scan, suivi (onglet Robots), étiquettes, comptes, profil.
// Parle UNIQUEMENT à Supabase (clé publique + session de l'utilisateur). JAMAIS à eBay ni à Ovoko.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { DOMAINE, SUPABASE_CLE_PUBLIQUE, SUPABASE_URL } from "./config.js";
import { ACTIONS, actionsPossibles, ETATS_COMMERCIAUX as EC, ETATS_PHYSIQUES as EP, RE_ID_INTERNE, ROLES } from "./regles.js";
import { pdfEmplacements, pdfPieces, pdfPlancheTest, zplEmplacement, zplPiece } from "./etiquettes.js";
import { ouvrirPhotos } from "./photos.js";

const sb = createClient(SUPABASE_URL, SUPABASE_CLE_PUBLIQUE, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "scan-detapieces-session" },
});

const etat = { session: null, profil: null, piece: null, attente: null, scanner: null, ongletSuivi: "recherche" };

const EVENEMENTS = {
  reception: "Réception", rangement: "Rangement", changement_emplacement: "Changement d'emplacement",
  preparation_commande: "Préparation de commande", vente_comptoir: "Vente comptoir", reservation: "Réservation",
  annulation_reservation: "Annulation de réservation", retour_recu: "Retour reçu",
  retour_decision_republier: "Retour : décision « Republier »", retour_republication: "Retour, republication",
  retour_rebut: "Retour, rebut", signalement_absente: "Signalée absente", annulation_avant_expedition: "Annulation avant expédition",
  marquage_prete_a_publier: "Marquée prête à publier", marquage_ovoko_uniquement: "Marquée Ovoko uniquement",
  retrait_ovoko_uniquement: "Retrait Ovoko uniquement", marquage_gardee_de_cote: "Marquée gardée de côté",
  retrait_gardee_de_cote: "Retrait gardée de côté", correction_statut: "Correction de statut",
};
const DECISIONS_ROBOT = {
  aurait_ferme: "Aurait fermé", aurait_relie: "Aurait relié", aurait_demande_confirmation: "Aurait demandé confirmation",
  aurait_alerte: "Aurait alerté", rien: "Rien", aurait_remis_en_vente: "Aurait remis en vente",
  retour_attente_scan: "Retour : attente scan", aurait_ferme_et_demande_confirmation: "Aurait fermé + demandé confirmation",
};

// ---------- outils ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dateFr = (d) => d ? new Date(d).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" }) : "";
const nettoyer = (t) => String(t ?? "").trim().replace(/[^A-Za-z0-9-]/g, "");

function appareil() {
  let nom = null;
  try { nom = localStorage.getItem("scan-appareil"); } catch { /* stockage indisponible */ }
  if (!nom) {
    const ua = navigator.userAgent;
    const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad/i.test(ua) ? "iPhone" : /Windows/i.test(ua) ? "PC Windows" : "Appareil";
    nom = `${os} ${Math.random().toString(36).slice(2, 6)}`;
    try { localStorage.setItem("scan-appareil", nom); } catch { /* ignoré */ }
  }
  return nom;
}

function message(type, texte, duree = 4000) {
  const d = document.createElement("div");
  d.className = `msg ${type}`;
  d.textContent = texte;
  $("#messages").replaceChildren(d);
  if (type === "erreur") navigator.vibrate?.([80, 60, 80]); else if (type === "ok") navigator.vibrate?.(60);
  if (duree) setTimeout(() => d.remove(), duree);
}

function erreurLisible(e) {
  const m = String(e?.message ?? e ?? "Erreur inconnue");
  if (/Invalid login credentials/i.test(m)) return "Identifiant ou mot de passe incorrect";
  if (/banned/i.test(m)) return "Compte désactivé : voyez avec Ruben";
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Pas de connexion internet : réessayez";
  if (/JWT|token/i.test(m)) return "Session expirée : reconnectez-vous";
  return m;
}

async function appelerComptes(corps) {
  const { data } = await sb.auth.getSession();
  const jeton = data.session?.access_token;
  const r = await fetch(`${SUPABASE_URL}/functions/v1/scan-comptes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_CLE_PUBLIQUE, Authorization: `Bearer ${jeton}` },
    body: JSON.stringify({ ...corps, appareil: appareil() }),
  });
  const j = await r.json().catch(() => ({ ok: false, erreur: `Erreur serveur (${r.status})` }));
  if (!j.ok) throw new Error(j.erreur ?? "Erreur");
  return j;
}

async function chargerProfil() {
  etat.profil = null;
  const uid = etat.session?.user?.id;
  if (!uid) return;
  const { data, error } = await sb.from("scan_profils").select("user_id,prenom,role,actif,doit_changer_mdp").eq("user_id", uid).maybeSingle();
  if (error) throw error;
  etat.profil = data;
}

// ---------- caméra ----------
async function ouvrirCamera(surCode) {
  await fermerCamera();
  if (!window.Html5Qrcode) { message("erreur", "Lecteur de QR indisponible : utilisez la saisie manuelle"); return; }
  const zone = $("#lecteur");
  if (!zone) return;
  const s = new window.Html5Qrcode("lecteur", { formatsToSupport: [window.Html5QrcodeSupportedFormats.QR_CODE], verbose: false });
  etat.scanner = s;
  try {
    await s.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 240, height: 240 } }, async (texte) => {
      await fermerCamera();
      surCode(texte);
    });
    $("#btn-camera") && ($("#btn-camera").textContent = "✖ Fermer la caméra");
  } catch (e) {
    etat.scanner = null;
    message("erreur", `Caméra indisponible (${erreurLisible(e)}) : autorisez la caméra ou tapez le code`, 7000);
  }
}

async function fermerCamera() {
  const s = etat.scanner;
  etat.scanner = null;
  if (s) { try { await s.stop(); s.clear(); } catch { /* déjà arrêtée */ } }
  $("#btn-camera") && ($("#btn-camera").textContent = "📷 Scanner");
}

// ---------- rendu général ----------
function menu() {
  const r = etat.profil?.role;
  const liens = [["scan", "📷", "Scan"], ["suivi", "📋", "Suivi"]];
  if (r === "equipe" || r === "responsable") liens.push(["etiquettes", "🏷️", "Étiquettes"]);
  if (r === "responsable") liens.push(["comptes", "👥", "Comptes"]);
  liens.push(["profil", "👤", "Profil"]);
  const route = routeCourante();
  const nav = $("#menu");
  nav.innerHTML = liens.map(([c, i, l]) => `<a href="#/${c}" class="${route === c ? "actif" : ""}"><span>${i}</span>${l}</a>`).join("");
  nav.hidden = false;
}

const routeCourante = () => (location.hash.replace(/^#\/?/, "").split("?")[0] || "scan");

async function rendre() {
  await fermerCamera();
  const app = $("#app");
  if (!etat.session) { $("#menu").hidden = true; $("#qui").textContent = ""; return vueConnexion(app); }
  if (!etat.profil) {
    $("#menu").hidden = true;
    app.innerHTML = `<div class="carte"><h1>Compte non autorisé</h1><p>Ce compte n'a pas de profil SCAN actif. Voyez avec Ruben.</p>
      <button class="gros secondaire" id="deco">Se déconnecter</button></div>`;
    $("#deco").onclick = () => sb.auth.signOut();
    return;
  }
  $("#qui").innerHTML = `${esc(etat.profil.prenom)}<br><small>${esc(ROLES[etat.profil.role] ?? etat.profil.role)}</small>`;
  if (etat.profil.doit_changer_mdp) { $("#menu").hidden = true; return vueMotDePasse(app, true); }
  menu();
  const route = routeCourante();
  if (route === "suivi") return vueSuivi(app);
  if (route === "etiquettes" && etat.profil.role !== "annonces") return vueEtiquettes(app);
  if (route === "comptes" && etat.profil.role === "responsable") return vueComptes(app);
  if (route === "profil") return vueProfil(app);
  return vueScan(app);
}

// ---------- connexion ----------
function vueConnexion(app) {
  app.innerHTML = `
    <div class="carte">
      <h1>Connexion</h1>
      <form id="f-connexion" autocomplete="on">
        <label for="prenom">Identifiant (votre prénom)</label>
        <input id="prenom" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required placeholder="ex. edward">
        <label for="mdp">Mot de passe</label>
        <input id="mdp" name="password" type="password" autocomplete="current-password" required>
        <button class="gros" type="submit">Se connecter</button>
      </form>
    </div>`;
  $("#f-connexion").onsubmit = async (ev) => {
    ev.preventDefault();
    const prenom = $("#prenom").value.trim().toLowerCase();
    const bouton = ev.submitter; bouton.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: `${prenom}@${DOMAINE}`, password: $("#mdp").value });
    bouton.disabled = false;
    if (error) message("erreur", erreurLisible(error), 6000);
  };
}

// ---------- mot de passe ----------
function vueMotDePasse(app, obligatoire) {
  app.innerHTML = `
    <div class="carte">
      <h1>${obligatoire ? "Choisissez votre mot de passe" : "Changer mon mot de passe"}</h1>
      ${obligatoire ? `<p class="bandeau info">Première connexion : changement obligatoire. 8 caractères minimum, sans votre prénom.</p>` : ""}
      <form id="f-mdp">
        <label for="n1">Nouveau mot de passe</label>
        <input id="n1" type="password" autocomplete="new-password" minlength="8" required>
        <label for="n2">Confirmez</label>
        <input id="n2" type="password" autocomplete="new-password" minlength="8" required>
        <button class="gros vert" type="submit">Enregistrer</button>
      </form>
      ${obligatoire ? `<button class="gros secondaire" id="deco">Se déconnecter</button>` : ""}
    </div>`;
  if (obligatoire) $("#deco").onclick = () => sb.auth.signOut();
  $("#f-mdp").onsubmit = async (ev) => {
    ev.preventDefault();
    const n1 = $("#n1").value, n2 = $("#n2").value;
    if (n1.length < 8) return message("erreur", "8 caractères minimum");
    if (n1 !== n2) return message("erreur", "Les deux mots de passe ne sont pas identiques");
    const b = ev.submitter; b.disabled = true;
    try {
      await appelerComptes({ action: "changer_mdp", nouveau: n1 });
      message("ok", "✔ Mot de passe enregistré");
      await chargerProfil();
      location.hash = "#/scan";
      rendre();
    } catch (e) { message("erreur", erreurLisible(e), 6000); b.disabled = false; }
  };
}

// ---------- fiche pièce ----------
function htmlFiche(p) {
  const infos = [];
  if (p.ovoko_uniquement) infos.push(`<span class="badge info">ℹ Ovoko uniquement</span>`);
  if (p.gardee_de_cote) infos.push(`<span class="badge info">Gardée de côté</span>`);
  if (p.retour_decision === "republier") infos.push(`<span class="badge alerte">Retour : « Republier » décidé — à ranger (double scan)</span>`);
  return `
    <div class="id">${esc(p.id_interne)}</div>
    <div><b>${esc(p.libelle)}</b></div>
    <div class="badges">
      <span class="badge phys">${esc(EP[p.etat_physique] ?? p.etat_physique)}</span>
      <span class="badge comm">${esc(EC[p.etat_commercial] ?? p.etat_commercial)}</span>
      ${infos.join("")}
    </div>
    <dl class="grille">
      <dt>Véhicule</dt><dd>${esc(p.vehicule || "—")}</dd>
      <dt>Lot</dt><dd>${esc(p.lot)}</dd>
      <dt>Emplacement</dt><dd>${esc(p.emplacement || "—")}</dd>
    </dl>
    ${p.ovoko_uniquement ? `<p class="doux">Information seulement : le tri du canal eBay / Ovoko ne se fait jamais au scan.</p>` : ""}`;
}

async function lirePiece(id) {
  const { data, error } = await sb.from("scan_test_pieces_vue").select("*").eq("id_interne", id).maybeSingle();
  if (error) throw error;
  return data;
}

// ---------- scan ----------
function vueScan(app) {
  etat.attente = null;
  app.innerHTML = `
    <div id="consigne" class="consigne">Scannez une pièce ou un emplacement</div>
    <div id="lecteur"></div>
    <button class="gros" id="btn-camera">📷 Scanner</button>
    <form id="f-saisie" class="ligne">
      <input id="code" placeholder="ou tapez l'ID / le code" autocapitalize="characters" autocomplete="off" spellcheck="false">
      <button class="gros" type="submit">OK</button>
    </form>
    <div id="zone"></div>`;
  $("#btn-camera").onclick = () => (etat.scanner ? fermerCamera() : ouvrirCamera(traiterCode));
  $("#f-saisie").onsubmit = (ev) => { ev.preventDefault(); const v = $("#code").value; $("#code").value = ""; traiterCode(v); };
  if (etat.piece) afficherFiche(etat.piece);
}

function consigne(texte, attente = false) {
  const c = $("#consigne");
  if (c) { c.textContent = texte; c.className = `consigne${attente ? " attente" : ""}`; }
}

async function traiterCode(brut) {
  const code = nettoyer(brut);
  if (!code) return message("erreur", "Code vide");
  try {
    if (etat.attente) {
      const { action, piece } = etat.attente;
      return confirmer(action, piece, code.toUpperCase());
    }
    const p = await lirePiece(code);
    if (p) { etat.piece = p; return afficherFiche(p); }
    const { data: e, error } = await sb.from("scan_test_emplacements").select("id,code,actif,libelle").eq("code", code.toUpperCase()).maybeSingle();
    if (error) throw error;
    if (e) return afficherEmplacement(e);
    message("erreur", RE_ID_INTERNE.test(code) ? `Pièce inconnue : ${code}` : `Code inconnu : ${code}`, 6000);
  } catch (err) { message("erreur", erreurLisible(err), 6000); }
}

async function afficherEmplacement(e) {
  etat.piece = null;
  const { data, error } = await sb.from("scan_test_pieces_vue").select("id_interne,libelle,etat_physique").eq("emplacement_id", e.id).order("id_interne");
  if (error) return message("erreur", erreurLisible(error));
  consigne("Scannez une pièce ou un emplacement");
  $("#zone").innerHTML = `<div class="carte"><div class="id">📦 ${esc(e.code)}</div>
    ${e.actif ? "" : `<p class="bandeau erreur">Emplacement désactivé</p>`}
    <p>${data.length} pièce(s) dans cet emplacement</p>
    <table>${data.map((p) => `<tr class="cliquable" data-id="${esc(p.id_interne)}"><td><b>${esc(p.id_interne)}</b></td><td>${esc(p.libelle)}</td></tr>`).join("")}</table></div>`;
  $("#zone").querySelectorAll("tr[data-id]").forEach((tr) => (tr.onclick = () => traiterCode(tr.dataset.id)));
}

function afficherFiche(p) {
  etat.attente = null;
  consigne("Choisissez l'action");
  const actions = actionsPossibles(etat.profil.role, p);
  $("#zone").innerHTML = `
    <div class="carte">${htmlFiche(p)}</div>
    ${actions.length ? actions.map((a) => `<button class="gros ${ACTIONS[a].couleur}" data-a="${a}">${esc(ACTIONS[a].libelle)}</button>`).join("")
                     : `<p class="bandeau info">Aucune action possible pour votre rôle dans cet état.</p>`}
    <button class="gros secondaire" id="autre">Scanner une autre pièce</button>`;
  $("#zone").querySelectorAll("button[data-a]").forEach((b) => (b.onclick = () => choisirAction(b.dataset.a, p)));
  $("#autre").onclick = () => { etat.piece = null; $("#zone").innerHTML = ""; consigne("Scannez une pièce ou un emplacement"); ouvrirCamera(traiterCode); };
}

function choisirAction(action, p) {
  if (ACTIONS[action].emplacement) {
    etat.attente = { action, piece: p };
    consigne(`${p.id_interne} → scannez maintenant l'EMPLACEMENT`, true);
    $("#zone").innerHTML = `<div class="carte">${htmlFiche(p)}</div>
      <p class="bandeau info">Action : ${esc(ACTIONS[action].libelle)}. Scannez le QR de l'emplacement (ou tapez son code ci-dessus).</p>
      <button class="gros secondaire" id="annuler">Annuler</button>`;
    $("#annuler").onclick = () => afficherFiche(p);
    ouvrirCamera(traiterCode);
    return;
  }
  confirmer(action, p, null);
}

function confirmer(action, p, emplacement) {
  etat.attente = null;
  consigne("Confirmez", true);
  const corr = ACTIONS[action].correction;
  $("#zone").innerHTML = `
    <div class="carte">
      <h2>Confirmer : ${esc(ACTIONS[action].libelle)}</h2>
      <div class="id">${esc(p.id_interne)}</div><div>${esc(p.libelle)}</div>
      ${emplacement ? `<p>Emplacement : <b style="font-size:24px">${esc(emplacement)}</b></p>` : ""}
      ${corr ? `<label>État physique</label><select id="c-phys">${Object.entries(EP).map(([k, v]) => `<option value="${k}" ${k === p.etat_physique ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>
                <label>État commercial</label><select id="c-comm">${Object.entries(EC).map(([k, v]) => `<option value="${k}" ${k === p.etat_commercial ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>` : ""}
      <label for="comm">Commentaire ${corr ? "(obligatoire)" : "(facultatif)"}</label>
      <textarea id="comm" rows="2"></textarea>
    </div>
    <button class="gros vert" id="oui">✔ CONFIRMER</button>
    <button class="gros secondaire" id="non">✖ Annuler</button>`;
  $("#non").onclick = () => afficherFiche(p);
  $("#oui").onclick = async (ev) => {
    ev.target.disabled = true;
    const { data, error } = await sb.rpc("scan_action", {
      p_id_interne: p.id_interne, p_action: action, p_emplacement: emplacement, p_commentaire: $("#comm").value || null,
      p_appareil: appareil(), p_physique: corr ? $("#c-phys").value : null, p_commercial: corr ? $("#c-comm").value : null,
    });
    if (error) { message("erreur", erreurLisible(error), 7000); ev.target.disabled = false; return; }
    message("ok", `✔ ${EVENEMENTS[data.evenement] ?? data.evenement} : ${p.id_interne}`);
    try { etat.piece = await lirePiece(p.id_interne); } catch (e) { message("erreur", erreurLisible(e)); }
    const piece = etat.piece ?? p;
    // Photos de préparation (comptes autorisés seulement ; sinon retour direct à la fiche, sans message)
    if (action === "preparer_commande") {
      return ouvrirPhotos({ sb, url: SUPABASE_URL, cle: SUPABASE_CLE_PUBLIQUE, piece, zone: $("#zone"), message, esc,
                            appareil: appareil(), fin: () => afficherFiche(etat.piece ?? piece) });
    }
    afficherFiche(piece);
  };
}

// ---------- suivi (lecture seule) ----------
function vueSuivi(app) {
  const onglets = [["recherche", "Recherche"], ["retours", "Retours en attente"], ["prets", "Prêtes à publier"],
                   ["attendues", "Attendues par lot"], ["absentes", "Absentes"]];
  if (etat.profil.role === "responsable") onglets.push(["robots", "🤖 Robots"]);
  if (!onglets.some(([k]) => k === etat.ongletSuivi)) etat.ongletSuivi = "recherche";
  app.innerHTML = `<h1>Suivi du stock <small class="doux">(lecture seule)</small></h1>
    <div class="onglets">${onglets.map(([k, l]) => `<button data-o="${k}" class="${k === etat.ongletSuivi ? "actif" : ""}">${l}</button>`).join("")}</div>
    <div id="contenu"></div>`;
  app.querySelectorAll("[data-o]").forEach((b) => (b.onclick = () => { etat.ongletSuivi = b.dataset.o; vueSuivi(app); }));
  const c = $("#contenu");
  ({ recherche: suiviRecherche, retours: () => suiviListe(c, "retours"), prets: () => suiviListe(c, "prets"),
     attendues: suiviAttendues, absentes: () => suiviListe(c, "absentes"), robots: suiviRobots })[etat.ongletSuivi](c);
}

function tableauPieces(liste) {
  if (!liste.length) return `<p class="doux">Aucune pièce.</p>`;
  return `<div class="defile"><table><tr><th>ID</th><th>Pièce</th><th>Physique</th><th>Commercial</th><th>Empl.</th></tr>
    ${liste.map((p) => `<tr class="cliquable" data-id="${esc(p.id_interne)}"><td><b>${esc(p.id_interne)}</b></td><td>${esc(p.libelle)}</td>
      <td>${esc(EP[p.etat_physique])}</td><td>${esc(EC[p.etat_commercial])}</td><td>${esc(p.emplacement ?? "")}</td></tr>`).join("")}</table></div>`;
}

function brancherLignes(c) {
  c.querySelectorAll("tr[data-id]").forEach((tr) => (tr.onclick = () => detailPiece(c, tr.dataset.id)));
}

function suiviRecherche(c) {
  c.innerHTML = `<form id="f-rech" class="ligne"><input id="q" placeholder="ID interne, lot ou emplacement" autocomplete="off">
    <button class="gros" type="submit">🔍</button></form><div id="res"></div>`;
  $("#f-rech").onsubmit = async (ev) => {
    ev.preventDefault();
    const q = nettoyer($("#q").value);
    if (!q) return;
    const { data, error } = await sb.from("scan_test_pieces_vue").select("*")
      .or(`id_interne.eq.${q},lot.eq.${q},emplacement.eq.${q.toUpperCase()}`).order("id_interne").limit(300);
    if (error) return message("erreur", erreurLisible(error));
    if (data.length === 1) return detailPiece($("#res"), data[0].id_interne);
    $("#res").innerHTML = `<p>${data.length} résultat(s)</p>${tableauPieces(data)}`;
    brancherLignes($("#res"));
  };
}

async function detailPiece(c, id) {
  const p = await lirePiece(id);
  if (!p) return message("erreur", `Pièce inconnue : ${id}`);
  const [{ data: ev }, { data: tr }] = await Promise.all([
    sb.from("scan_test_evenements").select("*").eq("id_interne", id).order("id", { ascending: false }),
    sb.from("scan_test_robot_traces").select("*").eq("id_interne", id).order("id", { ascending: false }),
  ]);
  c.innerHTML = `<div class="carte">${htmlFiche(p)}
      <dl class="grille" style="margin-top:8px">
        <dt>eBay FR</dt><dd>${esc(p.ebay_fr || "—")}</dd><dt>Copies DE / IT / ES</dt><dd>${esc([p.ebay_de, p.ebay_it, p.ebay_es].map((x) => x || "—").join(" / "))}</dd>
        <dt>ID Ovoko</dt><dd>${esc(p.ovoko_id || "—")}</dd>
      </dl></div>
    <h2>Carnet de vie (${ev?.length ?? 0} geste(s))</h2>
    <div class="defile"><table><tr><th>Quand</th><th>Geste</th><th>Avant → après</th><th>Qui / appareil</th><th>Robot</th></tr>
    ${(ev ?? []).map((e) => `<tr><td>${dateFr(e.cree_le)}</td><td><b>${esc(EVENEMENTS[e.action] ?? e.action)}</b>${e.commentaire ? `<br><i>${esc(e.commentaire)}</i>` : ""}</td>
      <td>${esc(EP[e.physique_avant] ?? "")} → ${esc(EP[e.physique_apres] ?? "")}<br>${esc(EC[e.commercial_avant] ?? "")} → ${esc(EC[e.commercial_apres] ?? "")}
      ${e.emplacement_avant || e.emplacement_apres ? `<br>📦 ${esc(e.emplacement_avant ?? "—")} → ${esc(e.emplacement_apres ?? "—")}` : ""}</td>
      <td>${esc(e.prenom)}<br><small>${esc(e.appareil ?? "")}</small></td><td>${e.traite_robot ? "✔" : "…"} ${esc(e.resultat_robot ?? "")}</td></tr>`).join("")}</table></div>
    <h2>Décisions du robot de scan (veille)</h2>
    ${(tr ?? []).length ? `<div class="defile"><table><tr><th>Quand</th><th>Décision</th><th>Annonce</th><th>Motif</th></tr>
      ${tr.map((t) => `<tr><td>${dateFr(t.cree_le)}</td><td><b>${esc(DECISIONS_ROBOT[t.decision] ?? t.decision)}</b></td>
        <td>${esc([t.plateforme, t.site, t.annonce_ref].filter(Boolean).join(" "))}</td><td>${esc(t.motif)}${t.alerte ? `<br>⚠ ${esc(t.alerte)}` : ""}</td></tr>`).join("")}</table></div>`
      : `<p class="doux">Aucune décision.</p>`}`;
}

async function suiviListe(c, quoi) {
  c.innerHTML = `<p class="chargement">Chargement…</p>`;
  let r = sb.from("scan_test_pieces_vue").select("*").order("id_interne").limit(1000);
  if (quoi === "retours") r = r.eq("etat_physique", "en_retour");
  if (quoi === "prets") r = r.in("etat_commercial", ["prete_a_publier", "prete_a_republier"]);
  if (quoi === "absentes") r = r.eq("etat_physique", "absente");
  const { data, error } = await r;
  if (error) return message("erreur", erreurLisible(error));
  c.innerHTML = `<p>${data.length} pièce(s)</p>${tableauPieces(data)}`;
  brancherLignes(c);
}

async function suiviAttendues(c) {
  c.innerHTML = `<p class="chargement">Chargement…</p>`;
  const { data, error } = await sb.from("scan_test_pieces_vue").select("id_interne,lot,libelle,vehicule,etat_physique,etat_commercial,emplacement")
    .eq("etat_physique", "attendue").order("id_interne").limit(5000);
  if (error) return message("erreur", erreurLisible(error));
  const lots = new Map();
  data.forEach((p) => { if (!lots.has(p.lot)) lots.set(p.lot, []); lots.get(p.lot).push(p); });
  c.innerHTML = `<p>${data.length} pièce(s) attendue(s) non scannée(s), ${lots.size} lot(s)</p>
    ${[...lots].map(([lot, ps]) => `<details class="carte"><summary><b>Lot ${esc(lot)}</b> — ${esc(ps[0].vehicule)} — ${ps.length} pièce(s)</summary>
      ${tableauPieces(ps)}</details>`).join("")}`;
  brancherLignes(c);
}

async function suiviRobots(c) {
  const jour = c.dataset.jour || new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
  c.innerHTML = `<p class="bandeau info">Décisions de la marche à blanc en production (veille) — lecture seule.</p>
    <label for="jour">Jour</label><input type="date" id="jour" value="${jour}"><div id="rob"><p class="chargement">Chargement…</p></div>`;
  $("#jour").onchange = () => { c.dataset.jour = $("#jour").value; suiviRobots(c); };
  const { data, error } = await sb.rpc("scan_robots_veille", { p_jour: jour });
  if (error) { $("#rob").innerHTML = `<p class="bandeau erreur">${esc(erreurLisible(error))}</p>`; return; }
  const r = data.resume;
  $("#rob").innerHTML = `
    <div class="chiffres" style="margin-top:10px">
      <div class="chiffre">Décisions<b>${r.total}</b></div>
      <div class="chiffre">« Certaines »<b>${r.pourcentage_certaines ?? "—"}${r.pourcentage_certaines != null ? " %" : ""}</b></div>
      ${Object.entries(r.par_categorie).map(([k, n]) => `<div class="chiffre">${esc(DECISIONS_ROBOT[k] ?? k)}<b>${n}</b></div>`).join("")}
    </div>
    <p class="doux">« Certaines » = aurait fermé ou rien, hors simulations.</p>
    ${r.texte_resume_veille ? `<details class="carte"><summary>Résumé du jour (veille)</summary><pre style="white-space:pre-wrap">${esc(r.texte_resume_veille)}</pre></details>` : ""}
    <div class="defile"><table><tr><th>Heure</th><th>Pièce</th><th>Plateforme</th><th>Décision</th><th>Motif</th><th>Constat</th></tr>
    ${data.decisions.map((d) => `<tr><td>${esc(d.heure)}${d.simulation ? "<br><small>simulation</small>" : ""}</td><td>${esc(d.id_interne ?? "—")}</td>
      <td>${esc([d.plateforme, d.site].filter(Boolean).join(" ") || d.canal_vente || "—")}<br><small>${esc(d.annonce ?? "")}</small></td>
      <td><b>${esc(DECISIONS_ROBOT[d.categorie] ?? d.categorie)}</b></td><td>${esc(d.motif)}</td>
      <td>${esc(d.constat ?? "")}${d.deja_fait_hors_robot ? `<br>déjà fait hors robot${d.categorie_si_active ? ` (si active : ${esc(DECISIONS_ROBOT[d.categorie_si_active] ?? d.categorie_si_active)})` : ""}` : ""}</td></tr>`).join("")}
    </table></div>`;
}

// ---------- étiquettes ----------
function telecharger(nom, texte) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([texte], { type: "text/plain;charset=utf-8" }));
  a.download = nom; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function vueEtiquettes(app) {
  const { data: empl } = await sb.from("scan_test_emplacements").select("code,actif,essai").eq("actif", true).order("code");
  app.innerHTML = `<h1>Étiquettes Zebra ZD421</h1>
    <p class="bandeau info">Préparation seulement : fichier ZPL et aperçu PDF. Rien n'est envoyé à l'imprimante.</p>
    <div class="carte"><h2>Pièces (55 × 35 mm)</h2>
      <label for="ids">ID internes (un par ligne) ou un n° de lot</label><textarea id="ids" rows="4"></textarea>
      <button class="gros" id="ch-p">Préparer</button><div id="res-p"></div></div>
    <div class="carte"><h2>Emplacements (100 × 50 mm)</h2>
      ${(empl ?? []).map((e) => `<label style="font-weight:400"><input type="checkbox" value="${esc(e.code)}" style="width:auto"> ${esc(e.code)}${e.essai ? " <small>(essai)</small>" : ""}</label>`).join("") || `<p class="doux">Aucun emplacement.</p>`}
      <button class="gros" id="ch-e">Préparer</button><div id="res-e"></div></div>
    <div class="carte"><h2>Planche de QR de test (A4)</h2><button class="gros gris" id="planche">Aperçu PDF de la planche de test</button></div>`;

  const sortie = (zone, zpl, pdf, nom) => {
    zone.innerHTML = `<pre class="zpl">${esc(zpl)}</pre><div class="ligne"><button class="gros" data-z>⬇ ZPL</button><button class="gros gris" data-p>👁 Aperçu PDF</button></div>`;
    zone.querySelector("[data-z]").onclick = () => telecharger(`${nom}.zpl`, zpl);
    zone.querySelector("[data-p]").onclick = () => window.open(pdf().output("bloburl"), "_blank");
  };
  $("#ch-p").onclick = async () => {
    const lignes = $("#ids").value.split(/\s+/).map(nettoyer).filter(Boolean);
    if (!lignes.length) return message("erreur", "Indiquez au moins un ID ou un lot");
    const q = lignes.length === 1 && !RE_ID_INTERNE.test(lignes[0])
      ? sb.from("scan_test_pieces_vue").select("*").eq("lot", lignes[0]).order("id_interne")
      : sb.from("scan_test_pieces_vue").select("*").in("id_interne", lignes).order("id_interne");
    const { data, error } = await q;
    if (error) return message("erreur", erreurLisible(error));
    if (!data.length) return message("erreur", "Aucune pièce trouvée");
    const inconnues = lignes.filter((l) => RE_ID_INTERNE.test(l) && !data.some((p) => p.id_interne === l));
    if (inconnues.length) message("erreur", `Inconnue(s) : ${inconnues.join(", ")}`, 7000);
    sortie($("#res-p"), data.map(zplPiece).join("\n"), () => pdfPieces(window.jspdf.jsPDF, window.qrcode, data), `etiquettes_pieces_${data.length}`);
  };
  $("#ch-e").onclick = () => {
    const codes = [...app.querySelectorAll("input[type=checkbox]:checked")].map((i) => i.value);
    if (!codes.length) return message("erreur", "Cochez au moins un emplacement");
    sortie($("#res-e"), codes.map(zplEmplacement).join("\n"), () => pdfEmplacements(window.jspdf.jsPDF, window.qrcode, codes), `etiquettes_emplacements_${codes.length}`);
  };
  $("#planche").onclick = async () => {
    const { data } = await sb.from("scan_test_pieces_vue").select("id_interne,libelle").order("id_interne").limit(12);
    const codes = (empl ?? []).filter((e) => e.essai).map((e) => e.code);
    window.open(pdfPlancheTest(window.jspdf.jsPDF, window.qrcode, data ?? [], codes).output("bloburl"), "_blank");
  };
}

// ---------- comptes (responsable) ----------
async function vueComptes(app) {
  const [{ data: profils }, { data: journal }, { data: niveaux }, { data: empl }, { data: blanche, error: eBlanche }] = await Promise.all([
    sb.from("scan_profils").select("*").order("prenom"),
    sb.from("scan_journal_comptes").select("*").order("id", { ascending: false }).limit(30),
    sb.from("scan_test_config_niveaux").select("*").order("rang"),
    sb.from("scan_test_emplacements").select("code,actif,essai,niveau_rang").order("code"),
    sb.from("photos_liste_blanche").select("*").order("id", { ascending: false }).limit(20),
  ]);
  const optRoles = (sel) => Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${esc(v)}</option>`).join("");
  app.innerHTML = `<h1>Gestion des comptes</h1>
    <div id="mdp-zone"></div>
    <div class="carte"><h2>Créer un compte</h2>
      <form id="f-creer"><label for="np">Prénom (identifiant, minuscules sans accent)</label><input id="np" autocapitalize="none" required>
        <label for="nr">Rôle</label><select id="nr">${optRoles("equipe")}</select>
        <button class="gros vert" type="submit">Créer</button></form></div>
    <div class="carte"><h2>Comptes</h2><div class="defile"><table><tr><th>Prénom</th><th>Rôle</th><th>État</th><th></th></tr>
      ${(profils ?? []).map((p) => `<tr><td><b>${esc(p.prenom)}</b></td>
        <td><select data-role="${esc(p.prenom)}">${optRoles(p.role)}</select></td>
        <td>${p.actif ? "actif" : "<b>désactivé</b>"}${p.doit_changer_mdp ? "<br><small>doit changer son mot de passe</small>" : ""}</td>
        <td><button class="petit" data-reinit="${esc(p.prenom)}">Réinitialiser le mot de passe</button>
            <button class="petit" data-actif="${esc(p.prenom)}" data-val="${p.actif ? "0" : "1"}">${p.actif ? "Désactiver" : "Réactiver"}</button></td></tr>`).join("")}
    </table></div></div>
    <div class="carte"><h2>Emplacements</h2>
      <p class="doux">Niveaux configurés : ${(niveaux ?? []).map((n) => `${esc(n.libelle)}${n.prefixe ? ` (${esc(n.prefixe)}${"0".repeat(n.chiffres)})` : ""}`).join(" → ")}</p>
      <form id="f-empl"><label>Niveau</label><select id="en">${(niveaux ?? []).map((n) => `<option value="${esc(n.cle)}">${esc(n.libelle)}</option>`).join("")}</select>
        <label>Emplacement parent (code)</label><input id="ep" autocapitalize="characters" placeholder="ex. L1-R01">
        <label>Code du nouvel emplacement</label><input id="ec" autocapitalize="characters" placeholder="ex. L1-R01-E1">
        <button class="gros" type="submit">Créer l'emplacement</button></form>
      <form id="f-ren"><label>Renommer / déplacer : code actuel</label><input id="ra" autocapitalize="characters">
        <label>Nouveau code</label><input id="rn" autocapitalize="characters">
        <label>Nouveau parent (vide = inchangé)</label><input id="rp" autocapitalize="characters">
        <button class="gros gris" type="submit">Renommer / déplacer (historique gardé)</button></form>
      <p class="doux">${(empl ?? []).length} emplacement(s) : ${(empl ?? []).map((e) => esc(e.code) + (e.actif ? "" : " (désactivé)")).join(", ")}</p></div>
    <div class="carte"><h2>Robot de scan (veille, simulation)</h2>
      <p class="doux">Lancement manuel : il lit les événements de scan et écrit seulement ce qu'il aurait fait. Aucun appel à eBay ni à Ovoko.</p>
      <button class="gros gris" id="robot">Lancer un tour du robot de scan</button></div>
    <div class="carte"><h2>Photos de préparation — liste blanche</h2>
      <p class="doux">Une commande en liste blanche reçoit UN envoi réel de photos, même robot en veille. L'autorisation est retirée
        automatiquement après l'envoi (réussi ou non). Chaque ajout est tracé.</p>
      ${eBlanche ? `<p class="bandeau info">Liste blanche indisponible (${esc(erreurLisible(eBlanche))}).</p>` : `
      <form id="f-blanche" class="ligne"><input id="bo" placeholder="N° de commande eBay (ex. 25-15266-42494)" autocomplete="off">
        <button class="gros" type="submit">Ajouter</button></form>
      <table><tr><th>Commande</th><th>Ajoutée</th><th>Utilisée</th><th></th></tr>
      ${(blanche ?? []).map((w) => `<tr><td><b>${esc(w.order_id)}</b></td><td>${dateFr(w.ajoute_le)}<br><small>${esc(w.ajoute_prenom)}</small></td>
        <td>${w.utilise_le ? `${dateFr(w.utilise_le)}<br><small>${esc(w.resultat ?? "")}</small>` : "— (active)"}</td>
        <td>${w.utilise_le ? "" : `<button class="petit" data-retirer="${w.id}">Retirer</button>`}</td></tr>`).join("")}</table>`}</div>
    <div class="carte"><h2>Journal des comptes</h2><table>
      ${(journal ?? []).map((j) => `<tr><td>${dateFr(j.cree_le)}</td><td>${esc(j.par_prenom)}</td><td>${esc(j.action)}</td><td>${esc(j.cible_prenom)} ${esc(j.detail ?? "")}</td></tr>`).join("")}</table></div>`;

  const montrerMdp = (prenom, mdp) => {
    $("#mdp-zone").innerHTML = `<div class="carte"><h2>Mot de passe provisoire de « ${esc(prenom)} »</h2>
      <p class="bandeau info">Affiché UNE SEULE FOIS. Donnez-le de vive voix ; changement obligatoire à la première connexion.</p>
      <div class="mdp">${esc(mdp)}</div><button class="gros" id="note">J'ai noté — masquer</button></div>`;
    $("#note").onclick = () => { $("#mdp-zone").innerHTML = ""; };
    window.scrollTo(0, 0);
  };
  const agir = async (corps, succes) => {
    try { const r = await appelerComptes(corps); message("ok", succes); return r; } catch (e) { message("erreur", erreurLisible(e), 7000); return null; }
  };
  $("#f-creer").onsubmit = async (ev) => {
    ev.preventDefault();
    const r = await agir({ action: "creer", prenom: $("#np").value.trim().toLowerCase(), role: $("#nr").value }, "✔ Compte créé");
    if (r) { await vueComptes(app); montrerMdp(r.prenom, r.mot_de_passe_provisoire); }
  };
  app.querySelectorAll("[data-role]").forEach((s) => (s.onchange = async () => {
    if (!confirm(`Changer le rôle de ${s.dataset.role} en « ${ROLES[s.value]} » ?`)) return vueComptes(app);
    await agir({ action: "changer_role", prenom: s.dataset.role, role: s.value }, "✔ Rôle changé"); vueComptes(app);
  }));
  app.querySelectorAll("[data-reinit]").forEach((b) => (b.onclick = async () => {
    if (!confirm(`Réinitialiser le mot de passe de ${b.dataset.reinit} ?`)) return;
    const r = await agir({ action: "reinitialiser", prenom: b.dataset.reinit }, "✔ Mot de passe réinitialisé");
    if (r) { await vueComptes(app); montrerMdp(r.prenom, r.mot_de_passe_provisoire); }
  }));
  app.querySelectorAll("[data-actif]").forEach((b) => (b.onclick = async () => {
    const act = b.dataset.val === "1";
    if (!confirm(`${act ? "Réactiver" : "Désactiver"} le compte ${b.dataset.actif} ?`)) return;
    await agir({ action: act ? "reactiver" : "desactiver", prenom: b.dataset.actif }, act ? "✔ Compte réactivé" : "✔ Compte désactivé");
    vueComptes(app);
  }));
  $("#f-empl").onsubmit = async (ev) => {
    ev.preventDefault();
    const { error } = await sb.rpc("scan_emplacement_creer", { p_code: $("#ec").value, p_niveau: $("#en").value, p_parent_code: $("#ep").value || null, p_libelle: null });
    if (error) return message("erreur", erreurLisible(error), 7000);
    message("ok", "✔ Emplacement créé"); vueComptes(app);
  };
  $("#f-ren").onsubmit = async (ev) => {
    ev.preventDefault();
    if (!confirm("Renommer / déplacer cet emplacement ? Les étiquettes devront être réimprimées.")) return;
    const { error } = await sb.rpc("scan_emplacement_modifier", { p_code: $("#ra").value, p_nouveau_code: $("#rn").value, p_nouveau_parent_code: $("#rp").value || null });
    if (error) return message("erreur", erreurLisible(error), 7000);
    message("ok", "✔ Emplacement modifié (historique gardé)"); vueComptes(app);
  };
  $("#f-blanche")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const n = $("#bo").value.trim();
    if (!n || !confirm(`Autoriser UN envoi réel de photos pour la commande ${n} ?`)) return;
    const { error } = await sb.rpc("photos_liste_blanche_ajouter", { p_order_id: n });
    if (error) return message("erreur", erreurLisible(error), 7000);
    message("ok", `✔ Commande ${n} en liste blanche (un envoi)`); vueComptes(app);
  });
  app.querySelectorAll("[data-retirer]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Retirer cette autorisation ?")) return;
    const { error } = await sb.rpc("photos_liste_blanche_retirer", { p_id: Number(b.dataset.retirer) });
    if (error) return message("erreur", erreurLisible(error), 7000);
    message("ok", "✔ Autorisation retirée"); vueComptes(app);
  }));
  $("#robot").onclick = async (ev) => {
    ev.target.disabled = true;
    try {
      const { data } = await sb.auth.getSession();
      const r = await fetch(`${SUPABASE_URL}/functions/v1/scan-robot-veille`, { method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_CLE_PUBLIQUE, Authorization: `Bearer ${data.session?.access_token}` }, body: "{}" });
      const j = await r.json();
      if (!j.ok) throw new Error(j.erreur);
      message("ok", `✔ Robot : ${j.examines} événement(s) examiné(s), ${j.traces} trace(s)`, 7000);
    } catch (e) { message("erreur", erreurLisible(e), 7000); }
    ev.target.disabled = false;
  };
}

// ---------- profil ----------
function vueProfil(app) {
  app.innerHTML = `<h1>Mon profil</h1>
    <div class="carte"><dl class="grille"><dt>Prénom</dt><dd>${esc(etat.profil.prenom)}</dd><dt>Rôle</dt><dd>${esc(ROLES[etat.profil.role])}</dd></dl>
      <label for="app-nom">Nom de cet appareil (signe vos actions)</label>
      <div class="ligne"><input id="app-nom" value="${esc(appareil())}" maxlength="60"><button class="gros" id="app-ok">OK</button></div></div>
    <div id="zone-mdp"></div>
    <button class="gros rouge" id="deco">Se déconnecter</button>`;
  vueMotDePasse($("#zone-mdp"), false);
  $("#app-ok").onclick = () => {
    const v = $("#app-nom").value.trim().slice(0, 60);
    if (v) { try { localStorage.setItem("scan-appareil", v); } catch { /* ignoré */ } message("ok", "✔ Appareil renommé"); }
  };
  $("#deco").onclick = async () => { if (confirm("Se déconnecter ?")) await sb.auth.signOut(); };
}

// ---------- démarrage ----------
async function demarrer() {
  const { data } = await sb.auth.getSession();
  etat.session = data.session;
  try { await chargerProfil(); } catch (e) { message("erreur", erreurLisible(e)); }
  // pas d'appel Supabase directement dans ce rappel (risque de blocage du verrou de session) : on diffère
  sb.auth.onAuthStateChange((evt, session) => {
    if (evt === "TOKEN_REFRESHED" || evt === "INITIAL_SESSION") { etat.session = session; return; }
    if (evt === "SIGNED_IN" && etat.session?.user?.id === session?.user?.id && etat.profil) { etat.session = session; return; }
    etat.session = session;
    etat.piece = null;
    setTimeout(async () => {
      try { await chargerProfil(); } catch (e) { message("erreur", erreurLisible(e)); }
      rendre();
    }, 0);
  });
  window.addEventListener("hashchange", rendre);
  rendre();
}
demarrer();
