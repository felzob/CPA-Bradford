-- ============================================================================
-- SISTEMA CPA BRADFORD — Políticas de seguridad (RLS)
-- ============================================================================
-- Principio: el frontend NO accede directo a las tablas sensibles.
-- Toda la lógica (buscar familia por RUT, enviar OTP, verificar, firmar)
-- pasa por Edge Functions que usan la service_role key (server-side).
-- Por eso habilitamos RLS y NO creamos políticas públicas de lectura/escritura
-- sobre las tablas con datos personales.
-- ============================================================================

-- Habilitar RLS en todas las tablas
alter table public.familias      enable row level security;
alter table public.apoderados    enable row level security;
alter table public.procesos      enable row level security;
alter table public.firmas        enable row level security;
alter table public.otp_sesiones  enable row level security;
alter table public.pagos         enable row level security;

-- ----------------------------------------------------------------------------
-- Sin políticas para 'anon' ni 'authenticated' sobre tablas con datos personales.
-- Esto significa: el cliente público NO puede leer familias, apoderados,
-- otp_sesiones ni firmas directamente. Solo las Edge Functions (service_role)
-- pueden operar sobre ellas. Es lo correcto para proteger datos personales.
-- ----------------------------------------------------------------------------

-- ÚNICA excepción: lectura pública de las cifras agregadas (transparencia),
-- que NO exponen datos personales. Se expone vía una función RPC controlada.

create or replace function public.estadisticas_publicas()
returns table(total_familias bigint, socios_activos bigint, no_socios bigint, umbral_tercio numeric)
language sql
security definer
set search_path = public
as $$
    select total_familias, socios_activos, no_socios, umbral_tercio
    from public.v_estadisticas;
$$;

-- Permitir que el rol anónimo ejecute solo esta función (cifras agregadas)
grant execute on function public.estadisticas_publicas() to anon;

comment on function public.estadisticas_publicas is 'Expone solo cifras agregadas del padrón. No entrega datos personales.';
