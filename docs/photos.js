// SCAN — photos de préparation des commandes eBay (19/10/2026). Appelé après « Préparer une commande ».
// 1. « Commande trouvée » : la pièce scannée, l'annonce, le pays, l'acheteur ; l'employé confirme explicitement.
// 2. « Photos » : 1 à 5 photos (appareil photo du téléphone), suggestion « avant emballage / pendant l'emballage / emballé »,
//    suppression ou reprise, compression sur le téléphone (1600 px, JPEG ~80 %, < 300 Ko), bouton « Valider » dès 1 photo.
// La page ne parle qu'à Supabase (fonction photos-preparation) : jamais à eBay. Le message part ensuite par le robot.

export const SUGGESTIONS = ["Avant emballage", "Pendant l'emballage", "Emballé", "Photo 4", "Photo 5"];
export const MAX_PHOTOS = 5;
export const LARGEUR_MAX = 1600;
export const CIBLE_OCTETS = 300 * 1024;
export const RAPPEL_ETIQUETTE = "Photo emballé : avant de coller l'étiquette";
const LANGUES = { fr: "français", de: "allemand", it: "italien", es: "espagnol", en: "anglais" };

/** Dimensions réduites : largeur ≤ 1600 px, proportions gardées. */
export function dimensions(l, h, max = LARGEUR_MAX) {
  if (l <= max) return { l, h };
  return { l: max, h: Math.round((h * max) / l) };
}

/** Qualités JPEG essayées, de 0,8 à 0,5, jusqu'à passer sous 300 Ko. */
export const QUALITES = [0.8, 0.7, 0.6, 0.5];

async function compresser(fichier) {
  const image = await createImageBitmap(fichier, { imageOrientation: "from-image" });
  const { l, h } = dimensions(image.width, image.height);
  const toile = document.createElement("canvas");
  toile.width = l; toile.height = h;
  toile.getContext("2d").drawImage(image, 0, 0, l, h);
  image.close?.();
  let blob = null;
  for (const q of QUALITES) {
    blob = await new Promise((ok) => toile.toBlob(ok, "image/jpeg", q));
    if (blob && blob.size <= CIBLE_OCTETS) break;
  }
  if (!blob) throw new Error("Compression impossible sur ce téléphone");
  return blob;
}

/**
 * Lance le circuit photos. o = { sb, url, cle, piece, zone, message, esc, appareil, fin }
 * fin() : retour à la fiche de la pièce. Si le compte n'est pas autorisé aux photos : fin() tout de suite, sans message.
 */
export async function ouvrirPhotos(o) {
  const { zone, esc, message } = o;
  const appel = async (corps, multipart = false) => {
    const { data } = await o.sb.auth.getSession();
    const r = await fetch(`${o.url}/functions/v1/photos-preparation`, {
      method: "POST",
      headers: { apikey: o.cle, Authorization: `Bearer ${data.session?.access_token}`, ...(multipart ? {} : { "Content-Type": "application/json" }) },
      body: multipart ? corps : JSON.stringify(corps),
    });
    return r.json().catch(() => ({ ok: false, statut: "erreur", message: `Erreur serveur (${r.status})` }));
  };

  zone.innerHTML = `<div class="carte"><p class="chargement">Recherche de la commande eBay de ${esc(o.piece.id_interne)}…</p></div>`;
  let r;
  try { r = await appel({ action: "trouver", id_interne: o.piece.id_interne, appareil: o.appareil }); }
  catch { message("erreur", "Pas de connexion internet : photos non commencées", 7000); return o.fin(); }
  if (r.statut === "non_autorise") return o.fin();
  if (!r.ok) {
    zone.innerHTML = `<div class="carte"><h2>Photos de préparation</h2>
      <p class="bandeau ${r.statut === "deja" ? "info" : "erreur"}">${esc(r.message)}</p></div>
      <button class="gros secondaire" id="ph-retour">Retour à la pièce</button>`;
    zone.querySelector("#ph-retour").onclick = o.fin;
    return;
  }
  return ecranCommande(o, appel, r);
}

