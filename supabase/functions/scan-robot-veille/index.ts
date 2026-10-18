// ROBOT DE SCAN — MODE VEILLE, NON PLANIFIÉ (aucune tâche pg_cron). Lancement manuel uniquement.
// Lit les événements de scan non traités (scan_test_evenements) et les annonces SIMULÉES (scan_test_plateformes_simulees) ;
// écrit SEULEMENT ce qu'il aurait fait dans scan_test_robot_traces, et marque les événements traités.
// AUCUN appel à eBay ni à Ovoko. Accès : responsable connecté (jeton de session) ou clé de service.
import { createClient } from "@supabase/supabase-js";
import { type Annonce, type Evenement, type Piece, tourRobot } from "../_scan_partage/robot.ts";

const reponse = (corps: unknown, status = 200) =>
  new Response(JSON.stringify(corps), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const cleService = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, cleService, { auth: { persistSession: false } });
  const jeton = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (jeton !== cleService) {
    const { data } = await admin.auth.getUser(jeton);
    const uid = data?.user?.id;
    const { data: p } = uid
      ? await admin.from("scan_profils").select("role,actif,doit_changer_mdp").eq("user_id", uid).maybeSingle()
      : { data: null };
    if (!p || !p.actif || p.role !== "responsable" || p.doit_changer_mdp) return reponse({ ok: false, erreur: "non autorisé" }, 403);
  }
  try {
    const { data: mode } = await admin.from("scan_test_config").select("valeur").eq("cle", "robot_scan_mode").maybeSingle();
    if (mode?.valeur !== "veille") return reponse({ ok: false, erreur: "robot_scan_mode doit valoir « veille »" }, 409);
    const { data: delai } = await admin.from("scan_test_config").select("valeur").eq("cle", "delai_republication_heures").maybeSingle();
    const delaiHeures = Number(delai?.valeur ?? "24") || 24;

    const { data: file, error: e1 } = await admin.from("scan_test_evenements").select("id,id_interne,action,cree_le")
      .eq("traite_robot", false).order("id").limit(500);
    if (e1) throw e1;
    if (!file?.length) return reponse({ ok: true, examines: 0, traites: 0, traces: 0 });
    const ids = [...new Set(file.map((e) => e.id_interne))];
    const { data: tous, error: e2 } = await admin.from("scan_test_evenements").select("id,id_interne,action,cree_le").in("id_interne", ids);
    if (e2) throw e2;
    const { data: pieces, error: e3 } = await admin.from("scan_test_pieces")
      .select("id_interne,lot,etat_physique,etat_commercial,ebay_fr,ebay_de,ebay_it,ebay_es,ovoko_id").in("id_interne", ids);
    if (e3) throw e3;
    const { data: annonces, error: e4 } = await admin.from("scan_test_plateformes_simulees").select("*");
    if (e4) throw e4;

    const res = tourRobot(file as Evenement[], tous as Evenement[], new Map((pieces as Piece[]).map((p) => [p.id_interne, p])),
                          annonces as Annonce[], new Date(), delaiHeures);
    let nTraces = 0;
    for (const { id, r } of res) {
      if (r.traces.length) {
        const { error } = await admin.from("scan_test_robot_traces").upsert(r.traces, { onConflict: "cle", ignoreDuplicates: true });
        if (error) throw error;
        nTraces += r.traces.length;
      }
      const { error } = await admin.from("scan_test_evenements")
        .update({ traite_robot: r.traite, resultat_robot: r.resultat, traite_le: r.traite ? new Date().toISOString() : null }).eq("id", id);
      if (error) throw error;
    }
    return reponse({ ok: true, examines: res.length, traites: res.filter((x) => x.r.traite).length, traces: nTraces });
  } catch (e) {
    console.error("scan-robot-veille : erreur", (e as Error).message);
    return reponse({ ok: false, erreur: (e as Error).message }, 500);
  }
});
