// ============================================================================
// SISTEMA CPA BRADFORD — Edge Function (API server-side)
// Supabase Edge Function (Deno / TypeScript)
// ----------------------------------------------------------------------------
// Toda la lógica sensible corre aquí con service_role (el frontend nunca toca la DB).
// Endpoints (via ?action=):
//   - estadisticas     : cifras agregadas (público, sin datos personales)
//   - consultar        : RUT -> estado de socio de sus familias (SIN OTP, solo consulta)
//   - enviar_otp       : genera y envía OTP al email registrado (para firmar)
//   - verificar_firmar : valida OTP (máx 5 intentos) y registra firma (anti-duplicidad)
// Seguridad: rate limiting por IP/RUT, OTP hasheado, límite de intentos.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") ?? "noreply@bradfordsc.cl";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

// Límites (estándar)
const LIMITE_CONSULTA = 30;      // consultas por hora por IP
const LIMITE_OTP = 5;            // solicitudes de OTP por hora por RUT
const MAX_INTENTOS_OTP = 5;      // intentos de verificación por código

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function limpiaRut(r: string) { return (r || "").replace(/[^0-9kK]/g, "").toUpperCase(); }
function rutNorm(r: string) { const c = limpiaRut(r); return c.length < 2 ? c : c.slice(0, -1) + "-" + c.slice(-1); }
function maskEmail(e: string) {
  const [u, d] = (e || "").split("@"); if (!d) return e;
  const um = u.length <= 2 ? u[0] + "*" : u.slice(0, 2) + "*".repeat(Math.max(1, u.length - 2));
  return um + "@" + d;
}
async function sha256(txt: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(txt));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function getIP(req: Request) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "desconocida";
}

// Rate limit: cuenta acciones en la última hora; registra la nueva. Devuelve true si excede.
async function excedeRate(clave: string, accion: string, limite: number) {
  const desde = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await admin.from("rate_limit").select("*", { count: "exact", head: true })
    .eq("clave", clave).eq("accion", accion).gte("creado_en", desde);
  if ((count ?? 0) >= limite) return true;
  await admin.from("rate_limit").insert({ clave, accion });
  return false;
}