function ecranCommande(o, appel, r) {
  const { zone, esc, message } = o;
  const c = r.commande;
  const probable = c.certitude !== "certain";
  zone.innerHTML = `
    <div class="carte"><h2>Commande trouvée</h2>
      ${c.expediee ? `<p class="bandeau erreur">${esc(r.message)}</p>` : ""}
      ${probable ? `<p class="bandeau alerte">⚠ Lien « probable » entre la pièce et l'annonce : comparez le titre de l'annonce avec la pièce scannée.</p>` : ""}
      <dl class="grille">
        <dt>Pièce scannée</dt><dd><b>${esc(o.piece.id_interne)}</b> — ${esc(o.piece.libelle)}<br><small>lot ${esc(c.lot_scan ?? o.piece.lot)}${c.type_liaison ? ` · liaison : ${esc(c.type_liaison)}` : ""}</small></dd>
        <dt>Annonce eBay</dt><dd>${esc(c.titre_annonce ?? "—")}<br><small>${esc(c.item_id)}</small></dd>
        <dt>Commande</dt><dd>${esc(c.order_id)}</dd>
        <dt>Site / pays</dt><dd>${esc(c.canal ?? "—")}${c.pays ? ` — ${esc(c.pays)}` : ""}</dd>
        <dt>Acheteur</dt><dd>${esc(c.acheteur)}</dd>
        <dt>Message</dt><dd>${esc(LANGUES[c.langue] ?? c.langue)}${c.signalement ? `<br><small>${esc(c.signalement)}</small>` : ""}</dd>
      </dl>
      <label class="case"><input type="checkbox" id="ph-ok"> Je confirme que c'est la bonne commande pour cette pièce</label>
    </div>
    <button class="gros vert" id="ph-confirmer" disabled>✔ Confirmer et prendre les photos</button>
    <button class="gros rouge" id="ph-refuser">✖ Ce n'est pas la bonne commande</button>`;
  zone.querySelector("#ph-ok").onchange = (ev) => { zone.querySelector("#ph-confirmer").disabled = !ev.target.checked; };
  zone.querySelector("#ph-refuser").onclick = async (ev) => {
    if (!confirm("Bloquer cette préparation ? Aucun message ne sera envoyé et Ruben sera prévenu.")) return;
    ev.target.disabled = true;
    const x = await appel({ action: "refuser", id: r.id }).catch(() => ({ ok: false, message: "Pas de connexion internet : réessayez" }));
    message(x.ok ? "ok" : "erreur", x.message, 7000);
    if (x.ok) o.fin(); else ev.target.disabled = false;
  };
  zone.querySelector("#ph-confirmer").onclick = () => ecranPhotos(o, appel, r);
}

function ecranPhotos(o, appel, r) {
  const { zone, esc, message } = o;
  const photos = [];                       // { blob, url }
  let remplacer = null;                    // index de la photo à reprendre
  const rendre = () => {
    const n = photos.length;
    zone.innerHTML = `
      <div class="carte"><h2>Photos — ${esc(o.piece.id_interne)}</h2>
        <p class="doux">De 1 à ${MAX_PHOTOS} photos. Ordre conseillé : avant emballage, pendant l'emballage, emballé.</p>
        <p class="bandeau alerte">📦 ${esc(RAPPEL_ETIQUETTE)}</p>
        <div class="vignettes">
          ${photos.map((p, i) => `<figure class="vignette"><img src="${p.url}" alt="${esc(SUGGESTIONS[i])}">
              <figcaption>${i + 1}. ${esc(SUGGESTIONS[i])} <small>${Math.round(p.blob.size / 1024)} Ko</small></figcaption>
              <div class="ligne"><button class="petit" data-rep="${i}">↻ Reprendre</button><button class="petit" data-sup="${i}">🗑 Supprimer</button></div></figure>`).join("")}
        </div>
        <input type="file" id="ph-fichier" accept="image/*" capture="environment" hidden>
        ${n < MAX_PHOTOS ? `<button class="gros" id="ph-prendre">📷 Prendre la photo ${n + 1} : ${esc(SUGGESTIONS[n])}</button>` : `<p class="doux">${MAX_PHOTOS} photos : maximum atteint.</p>`}
      </div>
      <button class="gros vert" id="ph-valider" ${n ? "" : "disabled"}>✔ Valider (${n} photo${n > 1 ? "s" : ""})</button>
      <button class="gros secondaire" id="ph-plus-tard">Annuler (rien n'est envoyé)</button>`;
    const entree = zone.querySelector("#ph-fichier");
    entree.onchange = async () => {
      const f = entree.files?.[0];
      if (!f) return;
      try {
        const blob = await compresser(f);
        const p = { blob, url: URL.createObjectURL(blob) };
        if (remplacer !== null) { URL.revokeObjectURL(photos[remplacer].url); photos[remplacer] = p; } else photos.push(p);
      } catch (e) { message("erreur", e.message ?? "Photo illisible", 6000); }
      remplacer = null;
      rendre();
    };
    zone.querySelector("#ph-prendre")?.addEventListener("click", () => { remplacer = null; entree.click(); });
    zone.querySelectorAll("[data-rep]").forEach((b) => (b.onclick = () => { remplacer = Number(b.dataset.rep); entree.click(); }));
    zone.querySelectorAll("[data-sup]").forEach((b) => (b.onclick = () => {
      const i = Number(b.dataset.sup);
      URL.revokeObjectURL(photos[i].url); photos.splice(i, 1); rendre();
    }));
    zone.querySelector("#ph-plus-tard").onclick = () => {
      if (photos.length && !confirm("Abandonner ces photos ? Rien ne sera envoyé.")) return;
      photos.forEach((p) => URL.revokeObjectURL(p.url)); o.fin();
    };
    zone.querySelector("#ph-valider").onclick = async (ev) => {
      ev.target.disabled = true; ev.target.textContent = "Envoi des photos…";
      const f = new FormData();
      f.append("action", "valider"); f.append("id", String(r.id)); f.append("confirme", "oui");
      photos.forEach((p, i) => f.append(`photo${i + 1}`, p.blob, `photo${i + 1}.jpg`));
      let x;
      try { x = await appel(f, true); } catch { x = { ok: false, message: "Pas de connexion internet : les photos sont gardées, réessayez" }; }
      if (!x.ok) { message("erreur", x.message, 8000); ev.target.disabled = false; ev.target.textContent = `✔ Valider (${photos.length})`; return; }
      photos.forEach((p) => URL.revokeObjectURL(p.url));
      message("ok", `✔ ${x.message}`, 8000);
      o.fin();
    };
  };
  rendre();
}
