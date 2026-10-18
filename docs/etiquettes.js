// Étiquettes Zebra ZD421 (203 dpi = 8 points/mm) — ZPL + aperçu PDF. Rien n'est imprimé ici.
//  - pièce 55 × 35 mm : QR à gauche (ID interne SEUL), à droite : ID, pièce + côté, modèle · cylindrée ;
//  - emplacement 100 × 50 mm à l'horizontale : QR à gauche (code SEUL), code en très gros à droite.
// Module sans dépendance : jsPDF et qrcode-generator sont passés en paramètre (page web et outils Node).

const PTS_MM = 8; // 203 dpi

/** Cylindrée commerciale : « 1.6 essence » → « 1.6 » ; « 1248 cm3 » → reste en cm³ et signalé. */
export function cylindree(motorisation) {
  const m = String(motorisation ?? "").trim();
  const a = m.match(/^(\d\.\d)\b/);
  if (a) return { texte: a[1], doute: false };
  const c = m.match(/(\d{3,4})\s*cm/i);
  if (c) return { texte: `${c[1]} cm³`, doute: true };
  return { texte: m, doute: m.length > 0 };
}

/** Textes d'une étiquette pièce. p : { id_interne, libelle, modele, motorisation } */
export function textesPiece(p) {
  const cyl = cylindree(p.motorisation);
  return {
    id: p.id_interne,
    piece: p.libelle ?? "",
    vehicule: [p.modele, cyl.texte].filter((x) => x && String(x).trim()).join(" · "),
    doute_cylindree: cyl.doute,
  };
}

// ZPL : ^FH avec « _ » pour échapper ^ ~ _ dans les champs (UTF-8 via ^CI28)
function champ(t) {
  return String(t ?? "").replace(/_/g, "_5F").replace(/\^/g, "_5E").replace(/~/g, "_7E");
}

/** ZPL d'une étiquette pièce 55 × 35 mm. */
export function zplPiece(p) {
  const t = textesPiece(p);
  const L = 55 * PTS_MM, H = 35 * PTS_MM; // 440 × 280
  const xTxt = 196, wTxt = L - xTxt - 12;
  return [
    "^XA", "^CI28", `^PW${L}`, `^LL${H}`, "^LH0,0",
    `^FO14,50^BQN,2,7^FDMA,${champ(t.id)}^FS`,
    `^FO${xTxt},34^A0N,36,30^FB${wTxt},1,0,L^FH^FD${champ(t.id)}^FS`,
    `^FO${xTxt},92^A0N,28,25^FB${wTxt},3,2,L^FH^FD${champ(t.piece)}^FS`,
    `^FO${xTxt},190^A0N,26,23^FB${wTxt},2,2,L^FH^FD${champ(t.vehicule)}^FS`,
    "^PQ1", "^XZ",
  ].join("\n");
}

/** ZPL d'une étiquette emplacement 100 × 50 mm (horizontale). */
export function zplEmplacement(code) {
  const L = 100 * PTS_MM, H = 50 * PTS_MM; // 800 × 400
  const xTxt = 320, wTxt = L - xTxt - 20;
  const n = Math.max(String(code).length, 1);
  const h = Math.max(40, Math.min(200, Math.floor(wTxt / (n * 0.62))));
  return [
    "^XA", "^CI28", `^PW${L}`, `^LL${H}`, "^LH0,0",
    `^FO24,60^BQN,2,11^FDMA,${champ(code)}^FS`,
    `^FO${xTxt},${Math.round((H - h) / 2)}^A0N,${h},${Math.round(h * 0.9)}^FB${wTxt},1,0,C^FH^FD${champ(code)}^FS`,
    "^PQ1", "^XZ",
  ].join("\n");
}

// --- PDF d'aperçu -------------------------------------------------------------------------------

function dessinerQR(doc, qrcode, texte, x, y, taille) {
  const qr = qrcode(0, "M");
  qr.addData(texte, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const m = taille / n;
  doc.setFillColor(0, 0, 0);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) doc.rect(x + c * m, y + r * m, m, m, "F");
}

// jsPDF (polices standard) : caractères hors Latin-1 remplacés
const latin1 = (t) => String(t ?? "").replace(/[^\x00-\xFF]/g, "?");

/** Aperçu PDF : une page par étiquette, au format réel. */
export function pdfPieces(jsPDF, qrcode, pieces) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: [55, 35] });
  pieces.forEach((p, i) => {
    if (i > 0) doc.addPage([55, 35], "landscape");
    const t = textesPiece(p);
    dessinerQR(doc, qrcode, t.id, 2, 6, 21);
    doc.setFont("helvetica", "bold"); doc.setFontSize(10);
    doc.text(latin1(t.id), 25, 7);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
    doc.text(doc.splitTextToSize(latin1(t.piece), 28).slice(0, 3), 25, 13);
    doc.setFontSize(8);
    doc.text(doc.splitTextToSize(latin1(t.vehicule), 28).slice(0, 2), 25, 26);
    doc.setDrawColor(200); doc.rect(0.2, 0.2, 54.6, 34.6);
  });
  return doc;
}

export function pdfEmplacements(jsPDF, qrcode, codes) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: [100, 50] });
  codes.forEach((code, i) => {
    if (i > 0) doc.addPage([100, 50], "landscape");
    dessinerQR(doc, qrcode, code, 3, 7.5, 35);
    doc.setFont("helvetica", "bold");
    let taille = 72;
    doc.setFontSize(taille);
    while (taille > 10 && doc.getTextWidth(latin1(code)) > 58) doc.setFontSize(--taille);
    doc.text(latin1(code), 70, 25, { align: "center", baseline: "middle" });
    doc.setDrawColor(200); doc.rect(0.2, 0.2, 99.6, 49.6);
  });
  return doc;
}

/** Planche A4 de QR de test (pièces puis emplacements) pour les essais au téléphone. */
export function pdfPlancheTest(jsPDF, qrcode, pieces, codes) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const items = [...pieces.map((p) => ({ qr: p.id_interne, l1: p.id_interne, l2: p.libelle ?? "" })),
                 ...codes.map((c) => ({ qr: c, l1: c, l2: "Emplacement (essai)" }))];
  const col = 3, larg = 60, haut = 62, x0 = 15, y0 = 22;
  doc.setFont("helvetica", "bold"); doc.setFontSize(13);
  doc.text("SCAN Detapieces — planche de QR de TEST (données d'essai)", 105, 12, { align: "center" });
  items.forEach((it, i) => {
    const parPage = col * 4;
    if (i > 0 && i % parPage === 0) { doc.addPage(); }
    const k = i % parPage, x = x0 + (k % col) * larg, y = y0 + Math.floor(k / col) * haut;
    dessinerQR(doc, qrcode, it.qr, x + 12, y, 36);
    doc.setFont("helvetica", "bold"); doc.setFontSize(10);
    doc.text(latin1(it.l1), x + 30, y + 42, { align: "center" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(8);
    doc.text(latin1(it.l2), x + 30, y + 47, { align: "center", maxWidth: 56 });
  });
  return doc;
}
