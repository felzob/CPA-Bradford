# Sistema CPA Bradford — Guía de Despliegue

Sistema para el Centro de Padres y Apoderados: consulta de estado de socio, solicitud de convocatoria a asamblea (Art. 16°), y base para autogestión de membresía.

**Importante:** este sistema debe montarse en infraestructura **institucional del colegio** (cuenta Supabase institucional, dominio del colegio), no en cuentas personales, para que perdure entre directorios.

---

## Arquitectura

```
Navegador (padre)
    |
    v
web/index.html  (frontend estático — se aloja en parents.bradfordsc.cl)
    |  llamadas HTTPS
    v
Edge Function "cpa-api"  (lógica server-side, usa service_role)
    |
    v
Base de datos Supabase (PostgreSQL)
    - familias, apoderados, procesos, firmas, otp_sesiones, pagos
```

El frontend **nunca** accede directo a la base de datos. Todo pasa por la Edge Function, que es la única con permisos (service_role). Esto protege los datos personales.

---

## Contenido del paquete

```
sistema-cpa/
├── db/
│   ├── 01_schema.sql          → crea las tablas y la vista de estadísticas
│   ├── 02_rls.sql             → activa seguridad (RLS) + función de cifras públicas
│   ├── 03_seed_data.sql       → carga el padrón (864 familias, 1.595 apoderados)
│   └── catastro_familias.json → catastro fuente (respaldo)
├── functions/
│   └── cpa-api/index.ts       → Edge Function (API)
├── web/
│   └── index.html             → portal de socios (frontend)
└── README-DESPLIEGUE.md       → este archivo
```

---

## Pasos de despliegue

### 1. Crear el proyecto Supabase (cuenta institucional del colegio)
- Nuevo proyecto en supabase.com con la cuenta institucional.
- Anotar: `Project URL`, `anon key`, `service_role key`.

### 2. Crear el esquema y cargar datos
En el **SQL Editor** de Supabase, ejecutar en orden:
1. `db/01_schema.sql`
2. `db/02_rls.sql`
3. `db/03_seed_data.sql`

Verificar: `select * from public.v_estadisticas;` → debe mostrar ~864 familias, ~485 socios activos.

### 3. Configurar el servicio de email (OTP)
El sistema envía el código OTP al correo registrado de cada familia. Opciones:
- **Resend** (recomendado, simple): crear cuenta, obtener API key, verificar el dominio `bradfordsc.cl`.
- Alternativas: AWS SES, SendGrid.

Sin API key configurada, la función corre en **modo demo** (loguea el código en consola, no lo envía). Útil para pruebas.

### 4. Desplegar la Edge Function
```bash
supabase functions deploy cpa-api --project-ref <REF_DEL_PROYECTO>
```
Configurar los secrets (variables de entorno):
```bash
supabase secrets set RESEND_API_KEY=xxxxx --project-ref <REF>
supabase secrets set FROM_EMAIL=noreply@bradfordsc.cl --project-ref <REF>
```
(`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase automáticamente.)

### 5. Configurar y publicar el frontend
En `web/index.html`, completar al inicio del `<script>`:
```js
const API_URL = "https://<TU-PROYECTO>.supabase.co/functions/v1/cpa-api";
const ANON_KEY = "<TU_ANON_KEY>";
```
Publicar el archivo en el hosting del colegio, apuntando el dominio **parents.bradfordsc.cl** a él (o en Netlify/Vercel como alternativa).

---

## Modelo de datos (resumen)

| Tabla | Qué guarda |
|-------|------------|
| `familias` | Padrón. Una fila por grupo familiar. Campo `socio_activo` = derecho a voto. |
| `apoderados` | RUTs por familia. Un RUT puede estar en varias familias (reconstituidas). |
| `procesos` | Cada proceso (solicitud de convocatoria, etc.) con su umbral. |
| `firmas` | Firmas de solicitud. **Unique (proceso, familia)** = anti-duplicidad. |
| `otp_sesiones` | Códigos OTP enviados por email. |
| `pagos` | Futuro: pagos de cuota (autogestión de membresía). |

---

## Reglas de negocio implementadas

- **Socio activo = familia que aportó la cuota** (Art. 5°). Solo estas pueden firmar.
- **Una familia = un voto = una firma** (Art. 19°/20°). La restricción `unique(proceso, familia)` impide doble firma.
- **Familias reconstituidas:** un RUT puede pertenecer a varias familias; cada una decide y firma por separado.
- **Verificación de identidad:** el OTP se envía al **email registrado de la familia**, no a uno que el usuario escriba. Impide que alguien firme con el RUT de otro.
- **Datos protegidos:** el frontend solo ve lo mínimo. Las cifras públicas (transparencia) se exponen agregadas, sin datos personales.

---

## Actualizar el padrón (Base B del CPA)

Cuando llegue la base de aportes directos al CPA (Base B), se consolida con la Base A y se regenera `03_seed_data.sql`, o se hace `update public.familias set socio_activo=true where id in (...)` para las familias que aportaron directo.

---

## Pendiente / futuro

- **Módulo de pago** (tabla `pagos` ya creada): conectar pasarela (Webpay/Flow) para que una familia se haga socia en línea.
- **Sistema de votación** para el día de la elección.
- **Validación legal** (Provoste Matamala) del flujo completo antes de producción.
