-- ============================================================================
-- SISTEMA CPA BRADFORD — Esquema de base de datos
-- Plataforma: Supabase (PostgreSQL)
-- Propósito: padrón de socios, consulta de estado, solicitud de convocatoria,
--            registro de firmas y (futuro) autogestión de membresía.
-- ============================================================================
-- NOTA: Ejecutar este script en el editor SQL de Supabase, en orden.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- TABLA: familias  (el padrón — una fila por grupo familiar)
-- ----------------------------------------------------------------------------
create table if not exists public.familias (
    id              text primary key,                 -- ej. F-0001
    familia         text not null,                    -- apellidos (paterno materno)
    alumnos         text,                             -- lista de hijos y cursos
    email           text,                             -- correo de contacto (destino OTP)
    socio_activo    boolean not null default false,   -- aportó la cuota => derecho a voto
    fuente          text default 'colegio',           -- 'colegio' (Base A) | 'cpa' (Base B)
    creado_en       timestamptz not null default now(),
    actualizado_en  timestamptz not null default now()
);

comment on table public.familias is 'Padrón de familias del CPA. Una fila = un grupo familiar = un socio.';

-- ----------------------------------------------------------------------------
-- TABLA: apoderados  (RUTs asociados a cada familia; un RUT puede repetirse en varias familias)
-- ----------------------------------------------------------------------------
create table if not exists public.apoderados (
    id          bigint generated always as identity primary key,
    familia_id  text not null references public.familias(id) on delete cascade,
    nombre      text,
    rut         text not null,                        -- normalizado sin puntos, con guion. ej 12345678-9
    creado_en   timestamptz not null default now()
);

create index if not exists idx_apoderados_rut on public.apoderados(rut);
create index if not exists idx_apoderados_familia on public.apoderados(familia_id);

comment on table public.apoderados is 'Apoderados por familia. El mismo RUT puede aparecer en varias familias (familias reconstituidas).';

-- ----------------------------------------------------------------------------
-- TABLA: procesos  (define cada proceso activo: una solicitud de convocatoria, una elección, etc.)
-- ----------------------------------------------------------------------------
create table if not exists public.procesos (
    id          bigint generated always as identity primary key,
    codigo      text unique not null,                 -- ej 'convocatoria-2026-09'
    titulo      text not null,
    tipo        text not null default 'solicitud_convocatoria',
    activo      boolean not null default true,
    umbral      int,                                  -- ej 162 (1/3 de socios activos)
    creado_en   timestamptz not null default now()
);

comment on table public.procesos is 'Procesos del CPA (solicitudes de convocatoria, etc.). Permite reutilizar el sistema en el tiempo.';

-- ----------------------------------------------------------------------------
-- TABLA: firmas  (registro de solicitudes de convocatoria — una por familia por proceso)
-- ----------------------------------------------------------------------------
create table if not exists public.firmas (
    id            bigint generated always as identity primary key,
    proceso_id    bigint not null references public.procesos(id) on delete cascade,
    familia_id    text not null references public.familias(id),
    rut_firmante  text not null,                      -- quién firmó (apoderado verificado)
    nombre_firmante text,
    ip            text,
    user_agent    text,
    firmado_en    timestamptz not null default now(),
    -- ANTI-DUPLICIDAD: una familia solo puede firmar una vez por proceso
    unique (proceso_id, familia_id)
);

create index if not exists idx_firmas_proceso on public.firmas(proceso_id);

comment on table public.firmas is 'Firmas de solicitud de convocatoria. Restricción única (proceso, familia) evita doble firma de la misma familia.';

-- ----------------------------------------------------------------------------
-- TABLA: otp_sesiones  (códigos de verificación enviados por email)
-- ----------------------------------------------------------------------------
create table if not exists public.otp_sesiones (
    id             bigint generated always as identity primary key,
    rut            text not null,
    email          text not null,
    codigo_hash    text not null,                     -- hash del código (nunca en texto plano)
    expira_en      timestamptz not null,
    usado          boolean not null default false,
    intentos       int not null default 0,            -- intentos fallidos de verificación
    ip             text,
    creado_en      timestamptz not null default now()
);

create index if not exists idx_otp_rut on public.otp_sesiones(rut);
create index if not exists idx_otp_creado on public.otp_sesiones(creado_en);

comment on table public.otp_sesiones is 'Códigos OTP. Se guarda hash, no el código. Máx 5 intentos de verificación por código.';

-- ----------------------------------------------------------------------------
-- TABLA: rate_limit  (control de solicitudes por IP/RUT para evitar abuso)
-- ----------------------------------------------------------------------------
create table if not exists public.rate_limit (
    id          bigint generated always as identity primary key,
    clave       text not null,                        -- ej 'consulta:IP' o 'otp:RUT'
    accion      text not null,                        -- 'consulta' | 'enviar_otp'
    creado_en   timestamptz not null default now()
);

create index if not exists idx_rate_clave on public.rate_limit(clave, accion, creado_en);

comment on table public.rate_limit is 'Registro de acciones para limitar frecuencia por IP/RUT.';

-- ----------------------------------------------------------------------------
-- TABLA: pagos  (futuro — autogestión de membresía)
-- ----------------------------------------------------------------------------
create table if not exists public.pagos (
    id            bigint generated always as identity primary key,
    familia_id    text references public.familias(id),
    rut_pagador   text,
    monto         int,
    estado        text default 'pendiente',           -- pendiente | pagado | fallido
    referencia    text,                               -- id de la pasarela de pago
    periodo       text,                               -- ej '2027'
    creado_en     timestamptz not null default now(),
    pagado_en     timestamptz
);

comment on table public.pagos is 'Pagos de cuota CPA (módulo de autogestión de membresía). Al confirmarse, la familia pasa a socio_activo.';

-- ----------------------------------------------------------------------------
-- VISTA: estadísticas agregadas (para la capa pública de transparencia)
-- ----------------------------------------------------------------------------
create or replace view public.v_estadisticas as
select
    count(*)                                          as total_familias,
    count(*) filter (where socio_activo)              as socios_activos,
    count(*) filter (where not socio_activo)          as no_socios,
    ceil(count(*) filter (where socio_activo) / 3.0)  as umbral_tercio
from public.familias;

comment on view public.v_estadisticas is 'Cifras agregadas para mostrar públicamente sin exponer datos personales.';