async function enviarEmailOTP(email: string, codigo: string) {
  if (!RESEND_API_KEY) { console.log(`[OTP DEMO] ${email} -> ${codigo}`); return { demo: true }; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM_EMAIL, to: email,
      subject: "Tu código de verificación — Centro de Padres Bradford",
      html: `<p>Tu código de verificación es:</p><h2 style="letter-spacing:4px">${codigo}</h2><p>Válido por 10 minutos y hasta 5 intentos. Si no lo solicitaste, ignora este correo.</p>`,
    }),
  });
  return await res.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const ip = getIP(req);
  try {
    const action = new URL(req.url).searchParams.get("action");
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    // ---- estadisticas (público) ----
    if (action === "estadisticas") {
      const { data, error } = await admin.rpc("estadisticas_publicas");
      if (error) throw error;
      return json({ ok: true, estadisticas: data?.[0] ?? null });
    }

    // ---- consultar (SIN OTP, solo estado de socio) ----
    if (action === "consultar") {
      if (await excedeRate(ip, "consulta", LIMITE_CONSULTA))
        return json({ ok: false, error: "demasiadas_consultas" }, 429);
      const rut = rutNorm(body.rut || "");
      if (rut.length < 8) return json({ ok: false, error: "rut_invalido" }, 400);

      const { data: aps } = await admin.from("apoderados").select("familia_id, nombre").eq("rut", rut);
      if (!aps || aps.length === 0) return json({ ok: false, error: "no_encontrado" });

      const ids = aps.map((a) => a.familia_id);
      const { data: fams } = await admin.from("familias")
        .select("id, familia, alumnos, socio_activo").in("id", ids);

      // NO se devuelve email ni datos de contacto en la consulta pública
      const familias = (fams || []).map((f) => ({
        id: f.id, familia: f.familia, alumnos: f.alumnos, socio_activo: f.socio_activo,
      }));
      return json({ ok: true, nombre: aps[0].nombre, familias });
    }

    // ---- enviar_otp (para firmar) ----
    if (action === "enviar_otp") {
      const rut = rutNorm(body.rut || "");
      if (await excedeRate(rut, "enviar_otp", LIMITE_OTP))
        return json({ ok: false, error: "demasiados_codigos" }, 429);

      const { data: aps } = await admin.from("apoderados").select("familia_id").eq("rut", rut).limit(1);
      if (!aps || aps.length === 0) return json({ ok: false, error: "no_encontrado" }, 404);

      const { data: fam } = await admin.from("familias").select("email").eq("id", aps[0].familia_id).single();
      const email = fam?.email;
      if (!email) return json({ ok: false, error: "sin_email" }, 400);

      const codigo = String(Math.floor(100000 + Math.random() * 900000));
      const codigo_hash = await sha256(codigo + rut); // hash con sal simple (rut)
      const expira = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      await admin.from("otp_sesiones").insert({ rut, email, codigo_hash, expira_en: expira, ip });
      await enviarEmailOTP(email, codigo);
      return json({ ok: true, email_masked: maskEmail(email) });
    }

    // ---- verificar_firmar ----
    if (action === "verificar_firmar") {
      const rut = rutNorm(body.rut || "");
      const codigo = String(body.codigo || "").trim();
      const familiaIds: string[] = body.familias || [];

      const { data: otps } = await admin.from("otp_sesiones").select("*")
        .eq("rut", rut).eq("usado", false).gte("expira_en", new Date().toISOString())
        .order("creado_en", { ascending: false }).limit(1);
      if (!otps || otps.length === 0) return json({ ok: false, error: "otp_expirado" }, 401);
      const otp = otps[0];

      if (otp.intentos >= MAX_INTENTOS_OTP) {
        await admin.from("otp_sesiones").update({ usado: true }).eq("id", otp.id);
        return json({ ok: false, error: "max_intentos" }, 429);
      }

      const hash = await sha256(codigo + rut);
      if (hash !== otp.codigo_hash) {
        await admin.from("otp_sesiones").update({ intentos: otp.intentos + 1 }).eq("id", otp.id);
        return json({ ok: false, error: "otp_invalido", intentos_restantes: MAX_INTENTOS_OTP - otp.intentos - 1 }, 401);
      }

      // OTP correcto -> registrar firmas
      const { data: proc } = await admin.from("procesos").select("id").eq("activo", true).limit(1).single();
      if (!proc) return json({ ok: false, error: "sin_proceso" }, 400);

      const resultados: any[] = [];
      for (const fid of familiaIds) {
        const { data: rel } = await admin.from("apoderados").select("nombre").eq("rut", rut).eq("familia_id", fid).limit(1);
        if (!rel || rel.length === 0) { resultados.push({ familia: fid, ok: false, motivo: "no_apoderado" }); continue; }
        const { data: fam } = await admin.from("familias").select("socio_activo").eq("id", fid).single();
        if (!fam?.socio_activo) { resultados.push({ familia: fid, ok: false, motivo: "no_socio" }); continue; }
        const { error: eIns } = await admin.from("firmas").insert({
          proceso_id: proc.id, familia_id: fid, rut_firmante: rut, nombre_firmante: rel[0].nombre, ip,
        });
        resultados.push(eIns ? { familia: fid, ok: false, motivo: "ya_firmada" } : { familia: fid, ok: true });
      }
      await admin.from("otp_sesiones").update({ usado: true }).eq("id", otp.id);
      return json({ ok: true, resultados });
    }

    return json({ ok: false, error: "accion_desconocida" }, 400);
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: "error_interno" }, 500); // no exponer detalles del error
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
