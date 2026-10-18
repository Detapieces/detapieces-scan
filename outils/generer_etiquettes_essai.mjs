// Prépare (sans rien imprimer) : planche de QR de TEST (A4), aperçus PDF et fichiers ZPL d'essai, à partir des données d'essai.
// Sorties dans sorties/ (non versionné) — à copier où Ruben le souhaite. Usage : node outils/generer_etiquettes_essai.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { jsPDF } from "jspdf";
import qrcode from "qrcode-generator";
import { pdfEmplacements, pdfPieces, pdfPlancheTest, textesPiece, zplEmplacement, zplPiece } from "../docs/etiquettes.js";

const sql = readFileSync(new URL("../supabase/donnees/scan_test_donnees.sql", import.meta.url), "utf8");
const pieces = [...sql.matchAll(/^\('([^']+)', '([^']+)', '([^']+)', '([^']*)', '[^']*', '[^']*', '([^']*)', '[^']*', '([^']*)'/gm)]
  .map((m) => ({ id_interne: m[1], lot: m[2], libelle: m[4], modele: m[5], motorisation: m[6] }));
const codes = [...sql.matchAll(/select '([A-Z0-9-]+)', \(select rang/g)].map((m) => m[1]);
const echantillon = pieces.slice(0, 12);

mkdirSync(new URL("../sorties/", import.meta.url), { recursive: true });
const ecrire = (nom, contenu) => writeFileSync(new URL(`../sorties/${nom}`, import.meta.url), contenu);
ecrire("planche_QR_test.pdf", Buffer.from(pdfPlancheTest(jsPDF, qrcode, echantillon, codes).output("arraybuffer")));
ecrire("apercu_etiquettes_pieces_essai.pdf", Buffer.from(pdfPieces(jsPDF, qrcode, echantillon).output("arraybuffer")));
ecrire("apercu_etiquettes_emplacements_essai.pdf", Buffer.from(pdfEmplacements(jsPDF, qrcode, codes).output("arraybuffer")));
ecrire("etiquettes_pieces_essai.zpl", echantillon.map(zplPiece).join("\n"));
ecrire("etiquettes_emplacements_essai.zpl", codes.map(zplEmplacement).join("\n"));
const doutes = pieces.filter((p) => textesPiece(p).doute_cylindree).map((p) => `${p.id_interne} (${p.motorisation})`);
console.log(`${pieces.length} pièces lues, ${echantillon.length} sur la planche, ${codes.length} emplacements d'essai.`);
console.log(doutes.length ? `Cylindrées à vérifier : ${doutes.join(", ")}` : "Aucune cylindrée douteuse.");
