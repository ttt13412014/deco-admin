-- =====================================================================
--  PANEL ADMINISTRATIVO DE&CO — MVP (Clientes · Cobranzas · Caja diaria)
--  Basado en procedimientos A01, A04, A05 y A06 del Área Administración.
--  Ejecutar completo en Supabase → SQL Editor → New query → Run.
-- =====================================================================

-- ---------- Utilidades ----------------------------------------------

-- Fecha "de hoy" en Argentina (Supabase corre en UTC)
create or replace function public.hoy() returns date
language sql stable as $$
  select (now() at time zone 'America/Argentina/Cordoba')::date
$$;

-- ---------- Perfiles / roles -----------------------------------------
-- Roles: administracion (carga y gestiona), ventas (consulta), gerencia (todo + controla),
--        pendiente (se registró solo y espera que Gerencia le asigne un rol: no ve nada)

create table if not exists public.perfiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  nombre      text not null default '',
  email       text,
  rol         text not null default 'pendiente'
              constraint perfiles_rol_check check (rol in ('administracion','ventas','gerencia','pendiente')),
  created_at  timestamptz not null default now()
);

create or replace function public.mi_rol() returns text
language sql stable security definer set search_path = public as $$
  select rol from public.perfiles where id = auth.uid()
$$;

create or replace function public.puede_editar() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select rol in ('administracion','gerencia') from public.perfiles where id = auth.uid()), false)
$$;

create or replace function public.es_gerencia() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select rol = 'gerencia' from public.perfiles where id = auth.uid()), false)
$$;

-- ¿Tiene un rol asignado? (los pendientes no ven nada)
create or replace function public.tiene_acceso() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select rol in ('administracion','ventas','gerencia') from public.perfiles where id = auth.uid()), false)
$$;

-- No se puede quedar la app sin ningún usuario de Gerencia
create or replace function public.tg_perfiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.rol = 'gerencia' and new.rol <> 'gerencia'
     and not exists (select 1 from public.perfiles where rol = 'gerencia' and id <> old.id) then
    raise exception 'Tiene que quedar al menos un usuario de Gerencia.';
  end if;
  return new;
end $$;
drop trigger if exists perfiles_guard on public.perfiles;
create trigger perfiles_guard before update on public.perfiles
  for each row execute function public.tg_perfiles_guard();

-- Al registrarse (desde la app o en Authentication) se crea su perfil.
-- El PRIMER usuario queda como gerencia; el resto como pendiente hasta que Gerencia le asigne un rol.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.perfiles (id, email, nombre, rol)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'nombre', split_part(new.email, '@', 1)),
    case when not exists (select 1 from public.perfiles) then 'gerencia' else 'pendiente' end
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Auditoría (fecha + responsable de todo) -------------------

create table if not exists public.auditoria (
  id           bigserial primary key,
  tabla        text not null,
  registro_id  uuid,
  accion       text not null,
  usuario      uuid,
  fecha        timestamptz not null default now(),
  datos        jsonb
);

create or replace function public.tg_auditoria() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    insert into public.auditoria (tabla, registro_id, accion, usuario, datos)
    values (tg_table_name, old.id, tg_op, auth.uid(), to_jsonb(old));
    return old;
  else
    insert into public.auditoria (tabla, registro_id, accion, usuario, datos)
    values (tg_table_name, new.id, tg_op, auth.uid(), to_jsonb(new));
    return new;
  end if;
end $$;

create or replace function public.tg_updated() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end $$;

-- ---------- A01 · CLIENTES -------------------------------------------

create table if not exists public.clientes (
  id                    uuid primary key default gen_random_uuid(),
  razon_social          text not null,
  cuit_dni              text unique,          -- opcional para clientes solo de reparto; obligatorio para habilitar
  condicion_iva         text check (condicion_iva in ('Responsable Inscripto','Monotributista','Exento','Consumidor Final')),
  tipo_factura          text check (tipo_factura in ('A','B','E')),
  contacto_nombre       text,
  telefono              text,
  email                 text,
  direccion             text,
  localidad             text,
  provincia             text default 'Córdoba',
  ubicacion             text,                 -- coordenadas "lat,lng" para Google Maps (opcional)
  lat                   double precision,     -- ubicación calculada para ordenar rutas
  lng                   double precision,
  horarios              text,
  medio_pago_preferido  text,
  estado                text not null default 'pendiente'
                        check (estado in ('activo','pendiente','inhabilitado')),
  observaciones         text,
  created_at            timestamptz not null default now(),
  created_by            uuid default auth.uid() references public.perfiles(id),
  updated_at            timestamptz not null default now(),
  updated_by            uuid default auth.uid() references public.perfiles(id)
);

-- A01: "Cliente no validado = no facturable" / "No dar de alta clientes incompletos"
create or replace function public.tg_clientes_validar() returns trigger
language plpgsql as $$
declare faltan text[] := '{}';
begin
  new.cuit_dni := nullif(regexp_replace(coalesce(new.cuit_dni, ''), '[^0-9]', '', 'g'), '');
  if new.cuit_dni is not null and length(new.cuit_dni) not in (7, 8, 11) then
    raise exception 'CUIT/DNI inválido: debe tener 11 dígitos (CUIT) o 7-8 (DNI)';
  end if;
  -- Si cambia la dirección, la ubicación calculada deja de valer
  if tg_op = 'UPDATE'
     and (new.direccion, new.localidad, new.provincia, new.ubicacion) is distinct from (old.direccion, old.localidad, old.provincia, old.ubicacion)
     and new.lat is not distinct from old.lat then
    new.lat := null;
    new.lng := null;
  end if;
  if new.estado = 'activo' then
    if coalesce(trim(new.razon_social), '')    = '' then faltan := array_append(faltan, 'Razón social'); end if;
    if new.cuit_dni is null                         then faltan := array_append(faltan, 'CUIT/DNI'); end if;
    if new.condicion_iva is null                    then faltan := array_append(faltan, 'Condición IVA'); end if;
    if new.tipo_factura is null                     then faltan := array_append(faltan, 'Tipo de factura'); end if;
    if coalesce(trim(new.contacto_nombre), '') = '' then faltan := array_append(faltan, 'Contacto'); end if;
    if coalesce(trim(new.telefono), '')        = '' then faltan := array_append(faltan, 'Teléfono'); end if;
    if coalesce(trim(new.email), '')           = '' then faltan := array_append(faltan, 'Email'); end if;
    if coalesce(trim(new.direccion), '')       = '' then faltan := array_append(faltan, 'Dirección'); end if;
    if coalesce(trim(new.localidad), '')       = '' then faltan := array_append(faltan, 'Localidad'); end if;
    if coalesce(trim(new.horarios), '')        = '' then faltan := array_append(faltan, 'Horarios'); end if;
    if array_length(faltan, 1) > 0 then
      raise exception 'No se puede habilitar el cliente, faltan datos obligatorios (A01): %', array_to_string(faltan, ', ');
    end if;
  end if;
  return new;
end $$;

drop trigger if exists clientes_validar on public.clientes;
create trigger clientes_validar before insert or update on public.clientes
  for each row execute function public.tg_clientes_validar();
drop trigger if exists clientes_updated on public.clientes;
create trigger clientes_updated before update on public.clientes
  for each row execute function public.tg_updated();
drop trigger if exists clientes_audit on public.clientes;
create trigger clientes_audit after insert or update or delete on public.clientes
  for each row execute function public.tg_auditoria();

-- ---------- A05 · FACTURAS / CUENTAS POR COBRAR ----------------------

create table if not exists public.facturas (
  id                   uuid primary key default gen_random_uuid(),
  cliente_id           uuid not null references public.clientes(id),
  tipo_comprobante     text not null,             -- Factura A, Factura B, Nota de débito...
  numero               text not null,             -- 0001-00001234
  fecha_emision        date not null default public.hoy(),
  fecha_vencimiento    date not null,
  condicion_venta      text not null default 'Cuenta corriente'
                       check (condicion_venta in ('Contado','Cuenta corriente')),
  medio_pago_acordado  text not null,
  monto                numeric(14,2) not null check (monto > 0),
  saldo                numeric(14,2) not null default 0,
  estado               text not null default 'pendiente'
                       check (estado in ('pendiente','cobrado','anulada')),
  fecha_cobro          date,
  observaciones        text,
  created_at           timestamptz not null default now(),
  created_by           uuid default auth.uid() references public.perfiles(id),
  updated_at           timestamptz not null default now(),
  updated_by           uuid default auth.uid() references public.perfiles(id),
  unique (tipo_comprobante, numero),
  check (fecha_vencimiento >= fecha_emision)
);
create index if not exists facturas_cliente_idx on public.facturas (cliente_id);
create index if not exists facturas_venc_idx on public.facturas (estado, fecha_vencimiento);

create or replace function public.tg_facturas_reglas() returns trigger
language plpgsql security definer set search_path = public as $$
declare est text;
begin
  if tg_op = 'INSERT' then
    select estado into est from public.clientes where id = new.cliente_id;
    if est is distinct from 'activo' then
      raise exception 'El cliente no está habilitado para facturación (A01/A03). Validalo primero.';
    end if;
    new.saldo  := new.monto;
    new.estado := 'pendiente';
    new.fecha_cobro := null;
  else
    -- A05: no cambiar fechas ni medio de pago sin autorización (solo Gerencia)
    if (new.fecha_vencimiento   is distinct from old.fecha_vencimiento
     or new.medio_pago_acordado is distinct from old.medio_pago_acordado
     or new.monto               is distinct from old.monto
     or new.cliente_id          is distinct from old.cliente_id)
     and not public.es_gerencia() then
      raise exception 'Cambiar vencimiento, monto, cliente o medio de pago requiere autorización de Gerencia (A05).';
    end if;
    if new.estado = 'anulada' and old.estado <> 'anulada' and not public.es_gerencia() then
      raise exception 'Solo Gerencia puede anular comprobantes.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists facturas_reglas on public.facturas;
create trigger facturas_reglas before insert or update on public.facturas
  for each row execute function public.tg_facturas_reglas();
drop trigger if exists facturas_updated on public.facturas;
create trigger facturas_updated before update on public.facturas
  for each row execute function public.tg_updated();
drop trigger if exists facturas_audit on public.facturas;
create trigger facturas_audit after insert or update or delete on public.facturas
  for each row execute function public.tg_auditoria();

-- ---------- A05 · COBROS ---------------------------------------------

create table if not exists public.cobros (
  id            uuid primary key default gen_random_uuid(),
  factura_id    uuid not null references public.facturas(id),
  fecha         date not null default public.hoy(),
  monto         numeric(14,2) not null check (monto > 0),
  medio_pago    text not null,
  referencia    text,                         -- N° transferencia, cheque, recibo
  observaciones text,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid() references public.perfiles(id)
);
create index if not exists cobros_factura_idx on public.cobros (factura_id);

create or replace function public.tg_cobros_validar() returns trigger
language plpgsql as $$
declare f public.facturas;
begin
  select * into f from public.facturas where id = new.factura_id for update;
  if f.estado = 'anulada' then raise exception 'La factura está anulada'; end if;
  if new.monto > f.saldo then
    raise exception 'El cobro (%) supera el saldo de la factura (%). Verificá coincidencia con la factura (A05).', new.monto, f.saldo;
  end if;
  return new;
end $$;

create or replace function public.tg_cobros_recalcular() returns trigger
language plpgsql security definer set search_path = public as $$
declare fid uuid; cobrado numeric; ultima date;
begin
  if tg_op = 'DELETE' then fid := old.factura_id; else fid := new.factura_id; end if;
  select coalesce(sum(monto), 0), max(fecha) into cobrado, ultima from public.cobros where factura_id = fid;
  update public.facturas f
     set saldo       = f.monto - cobrado,
         estado      = case when f.estado = 'anulada' then 'anulada'
                            when f.monto - cobrado <= 0 then 'cobrado' else 'pendiente' end,
         fecha_cobro = case when f.monto - cobrado <= 0 then ultima else null end
   where f.id = fid;
  return null;
end $$;

drop trigger if exists cobros_validar on public.cobros;
create trigger cobros_validar before insert on public.cobros
  for each row execute function public.tg_cobros_validar();
drop trigger if exists cobros_recalcular on public.cobros;
create trigger cobros_recalcular after insert or delete on public.cobros
  for each row execute function public.tg_cobros_recalcular();
drop trigger if exists cobros_audit on public.cobros;
create trigger cobros_audit after insert or update or delete on public.cobros
  for each row execute function public.tg_auditoria();

-- ---------- A05 · GESTIONES (avisos, respuestas, escalamientos) ------

create table if not exists public.gestiones_cobranza (
  id          uuid primary key default gen_random_uuid(),
  factura_id  uuid references public.facturas(id) on delete cascade,
  cliente_id  uuid not null references public.clientes(id),
  tipo        text not null check (tipo in (
                'aviso_preventivo','aviso_vencimiento','aviso_atraso',
                'respuesta_cliente','informe_ventas','escalado_gerencia','otro')),
  nota        text,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid() references public.perfiles(id)
);
create index if not exists gestiones_factura_idx on public.gestiones_cobranza (factura_id);

-- ---------- A06 · CAJA DIARIA ----------------------------------------

create table if not exists public.cajas (
  id                uuid primary key default gen_random_uuid(),
  fecha             date not null unique default public.hoy(),
  saldo_inicial     numeric(14,2) not null default 0,     -- efectivo al abrir
  efectivo_teorico  numeric(14,2),
  efectivo_contado  numeric(14,2),
  diferencia        numeric(14,2),
  justificacion     text,
  observaciones     text,
  checklist         jsonb not null default '{}'::jsonb,
  estado            text not null default 'abierta' check (estado in ('abierta','cerrada')),
  created_at        timestamptz not null default now(),
  abierta_por       uuid default auth.uid() references public.perfiles(id),
  cerrada_por       uuid references public.perfiles(id),
  cerrada_at        timestamptz
);

create table if not exists public.movimientos_caja (
  id           uuid primary key default gen_random_uuid(),
  caja_id      uuid not null references public.cajas(id),
  tipo         text not null check (tipo in ('ingreso','egreso')),
  concepto     text not null,
  monto        numeric(14,2) not null check (monto > 0),
  medio        text not null,
  comprobante  text,
  cobro_id     uuid references public.cobros(id) on delete cascade,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid() references public.perfiles(id)
);
create index if not exists mov_caja_idx on public.movimientos_caja (caja_id);

-- Caja cerrada = no se toca (salvo que Gerencia la reabra)
create or replace function public.tg_cajas_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Las cajas no se eliminan (A06).';
  end if;
  if old.estado = 'cerrada' and not public.es_gerencia() then
    raise exception 'La caja del % está cerrada. Solo Gerencia puede reabrirla.', old.fecha;
  end if;
  return new;
end $$;

drop trigger if exists cajas_guard on public.cajas;
create trigger cajas_guard before update or delete on public.cajas
  for each row execute function public.tg_cajas_guard();
drop trigger if exists cajas_audit on public.cajas;
create trigger cajas_audit after insert or update on public.cajas
  for each row execute function public.tg_auditoria();

create or replace function public.tg_mov_guard() returns trigger
language plpgsql as $$
declare cid uuid; est text;
begin
  if tg_op = 'DELETE' then cid := old.caja_id; else cid := new.caja_id; end if;
  select estado into est from public.cajas where id = cid;
  if est = 'cerrada' then
    raise exception 'La caja de ese día está cerrada: no se pueden modificar movimientos (A06).';
  end if;
  if tg_op = 'UPDATE' and new.caja_id <> old.caja_id then
    raise exception 'No se puede mover un movimiento a otra caja.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists mov_guard on public.movimientos_caja;
create trigger mov_guard before insert or update or delete on public.movimientos_caja
  for each row execute function public.tg_mov_guard();
drop trigger if exists mov_audit on public.movimientos_caja;
create trigger mov_audit after insert or update or delete on public.movimientos_caja
  for each row execute function public.tg_auditoria();

-- Cierre de caja: valida checklist, calcula diferencia y exige justificación
create or replace function public.cerrar_caja(
  p_caja uuid, p_efectivo_contado numeric, p_checklist jsonb,
  p_justificacion text, p_observaciones text
) returns public.cajas
language plpgsql as $$
declare
  c public.cajas;
  teorico numeric;
  dif numeric;
  item text;
  requeridos text[] := array['ingresos','egresos','comprobantes','banco','cheques','facturas','cobros','pagos','flujo'];
begin
  if not public.puede_editar() then raise exception 'No tenés permiso para cerrar la caja.'; end if;
  select * into c from public.cajas where id = p_caja for update;
  if c.id is null then raise exception 'Caja inexistente'; end if;
  if c.estado = 'cerrada' then raise exception 'La caja ya está cerrada.'; end if;
  if p_efectivo_contado is null then raise exception 'Cargá el efectivo contado.'; end if;

  foreach item in array requeridos loop
    if coalesce((p_checklist->>item)::boolean, false) = false then
      raise exception 'Checklist de cierre incompleto (A06): falta "%".', item;
    end if;
  end loop;

  select c.saldo_inicial + coalesce(sum(case when tipo = 'ingreso' then monto else -monto end), 0)
    into teorico
    from public.movimientos_caja
   where caja_id = p_caja and medio = 'Efectivo';

  dif := p_efectivo_contado - teorico;
  if dif <> 0 and coalesce(trim(p_justificacion), '') = '' then
    raise exception 'Hay una diferencia de $ %. Tenés que registrarla y justificarla (A06).', dif;
  end if;

  update public.cajas
     set estado = 'cerrada',
         efectivo_teorico = teorico,
         efectivo_contado = p_efectivo_contado,
         diferencia = dif,
         justificacion = nullif(trim(coalesce(p_justificacion, '')), ''),
         observaciones = nullif(trim(coalesce(p_observaciones, '')), ''),
         checklist = checklist || p_checklist,
         cerrada_por = auth.uid(),
         cerrada_at = now()
   where id = p_caja
  returning * into c;
  return c;
end $$;

create or replace function public.reabrir_caja(p_caja uuid, p_motivo text)
returns public.cajas language plpgsql as $$
declare c public.cajas;
begin
  if not public.es_gerencia() then raise exception 'Solo Gerencia puede reabrir una caja.'; end if;
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Indicá el motivo de la reapertura.'; end if;
  update public.cajas
     set estado = 'abierta',
         observaciones = concat_ws(E'\n', observaciones, 'Reabierta por Gerencia: ' || p_motivo),
         cerrada_por = null, cerrada_at = null
   where id = p_caja
  returning * into c;
  return c;
end $$;

-- ---------- Vista: saldos por cliente --------------------------------

drop view if exists public.v_clientes_saldos;
create view public.v_clientes_saldos with (security_invoker = true) as
select c.*,
       coalesce(sum(f.saldo), 0)                                                    as saldo,
       coalesce(sum(f.saldo) filter (where f.fecha_vencimiento < public.hoy()), 0) as vencido,
       count(f.id)                                                                  as facturas_pendientes
  from public.clientes c
  left join public.facturas f on f.cliente_id = c.id and f.estado = 'pendiente'
 group by c.id;

-- ---------- Seguridad (RLS) ------------------------------------------

alter table public.perfiles           enable row level security;
alter table public.clientes           enable row level security;
alter table public.facturas           enable row level security;
alter table public.cobros             enable row level security;
alter table public.gestiones_cobranza enable row level security;
alter table public.cajas              enable row level security;
alter table public.movimientos_caja   enable row level security;
alter table public.auditoria          enable row level security;

-- perfiles
drop policy if exists perfiles_sel on public.perfiles;
create policy perfiles_sel on public.perfiles for select to authenticated using (public.tiene_acceso() or id = auth.uid());
drop policy if exists perfiles_upd on public.perfiles;
create policy perfiles_upd on public.perfiles for update to authenticated
  using (public.es_gerencia()) with check (public.es_gerencia());

-- clientes (todos ven; Administración/Gerencia cargan; no se borran: se inhabilitan)
drop policy if exists clientes_sel on public.clientes;
create policy clientes_sel on public.clientes for select to authenticated using (public.tiene_acceso());
drop policy if exists clientes_ins on public.clientes;
create policy clientes_ins on public.clientes for insert to authenticated with check (public.puede_editar());
drop policy if exists clientes_upd on public.clientes;
create policy clientes_upd on public.clientes for update to authenticated
  using (public.puede_editar()) with check (public.puede_editar());

-- facturas
drop policy if exists facturas_sel on public.facturas;
create policy facturas_sel on public.facturas for select to authenticated using (public.tiene_acceso());
drop policy if exists facturas_ins on public.facturas;
create policy facturas_ins on public.facturas for insert to authenticated with check (public.puede_editar());
drop policy if exists facturas_upd on public.facturas;
create policy facturas_upd on public.facturas for update to authenticated
  using (public.puede_editar()) with check (public.puede_editar());

-- cobros (borrar = solo Gerencia, para corregir errores)
drop policy if exists cobros_sel on public.cobros;
create policy cobros_sel on public.cobros for select to authenticated using (public.tiene_acceso());
drop policy if exists cobros_ins on public.cobros;
create policy cobros_ins on public.cobros for insert to authenticated with check (public.puede_editar());
drop policy if exists cobros_del on public.cobros;
create policy cobros_del on public.cobros for delete to authenticated using (public.es_gerencia());

-- gestiones (cualquiera puede documentar, p.ej. Ventas una respuesta del cliente)
drop policy if exists gestiones_sel on public.gestiones_cobranza;
create policy gestiones_sel on public.gestiones_cobranza for select to authenticated using (public.tiene_acceso());
drop policy if exists gestiones_ins on public.gestiones_cobranza;
create policy gestiones_ins on public.gestiones_cobranza for insert to authenticated with check (public.tiene_acceso());

-- caja (solo Administración y Gerencia)
drop policy if exists cajas_all on public.cajas;
create policy cajas_all on public.cajas for all to authenticated
  using (public.puede_editar()) with check (public.puede_editar());
drop policy if exists mov_all on public.movimientos_caja;
create policy mov_all on public.movimientos_caja for all to authenticated
  using (public.puede_editar()) with check (public.puede_editar());

-- auditoría (solo Gerencia la consulta)
drop policy if exists auditoria_sel on public.auditoria;
create policy auditoria_sel on public.auditoria for select to authenticated using (public.es_gerencia());

-- =====================================================================
--  HOJA DE RUTA (repartos con Google Maps)
-- =====================================================================

create table if not exists public.hojas_ruta (
  id               uuid primary key default gen_random_uuid(),
  fecha            date not null default public.hoy(),
  nombre           text,                       -- ej: "Reparto zona sur"
  chofer           text,
  chofer_telefono  text,
  origen           text not null,              -- depósito / punto de salida
  volver_origen    boolean not null default true,
  estado           text not null default 'borrador'
                   check (estado in ('borrador','en_curso','completada')),
  observaciones    text,
  created_at       timestamptz not null default now(),
  created_by       uuid default auth.uid() references public.perfiles(id),
  updated_at       timestamptz not null default now(),
  updated_by       uuid default auth.uid() references public.perfiles(id)
);

create table if not exists public.hoja_ruta_paradas (
  id             uuid primary key default gen_random_uuid(),
  hoja_id        uuid not null references public.hojas_ruta(id) on delete cascade,
  orden          int not null,
  cliente_id     uuid references public.clientes(id),
  destino        text not null,                -- nombre del cliente o lugar
  direccion      text not null,                -- dirección o "lat,lng" que va a Maps
  telefono       text,
  que_lleva      text,
  bultos         int check (bultos is null or bultos >= 0),
  observaciones  text,
  entregado      boolean not null default false,
  entregado_at   timestamptz,
  nota_entrega   text,
  lat            double precision,
  lng            double precision
);
create index if not exists paradas_hoja_idx on public.hoja_ruta_paradas (hoja_id, orden);
-- Monto de factura por parada (migración 09): las notas de crédito restan
alter table public.hoja_ruta_paradas add column if not exists monto_factura numeric(14,2);
alter table public.hoja_ruta_paradas add column if not exists comprobantes jsonb not null default '[]'::jsonb;

drop trigger if exists hojas_updated on public.hojas_ruta;
create trigger hojas_updated before update on public.hojas_ruta
  for each row execute function public.tg_updated();
drop trigger if exists hojas_audit on public.hojas_ruta;
create trigger hojas_audit after insert or update or delete on public.hojas_ruta
  for each row execute function public.tg_auditoria();

-- Guarda la hoja y sus paradas en una sola operación
create or replace function public.guardar_hoja_ruta(p_hoja jsonb, p_paradas jsonb)
returns uuid language plpgsql as $$
declare hid uuid; p jsonb; i int := 0;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso para armar hojas de ruta.'; end if;
  if coalesce(trim(p_hoja->>'origen'), '') = '' then raise exception 'Indicá el punto de salida.'; end if;
  if jsonb_array_length(coalesce(p_paradas, '[]'::jsonb)) = 0 then raise exception 'Agregá al menos una parada.'; end if;

  hid := nullif(p_hoja->>'id', '')::uuid;
  if hid is null then
    insert into public.hojas_ruta (fecha, nombre, chofer, chofer_telefono, origen, volver_origen, observaciones)
    values (coalesce((p_hoja->>'fecha')::date, public.hoy()), p_hoja->>'nombre', p_hoja->>'chofer', p_hoja->>'chofer_telefono',
            p_hoja->>'origen', coalesce((p_hoja->>'volver_origen')::boolean, true), p_hoja->>'observaciones')
    returning id into hid;
  else
    update public.hojas_ruta
       set fecha = coalesce((p_hoja->>'fecha')::date, fecha), nombre = p_hoja->>'nombre', chofer = p_hoja->>'chofer',
           chofer_telefono = p_hoja->>'chofer_telefono', origen = p_hoja->>'origen',
           volver_origen = coalesce((p_hoja->>'volver_origen')::boolean, true), observaciones = p_hoja->>'observaciones'
     where id = hid;
    if not found then raise exception 'Hoja de ruta inexistente'; end if;
    delete from public.hoja_ruta_paradas where hoja_id = hid;
  end if;

  for p in select * from jsonb_array_elements(p_paradas) loop
    i := i + 1;
    if coalesce(trim(p->>'direccion'), '') = '' then
      raise exception 'La parada % (%) no tiene dirección.', i, p->>'destino';
    end if;
    insert into public.hoja_ruta_paradas
      (hoja_id, orden, cliente_id, destino, direccion, telefono, que_lleva, bultos, observaciones, entregado, entregado_at, nota_entrega, lat, lng,
       monto_factura, comprobantes)
    values (hid, i, nullif(p->>'cliente_id', '')::uuid, p->>'destino', p->>'direccion', p->>'telefono', p->>'que_lleva',
            nullif(p->>'bultos', '')::int, p->>'observaciones', coalesce((p->>'entregado')::boolean, false),
            nullif(p->>'entregado_at', '')::timestamptz, p->>'nota_entrega',
            nullif(p->>'lat', '')::double precision, nullif(p->>'lng', '')::double precision,
            nullif(p->>'monto_factura', '')::numeric,
            case when jsonb_typeof(p->'comprobantes') = 'array' then p->'comprobantes' else '[]'::jsonb end);
  end loop;
  return hid;
end $$;

-- Al marcar entregas se actualiza el estado de la hoja
create or replace function public.tg_paradas_estado() returns trigger
language plpgsql security definer set search_path = public as $$
declare hid uuid; tot int; ok int;
begin
  if tg_op = 'DELETE' then hid := old.hoja_id; else hid := new.hoja_id; end if;
  if tg_op = 'UPDATE' and new.entregado and not old.entregado then
    update public.hoja_ruta_paradas set entregado_at = coalesce(entregado_at, now()) where id = new.id;
  end if;
  select count(*), count(*) filter (where entregado) into tot, ok from public.hoja_ruta_paradas where hoja_id = hid;
  update public.hojas_ruta
     set estado = case when tot > 0 and ok = tot then 'completada' when ok > 0 then 'en_curso' else estado end
   where id = hid and estado is distinct from (case when tot > 0 and ok = tot then 'completada' when ok > 0 then 'en_curso' else estado end);
  return null;
end $$;

drop trigger if exists paradas_estado on public.hoja_ruta_paradas;
create trigger paradas_estado after update of entregado on public.hoja_ruta_paradas
  for each row execute function public.tg_paradas_estado();

alter table public.hojas_ruta        enable row level security;
alter table public.hoja_ruta_paradas enable row level security;

drop policy if exists hojas_sel on public.hojas_ruta;
create policy hojas_sel on public.hojas_ruta for select to authenticated using (public.tiene_acceso());
drop policy if exists hojas_ins on public.hojas_ruta;
create policy hojas_ins on public.hojas_ruta for insert to authenticated with check (public.puede_editar());
drop policy if exists hojas_upd on public.hojas_ruta;
create policy hojas_upd on public.hojas_ruta for update to authenticated using (public.puede_editar()) with check (public.puede_editar());
drop policy if exists hojas_del on public.hojas_ruta;
create policy hojas_del on public.hojas_ruta for delete to authenticated using (public.puede_editar());

drop policy if exists paradas_sel on public.hoja_ruta_paradas;
create policy paradas_sel on public.hoja_ruta_paradas for select to authenticated using (public.tiene_acceso());
drop policy if exists paradas_ins on public.hoja_ruta_paradas;
create policy paradas_ins on public.hoja_ruta_paradas for insert to authenticated with check (public.puede_editar());
drop policy if exists paradas_del on public.hoja_ruta_paradas;
create policy paradas_del on public.hoja_ruta_paradas for delete to authenticated using (public.puede_editar());
-- Cualquier usuario (ej. el chofer) puede marcar entregas
drop policy if exists paradas_upd on public.hoja_ruta_paradas;
create policy paradas_upd on public.hoja_ruta_paradas for update to authenticated using (public.tiene_acceso()) with check (public.tiene_acceso());

-- =====================================================================
--  A08 · FLUJO DE FONDOS (proyección de ingresos y egresos)
--  Administración carga y ejecuta; Gerencia/Finanzas autoriza los egresos.
-- =====================================================================

create table if not exists public.flujo_movimientos (
  id               uuid primary key default gen_random_uuid(),
  tipo             text not null check (tipo in ('ingreso','egreso')),
  fecha            date not null,                 -- fecha prevista de cobro/pago
  concepto         text not null,
  monto            numeric(14,2) not null check (monto > 0),
  categoria        text not null,
  contraparte      text,                          -- proveedor, cliente, organismo
  medio            text,                          -- transferencia, cheque, e-cheq...
  estado           text not null default 'pendiente'
                   check (estado in ('pendiente','autorizado','rechazado','pagado')),
  serie_id         uuid,                          -- movimientos repetidos (sueldos, alquiler...)
  observaciones    text,
  autorizado_por   uuid references public.perfiles(id),
  autorizado_at    timestamptz,
  motivo_rechazo   text,
  pagado_por       uuid references public.perfiles(id),
  pagado_at        timestamptz,
  fecha_real       date,                          -- cuándo se pagó/cobró de verdad
  comprobante      text,                          -- orden de pago, n° transferencia, recibo
  created_at       timestamptz not null default now(),
  created_by       uuid default auth.uid() references public.perfiles(id),
  updated_at       timestamptz not null default now(),
  updated_by       uuid default auth.uid() references public.perfiles(id)
);
create index if not exists flujo_fecha_idx on public.flujo_movimientos (estado, fecha);
create index if not exists flujo_serie_idx on public.flujo_movimientos (serie_id);

-- Saldo disponible real (caja + bancos) informado a una fecha: punto de partida de la proyección
create table if not exists public.flujo_saldos (
  id          uuid primary key default gen_random_uuid(),
  fecha       date not null default public.hoy(),
  monto       numeric(14,2) not null,
  nota        text,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid() references public.perfiles(id)
);

-- Reglas A08: sin autorización explícita no se paga; no cambiar montos/fechas/medios autorizados
create or replace function public.tg_flujo_reglas() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.estado in ('autorizado','rechazado') and new.tipo = 'egreso' and not public.es_gerencia() then
      raise exception 'Solo Gerencia/Finanzas puede autorizar o rechazar pagos (A08).';
    end if;
    if new.estado = 'pagado' and new.tipo = 'egreso' then
      raise exception 'Un pago no se carga como pagado: primero se registra, se autoriza y después se ejecuta (A08).';
    end if;
    if new.estado = 'autorizado' then new.autorizado_por := auth.uid(); new.autorizado_at := now(); end if;
    if new.estado = 'pagado' then
      new.pagado_por := auth.uid(); new.pagado_at := now(); new.fecha_real := coalesce(new.fecha_real, public.hoy());
    end if;
    return new;
  end if;

  -- UPDATE
  if old.estado = 'pagado' and not public.es_gerencia() then
    raise exception 'Este movimiento ya está registrado como pagado/cobrado. Solo Gerencia puede modificarlo.';
  end if;

  if new.estado is distinct from old.estado then
    if new.tipo = 'egreso' and new.estado in ('autorizado','rechazado') then
      if not public.es_gerencia() then raise exception 'Solo Gerencia/Finanzas puede autorizar o rechazar pagos (A08).'; end if;
      new.autorizado_por := auth.uid();
      new.autorizado_at := now();
      if new.estado = 'rechazado' and coalesce(trim(new.motivo_rechazo), '') = '' then
        raise exception 'Indicá el motivo del rechazo.';
      end if;
    end if;
    if new.tipo = 'egreso' and new.estado = 'pagado' and old.estado <> 'autorizado' then
      raise exception 'Sin autorización explícita no se paga (A08). Pedí la autorización a Gerencia.';
    end if;
    if new.estado = 'pagado' then
      new.pagado_por := auth.uid();
      new.pagado_at := now();
      new.fecha_real := coalesce(new.fecha_real, public.hoy());
    end if;
    if new.estado = 'pendiente' then
      new.autorizado_por := null; new.autorizado_at := null; new.motivo_rechazo := null;
      new.pagado_por := null; new.pagado_at := null; new.fecha_real := null;
    end if;
  end if;

  -- Cambiar monto, fecha o medio de un pago ya autorizado: vuelve a pedir autorización
  if old.estado = 'autorizado' and new.estado = 'autorizado' and old.tipo = 'egreso'
     and (new.monto, new.fecha, coalesce(new.medio, '')) is distinct from (old.monto, old.fecha, coalesce(old.medio, ''))
     and not public.es_gerencia() then
    new.estado := 'pendiente';
    new.autorizado_por := null;
    new.autorizado_at := null;
  end if;
  return new;
end $$;

drop trigger if exists flujo_reglas on public.flujo_movimientos;
create trigger flujo_reglas before insert or update on public.flujo_movimientos
  for each row execute function public.tg_flujo_reglas();
drop trigger if exists flujo_updated on public.flujo_movimientos;
create trigger flujo_updated before update on public.flujo_movimientos
  for each row execute function public.tg_updated();
drop trigger if exists flujo_audit on public.flujo_movimientos;
create trigger flujo_audit after insert or update or delete on public.flujo_movimientos
  for each row execute function public.tg_auditoria();

create or replace function public.tg_flujo_borrar() returns trigger
language plpgsql as $$
begin
  if old.estado in ('autorizado','pagado') and not public.es_gerencia() then
    raise exception 'Un movimiento autorizado o pagado solo lo puede eliminar Gerencia.';
  end if;
  return old;
end $$;
drop trigger if exists flujo_borrar on public.flujo_movimientos;
create trigger flujo_borrar before delete on public.flujo_movimientos
  for each row execute function public.tg_flujo_borrar();

alter table public.flujo_movimientos enable row level security;
alter table public.flujo_saldos      enable row level security;

drop policy if exists flujo_all on public.flujo_movimientos;
create policy flujo_all on public.flujo_movimientos for all to authenticated
  using (public.puede_editar()) with check (public.puede_editar());
drop policy if exists flujo_saldos_sel on public.flujo_saldos;
create policy flujo_saldos_sel on public.flujo_saldos for select to authenticated using (public.puede_editar());
drop policy if exists flujo_saldos_ins on public.flujo_saldos;
create policy flujo_saldos_ins on public.flujo_saldos for insert to authenticated with check (public.puede_editar());

-- =====================================================================
--  PERSONAL Y NOVEDADES (legajos, vacaciones, licencias, calendario)
--  Solo Administración y Gerencia. Gerencia aprueba o rechaza.
-- =====================================================================

create table if not exists public.empleados (
  id                      uuid primary key default gen_random_uuid(),
  nombre                  text not null,
  apellido                text not null,
  cuil                    text unique,
  puesto                  text,
  area                    text,
  fecha_ingreso           date not null,
  fecha_nacimiento        date,
  telefono                text,
  email                   text,
  emergencia_nombre       text,
  emergencia_telefono     text,
  emergencia_vinculo      text,
  dias_vacaciones_manual  int check (dias_vacaciones_manual is null or dias_vacaciones_manual between 0 and 60),
  activo                  boolean not null default true,
  fecha_baja              date,
  observaciones           text,
  created_at              timestamptz not null default now(),
  created_by              uuid default auth.uid() references public.perfiles(id),
  updated_at              timestamptz not null default now(),
  updated_by              uuid default auth.uid() references public.perfiles(id)
);

create or replace function public.tg_empleados_validar() returns trigger
language plpgsql as $$
begin
  new.cuil := nullif(regexp_replace(coalesce(new.cuil, ''), '[^0-9]', '', 'g'), '');
  if new.cuil is not null and length(new.cuil) <> 11 then raise exception 'El CUIL debe tener 11 dígitos.'; end if;
  if new.fecha_nacimiento is not null and new.fecha_nacimiento > new.fecha_ingreso then
    raise exception 'La fecha de nacimiento no puede ser posterior al ingreso.';
  end if;
  if not new.activo and new.fecha_baja is null then new.fecha_baja := public.hoy(); end if;
  if new.activo then new.fecha_baja := null; end if;
  return new;
end $$;
drop trigger if exists empleados_validar on public.empleados;
create trigger empleados_validar before insert or update on public.empleados
  for each row execute function public.tg_empleados_validar();
drop trigger if exists empleados_updated on public.empleados;
create trigger empleados_updated before update on public.empleados
  for each row execute function public.tg_updated();
drop trigger if exists empleados_audit on public.empleados;
create trigger empleados_audit after insert or update or delete on public.empleados
  for each row execute function public.tg_auditoria();

create table if not exists public.novedades (
  id              uuid primary key default gen_random_uuid(),
  empleado_id     uuid references public.empleados(id) on delete cascade,   -- null = para todos (reunión general, feriado propio)
  tipo            text not null check (tipo in ('vacaciones','licencia','permiso','reunion','feriado','otro')),
  titulo          text,
  fecha_desde     date not null,
  fecha_hasta     date not null,
  hora            text,                                                    -- para reuniones / permisos por horas
  estado          text not null default 'pendiente' check (estado in ('pendiente','aprobado','rechazado')),
  observaciones   text,
  motivo_rechazo  text,
  aprobado_por    uuid references public.perfiles(id),
  aprobado_at     timestamptz,
  created_at      timestamptz not null default now(),
  created_by      uuid default auth.uid() references public.perfiles(id),
  updated_at      timestamptz not null default now(),
  updated_by      uuid default auth.uid() references public.perfiles(id),
  check (fecha_hasta >= fecha_desde),
  check (empleado_id is not null or tipo in ('reunion','feriado','otro'))
);
create index if not exists novedades_fechas_idx on public.novedades (fecha_desde, fecha_hasta);
create index if not exists novedades_emp_idx on public.novedades (empleado_id);

create or replace function public.tg_novedades_reglas() returns trigger
language plpgsql as $$
begin
  -- Reuniones y feriados propios no requieren aprobación
  if tg_op = 'INSERT' and new.tipo in ('reunion','feriado') then
    new.estado := 'aprobado'; new.aprobado_por := auth.uid(); new.aprobado_at := now();
    return new;
  end if;
  if tg_op = 'INSERT' and new.estado <> 'pendiente' and not public.es_gerencia() then
    raise exception 'Las novedades se cargan pendientes: las aprueba Gerencia.';
  end if;
  if tg_op = 'UPDATE' then
    if new.estado is distinct from old.estado then
      if new.estado in ('aprobado','rechazado') and new.tipo not in ('reunion','feriado') and not public.es_gerencia() then
        raise exception 'Solo Gerencia puede aprobar o rechazar novedades.';
      end if;
      if new.estado = 'rechazado' and coalesce(trim(new.motivo_rechazo), '') = '' then
        raise exception 'Indicá el motivo del rechazo.';
      end if;
      new.aprobado_por := case when new.estado = 'pendiente' then null else auth.uid() end;
      new.aprobado_at := case when new.estado = 'pendiente' then null else now() end;
    elsif old.estado = 'aprobado' and old.tipo not in ('reunion','feriado') and not public.es_gerencia()
      and (new.fecha_desde, new.fecha_hasta, new.empleado_id, new.tipo) is distinct from (old.fecha_desde, old.fecha_hasta, old.empleado_id, old.tipo) then
      -- Cambiar fechas de algo aprobado: vuelve a aprobación
      new.estado := 'pendiente'; new.aprobado_por := null; new.aprobado_at := null;
    end if;
  end if;
  if new.estado = 'aprobado' and new.estado is distinct from (case when tg_op = 'UPDATE' then old.estado else null end) and new.aprobado_at is null then
    new.aprobado_por := auth.uid(); new.aprobado_at := now();
  end if;
  return new;
end $$;
drop trigger if exists novedades_reglas on public.novedades;
create trigger novedades_reglas before insert or update on public.novedades
  for each row execute function public.tg_novedades_reglas();
drop trigger if exists novedades_updated on public.novedades;
create trigger novedades_updated before update on public.novedades
  for each row execute function public.tg_updated();
drop trigger if exists novedades_audit on public.novedades;
create trigger novedades_audit after insert or update or delete on public.novedades
  for each row execute function public.tg_auditoria();

alter table public.empleados enable row level security;
alter table public.novedades enable row level security;
drop policy if exists empleados_all on public.empleados;
create policy empleados_all on public.empleados for all to authenticated
  using (public.puede_editar()) with check (public.puede_editar());
drop policy if exists empleados_del on public.empleados;
drop policy if exists novedades_all on public.novedades;
create policy novedades_all on public.novedades for all to authenticated
  using (public.puede_editar()) with check (public.puede_editar());

-- =====================================================================
--  TESORERÍA (libro único de movimientos)
--  Caja, Bancos, Cheques y Flujo de fondos leen los mismos registros:
--  cada cobro, pago o transferencia se carga una sola vez.
-- =====================================================================

-- ---------- Cuentas ----------
create table if not exists public.tes_cuentas (
  id      uuid primary key default gen_random_uuid(),
  codigo  text not null unique,                 -- efectivo, galicia, macro
  nombre  text not null,
  tipo    text not null check (tipo in ('efectivo','banco')),
  orden   int not null default 0,
  activa  boolean not null default true
);
insert into public.tes_cuentas (codigo, nombre, tipo, orden) values
  ('efectivo', 'Caja en efectivo', 'efectivo', 1),
  ('galicia',  'Banco Galicia',    'banco',    2),
  ('macro',    'Banco Macro',      'banco',    3)
on conflict (codigo) do nothing;

-- ---------- Categorías y rubros (configurables) ----------
create table if not exists public.tes_categorias (
  id                     uuid primary key default gen_random_uuid(),
  tipo                   text not null check (tipo in ('ingreso','egreso')),
  rubro                  text not null,
  nombre                 text not null,
  clave                  text unique,             -- categorías que usa el sistema (no borrar)
  requiere_autorizacion  boolean not null default true,  -- egresos: ¿necesita OK de Gerencia antes de pagar?
  orden                  int not null default 0,
  activa                 boolean not null default true,
  unique (tipo, rubro, nombre)
);

insert into public.tes_categorias (tipo, rubro, nombre, clave, requiere_autorizacion, orden) values
  ('ingreso','Ventas','Cobranza de clientes','cobranza',false,10),
  ('ingreso','Ventas','Ventas contado',null,false,11),
  ('ingreso','Ventas','Venta de máquinas',null,false,12),
  ('ingreso','Ventas','Alquiler de máquinas',null,false,13),
  ('ingreso','Ventas','Venta de repuestos',null,false,14),
  ('ingreso','Ventas','Servicio técnico / reparaciones',null,false,15),
  ('ingreso','Otros ingresos','Préstamos recibidos',null,false,20),
  ('ingreso','Otros ingresos','Aportes de socios',null,false,21),
  ('ingreso','Otros ingresos','Intereses ganados',null,false,22),
  ('ingreso','Otros ingresos','Reintegros y devoluciones',null,false,23),
  ('ingreso','Otros ingresos','Otros ingresos',null,false,29),
  ('ingreso','Ajustes','Sobrante de caja','sobrante',false,90),
  ('egreso','Proveedores','Mercadería y repuestos',null,true,10),
  ('egreso','Proveedores','Insumos',null,true,11),
  ('egreso','Proveedores','Máquinas y equipos',null,true,12),
  ('egreso','Personal','Sueldos',null,true,20),
  ('egreso','Personal','Cargas sociales',null,true,21),
  ('egreso','Personal','Adelantos de sueldo',null,true,22),
  ('egreso','Impuestos','IVA',null,true,30),
  ('egreso','Impuestos','Ingresos Brutos',null,true,31),
  ('egreso','Impuestos','Ganancias',null,true,32),
  ('egreso','Impuestos','Tasas municipales',null,true,33),
  ('egreso','Impuestos','Impuesto a los débitos y créditos','imp_debcred',false,34),
  ('egreso','Servicios','Energía',null,true,40),
  ('egreso','Servicios','Internet y telefonía',null,true,41),
  ('egreso','Servicios','Agua y gas',null,true,42),
  ('egreso','Servicios','Seguros',null,true,43),
  ('egreso','Estructura','Alquiler',null,true,50),
  ('egreso','Estructura','Mantenimiento edificio',null,true,51),
  ('egreso','Logística','Fletes y envíos',null,true,60),
  ('egreso','Logística','Combustible',null,false,61),
  ('egreso','Logística','Peajes y estacionamiento',null,false,62),
  ('egreso','Bancos y financiación','Comisiones y gastos bancarios','comisiones',false,70),
  ('egreso','Bancos y financiación','Cuotas de préstamos y leasing',null,true,71),
  ('egreso','Bancos y financiación','Intereses pagados',null,false,72),
  ('egreso','Bancos y financiación','Cheque rechazado','cheque_rechazado',false,73),
  ('egreso','Gastos generales','Librería y oficina',null,false,80),
  ('egreso','Gastos generales','Limpieza',null,false,81),
  ('egreso','Gastos generales','Viáticos',null,false,82),
  ('egreso','Gastos generales','Gastos menores',null,false,83),
  ('egreso','Socios','Retiros de socios',null,true,85),
  ('egreso','Ajustes','Faltante de caja','faltante',false,90)
on conflict do nothing;

-- ---------- Cheques (recibidos y emitidos, físicos y e-cheq) ----------
create table if not exists public.tes_cheques (
  id               uuid primary key default gen_random_uuid(),
  sentido          text not null check (sentido in ('recibido','emitido')),
  formato          text not null check (formato in ('fisico','echeq')),
  numero           text not null,
  banco            text,                         -- banco del cheque
  contraparte      text not null,                -- cliente (recibido) o proveedor (emitido)
  cuit             text,
  cliente_id       uuid references public.clientes(id),
  importe          numeric(14,2) not null check (importe > 0),
  fecha_emision    date,
  fecha_pago       date not null,                -- fecha de cobro / débito prevista (la del cheque)
  cuenta_id        uuid references public.tes_cuentas(id),  -- recibido: donde se deposita · emitido: de donde se debita
  estado           text not null check (estado in ('en_cartera','depositado','acreditado','endosado','rechazado','anulado','emitido','debitado')),
  fecha_deposito   date,
  fecha_efectiva   date,                         -- acreditación o débito real
  endosado_a       text,
  motivo           text,
  observaciones    text,
  cobro_id         uuid references public.cobros(id) on delete set null,
  created_at       timestamptz not null default now(),
  created_by       uuid default auth.uid() references public.perfiles(id),
  updated_at       timestamptz not null default now(),
  updated_by       uuid default auth.uid() references public.perfiles(id),
  check ((sentido = 'recibido' and estado in ('en_cartera','depositado','acreditado','endosado','rechazado','anulado'))
      or (sentido = 'emitido'  and estado in ('emitido','debitado','rechazado','anulado'))),
  check (sentido = 'recibido' or cuenta_id is not null)
);
create unique index if not exists tes_cheques_numero_uq on public.tes_cheques (sentido, coalesce(banco, ''), numero) where estado <> 'anulado';
create index if not exists tes_cheques_fecha_idx on public.tes_cheques (estado, fecha_pago);

-- ---------- Movimientos (el libro único) ----------
create table if not exists public.tes_movimientos (
  id                uuid primary key default gen_random_uuid(),
  fecha             date not null default public.hoy(),           -- fecha de la operación
  tipo              text not null check (tipo in ('ingreso','egreso','transferencia')),
  sentido           text not null check (sentido in ('entrada','salida')),
  categoria_id      uuid references public.tes_categorias(id),
  concepto          text not null,
  contraparte       text,
  medio             text not null check (medio in ('efectivo','transferencia','deposito','cheque','echeq','debito_automatico','tarjeta','endoso','otro')),
  cuenta_id         uuid references public.tes_cuentas(id),
  transferencia_id  uuid,                                          -- une las dos patas de una transferencia propia
  importe           numeric(14,2) not null check (importe > 0),
  fecha_prevista    date not null,                                 -- cuándo se espera cobrar / pagar
  fecha_efectiva    date,                                          -- cuándo se cobró / pagó de verdad
  estado            text not null default 'pendiente' check (estado in ('pendiente','autorizado','realizado','anulado')),
  comprobante       text,
  observaciones     text,
  cheque_id         uuid references public.tes_cheques(id),
  cobro_id          uuid references public.cobros(id) on delete set null,
  factura_id        uuid references public.facturas(id),
  serie_id          uuid,
  conciliado        boolean not null default false,
  extracto_id       uuid,
  autorizado_por    uuid references public.perfiles(id),
  autorizado_at     timestamptz,
  realizado_por     uuid references public.perfiles(id),
  realizado_at      timestamptz,
  anulado_por       uuid references public.perfiles(id),
  anulado_at        timestamptz,
  motivo_anulacion  text,
  created_at        timestamptz not null default now(),
  created_by        uuid default auth.uid() references public.perfiles(id),
  updated_at        timestamptz not null default now(),
  updated_by        uuid default auth.uid() references public.perfiles(id),
  check ((tipo = 'ingreso' and sentido = 'entrada') or (tipo = 'egreso' and sentido = 'salida') or tipo = 'transferencia'),
  check (tipo = 'transferencia' or categoria_id is not null),
  check (cuenta_id is not null or medio = 'endoso'),
  check (estado <> 'realizado' or fecha_efectiva is not null)
);
create index if not exists tes_mov_cuenta_idx on public.tes_movimientos (cuenta_id, estado, fecha_efectiva);
create index if not exists tes_mov_prev_idx on public.tes_movimientos (estado, fecha_prevista);
create index if not exists tes_mov_cheque_idx on public.tes_movimientos (cheque_id);
create index if not exists tes_mov_transf_idx on public.tes_movimientos (transferencia_id);

-- ---------- Extractos bancarios (para conciliar) ----------
create table if not exists public.tes_extractos (
  id             uuid primary key default gen_random_uuid(),
  cuenta_id      uuid not null references public.tes_cuentas(id),
  fecha          date not null,
  descripcion    text not null,
  referencia     text,
  importe        numeric(14,2) not null check (importe <> 0),   -- + crédito · − débito
  saldo          numeric(14,2),
  huella         text not null,                                 -- evita importar dos veces la misma línea
  lote           text,
  estado         text not null default 'pendiente' check (estado in ('pendiente','conciliado','ignorado')),
  movimiento_id  uuid references public.tes_movimientos(id) on delete set null,
  nota           text,
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid() references public.perfiles(id),
  unique (cuenta_id, huella)
);
do $$ begin
  alter table public.tes_movimientos add constraint tes_mov_extracto_fk foreign key (extracto_id) references public.tes_extractos(id) on delete set null;
exception when duplicate_object then null; end $$;

-- ---------- Jornadas: apertura y cierre diario ----------
create table if not exists public.tes_jornadas (
  id             uuid primary key default gen_random_uuid(),
  fecha          date not null unique,
  estado         text not null default 'abierta' check (estado in ('abierta','cerrada')),
  checklist      jsonb not null default '{}'::jsonb,
  observaciones  text,
  abierta_por    uuid default auth.uid() references public.perfiles(id),
  abierta_at     timestamptz not null default now(),
  cerrada_por    uuid references public.perfiles(id),
  cerrada_at     timestamptz
);
create table if not exists public.tes_jornada_saldos (
  id              uuid primary key default gen_random_uuid(),
  jornada_id      uuid not null references public.tes_jornadas(id) on delete cascade,
  cuenta_id       uuid not null references public.tes_cuentas(id),
  saldo_sistema   numeric(14,2),            -- lo que decía el sistema al abrir
  saldo_inicial   numeric(14,2) not null,   -- lo que se contó / verificó al abrir
  saldo_esperado  numeric(14,2),
  saldo_real      numeric(14,2),
  diferencia      numeric(14,2),
  justificacion   text,
  unique (jornada_id, cuenta_id)
);
create table if not exists public.tes_jornada_eventos (
  id          bigserial primary key,
  jornada_id  uuid not null references public.tes_jornadas(id) on delete cascade,
  accion      text not null,                -- apertura, cierre, reapertura
  motivo      text,
  datos       jsonb,
  usuario     uuid default auth.uid() references public.perfiles(id),
  fecha       timestamptz not null default now()
);

-- =====================================================================
--  Reglas
-- =====================================================================

-- ¿Ese día está cerrado?
create or replace function public.tes_dia_cerrado(p_fecha date) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.tes_jornadas where fecha = p_fecha and estado = 'cerrada')
$$;

create or replace function public.tg_tes_mov_reglas() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cat public.tes_categorias;
  bypass boolean := coalesce(current_setting('tes.bypass_aut', true), '') = '1';
begin
  if tg_op = 'UPDATE' and not public.puede_editar() then
    raise exception 'No tenés permiso para modificar movimientos.';
  end if;

  -- Fechas por defecto
  new.fecha_prevista := coalesce(new.fecha_prevista, new.fecha);
  if new.estado = 'realizado' then new.fecha_efectiva := coalesce(new.fecha_efectiva, new.fecha_prevista); end if;
  if new.tipo = 'ingreso' then new.sentido := 'entrada'; elsif new.tipo = 'egreso' then new.sentido := 'salida'; end if;

  if new.categoria_id is not null then
    select * into cat from public.tes_categorias where id = new.categoria_id;
    if new.tipo <> 'transferencia' and cat.tipo <> new.tipo then
      raise exception 'La categoría "%" es de %, no de %.', cat.nombre, cat.tipo, new.tipo;
    end if;
  end if;

  if tg_op = 'UPDATE' then
    -- Días cerrados: no se tocan (Gerencia tiene que reabrir la jornada)
    if old.estado = 'realizado' and old.fecha_efectiva is not null and public.tes_dia_cerrado(old.fecha_efectiva)
       and (new.estado, new.importe, new.cuenta_id, new.fecha_efectiva, new.medio)
           is distinct from (old.estado, old.importe, old.cuenta_id, old.fecha_efectiva, old.medio) then
      raise exception 'La jornada del % está cerrada. Para corregir, Gerencia tiene que reabrirla.', to_char(old.fecha_efectiva, 'DD/MM/YYYY');
    end if;
    -- Conciliados con el extracto
    if old.conciliado and new.conciliado
       and (new.importe, new.cuenta_id, new.estado) is distinct from (old.importe, old.cuenta_id, old.estado) then
      raise exception 'Este movimiento está conciliado con el extracto del banco. Desconcilialo primero.';
    end if;
    -- Anulados no vuelven (salvo Gerencia)
    if old.estado = 'anulado' and new.estado <> 'anulado' and not public.es_gerencia() then
      raise exception 'Un movimiento anulado no se puede reactivar. Cargalo de nuevo.';
    end if;
    -- Transferencias: solo se anulan (las dos patas juntas)
    if old.tipo = 'transferencia' and pg_trigger_depth() = 1
       and (new.importe, new.cuenta_id, new.fecha_efectiva, new.fecha_prevista) is distinct from (old.importe, old.cuenta_id, old.fecha_efectiva, old.fecha_prevista)
       and not bypass then
      raise exception 'Para cambiar una transferencia, anulala y cargala de nuevo.';
    end if;
    -- Pago ya autorizado: si cambia monto, fecha, cuenta o medio vuelve a pedir autorización (A08)
    if old.tipo = 'egreso' and old.estado = 'autorizado' and new.estado = 'autorizado' and not public.es_gerencia() and not bypass
       and (new.importe, new.fecha_prevista, new.medio, new.cuenta_id) is distinct from (old.importe, old.fecha_prevista, old.medio, old.cuenta_id)
       and new.cheque_id is not distinct from old.cheque_id then
      new.estado := 'pendiente'; new.autorizado_por := null; new.autorizado_at := null;
    end if;
  end if;

  -- Cambios de estado
  if tg_op = 'INSERT' or new.estado is distinct from old.estado then
    if new.estado = 'autorizado' then
      if new.tipo <> 'egreso' then raise exception 'Solo los pagos se autorizan.'; end if;
      if not public.es_gerencia() and not bypass then raise exception 'Solo Gerencia/Finanzas puede autorizar pagos (A08).'; end if;
      new.autorizado_por := auth.uid(); new.autorizado_at := now();
    end if;
    if new.estado = 'realizado' then
      if new.tipo = 'egreso' and not bypass and not public.es_gerencia()
         and coalesce(cat.requiere_autorizacion, true)
         and (tg_op = 'INSERT' or old.estado <> 'autorizado') then
        raise exception 'Sin autorización explícita no se paga (A08). Pedí la autorización a Gerencia o usá una categoría de gasto menor.';
      end if;
      new.realizado_por := auth.uid(); new.realizado_at := now();
    end if;
    if new.estado = 'anulado' then
      if coalesce(trim(new.motivo_anulacion), '') = '' then raise exception 'Indicá el motivo de la anulación.'; end if;
      if new.conciliado then raise exception 'Está conciliado con el banco: desconcilialo antes de anular.'; end if;
      new.anulado_por := auth.uid(); new.anulado_at := now();
    end if;
    if new.estado = 'pendiente' and tg_op = 'UPDATE' then
      new.autorizado_por := null; new.autorizado_at := null;
    end if;
  end if;

  -- No se puede cargar un movimiento realizado en un día cerrado
  if new.estado = 'realizado' and public.tes_dia_cerrado(new.fecha_efectiva)
     and (tg_op = 'INSERT' or old.estado <> 'realizado' or old.fecha_efectiva is distinct from new.fecha_efectiva
          or old.importe is distinct from new.importe or old.cuenta_id is distinct from new.cuenta_id) then
    raise exception 'La jornada del % está cerrada. Cargalo con otra fecha o pedí a Gerencia que la reabra.', to_char(new.fecha_efectiva, 'DD/MM/YYYY');
  end if;
  return new;
end $$;

drop trigger if exists tes_mov_reglas on public.tes_movimientos;
create trigger tes_mov_reglas before insert or update on public.tes_movimientos
  for each row execute function public.tg_tes_mov_reglas();
drop trigger if exists tes_mov_updated on public.tes_movimientos;
create trigger tes_mov_updated before update on public.tes_movimientos
  for each row execute function public.tg_updated();
drop trigger if exists tes_mov_audit on public.tes_movimientos;
create trigger tes_mov_audit after insert or update or delete on public.tes_movimientos
  for each row execute function public.tg_auditoria();

-- Solo Gerencia decide qué egresos se pagan sin autorización (A08)
create or replace function public.tg_tes_cat_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;   -- SQL Editor / carga inicial
  if not public.es_gerencia() and new.tipo = 'egreso' then
    if tg_op = 'INSERT' and not new.requiere_autorizacion then
      raise exception 'Solo Gerencia puede crear categorías de pago directo (sin autorización).';
    end if;
    if tg_op = 'UPDATE' and new.requiere_autorizacion is distinct from old.requiere_autorizacion then
      raise exception 'Solo Gerencia puede cambiar qué categorías piden autorización.';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.clave is not null and (new.clave is distinct from old.clave or new.tipo <> old.tipo or not new.activa) then
    raise exception 'Esta categoría la usa el sistema: se puede renombrar pero no desactivar.';
  end if;
  return new;
end $$;
drop trigger if exists tes_cat_guard on public.tes_categorias;
create trigger tes_cat_guard before insert or update on public.tes_categorias
  for each row execute function public.tg_tes_cat_guard();

-- Anular una pata de transferencia anula la otra
create or replace function public.tg_tes_transf_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.transferencia_id is not null and new.estado = 'anulado' and old.estado <> 'anulado' then
    update public.tes_movimientos
       set estado = 'anulado', motivo_anulacion = new.motivo_anulacion
     where transferencia_id = new.transferencia_id and id <> new.id and estado <> 'anulado';
  end if;
  return null;
end $$;
drop trigger if exists tes_transf_sync on public.tes_movimientos;
create trigger tes_transf_sync after update of estado on public.tes_movimientos
  for each row execute function public.tg_tes_transf_sync();

drop trigger if exists tes_cheques_updated on public.tes_cheques;
create trigger tes_cheques_updated before update on public.tes_cheques
  for each row execute function public.tg_updated();
drop trigger if exists tes_cheques_audit on public.tes_cheques;
create trigger tes_cheques_audit after insert or update or delete on public.tes_cheques
  for each row execute function public.tg_auditoria();
drop trigger if exists tes_jornadas_audit on public.tes_jornadas;
create trigger tes_jornadas_audit after insert or update or delete on public.tes_jornadas
  for each row execute function public.tg_auditoria();
drop trigger if exists tes_categorias_audit on public.tes_categorias;
create trigger tes_categorias_audit after insert or update or delete on public.tes_categorias
  for each row execute function public.tg_auditoria();

-- Jornadas: lo cerrado no se toca sin reabrir
create or replace function public.tg_tes_jornada_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'Las jornadas no se eliminan.'; end if;
  if old.estado = 'cerrada' and coalesce(current_setting('tes.reabriendo', true), '') <> '1' then
    raise exception 'La jornada del % está cerrada. Solo Gerencia puede reabrirla.', to_char(old.fecha, 'DD/MM/YYYY');
  end if;
  return new;
end $$;
drop trigger if exists tes_jornada_guard on public.tes_jornadas;
create trigger tes_jornada_guard before update or delete on public.tes_jornadas
  for each row execute function public.tg_tes_jornada_guard();

create or replace function public.tg_tes_jsaldos_guard() returns trigger
language plpgsql as $$
declare est text;
begin
  select estado into est from public.tes_jornadas where id = coalesce(new.jornada_id, old.jornada_id);
  if est = 'cerrada' and coalesce(current_setting('tes.reabriendo', true), '') <> '1' then
    raise exception 'La jornada está cerrada.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists tes_jsaldos_guard on public.tes_jornada_saldos;
create trigger tes_jsaldos_guard before update or delete on public.tes_jornada_saldos
  for each row execute function public.tg_tes_jsaldos_guard();

-- =====================================================================
--  Saldos
-- =====================================================================

-- Saldo de una cuenta al final del día p_al.
-- Parte del último cierre (saldo real verificado) o de la apertura del día, y suma lo realizado después.
create or replace function public.tes_saldo_cuenta(p_cuenta uuid, p_al date) returns numeric
language plpgsql stable as $$
declare
  j record;
  base numeric := 0;
  desde date := '-infinity';
begin
  select jo.fecha, jo.estado, s.saldo_inicial, s.saldo_real, s.saldo_esperado into j
    from public.tes_jornadas jo join public.tes_jornada_saldos s on s.jornada_id = jo.id and s.cuenta_id = p_cuenta
   where jo.fecha <= p_al
   order by jo.fecha desc limit 1;
  if found then
    if j.estado = 'cerrada' then
      base := coalesce(j.saldo_real, j.saldo_esperado, j.saldo_inicial);
      desde := j.fecha + 1;
    else
      base := j.saldo_inicial;
      desde := j.fecha;
    end if;
  end if;
  return base + coalesce((
    select sum(case when sentido = 'entrada' then importe else -importe end)
      from public.tes_movimientos
     where cuenta_id = p_cuenta and estado = 'realizado' and fecha_efectiva between desde and p_al
  ), 0);
end $$;

-- Disponibilidad por cuenta a una fecha
create or replace function public.tes_disponibilidad(p_al date default public.hoy())
returns table (cuenta_id uuid, codigo text, nombre text, tipo text, saldo numeric)
language sql stable as $$
  select c.id, c.codigo, c.nombre, c.tipo, public.tes_saldo_cuenta(c.id, p_al)
    from public.tes_cuentas c where c.activa order by c.orden
$$;

-- =====================================================================
--  Operaciones (todo lo que toca más de una tabla, en un solo paso)
-- =====================================================================

-- Transferencia entre cuentas propias: dos movimientos vinculados, no es ingreso ni gasto
create or replace function public.tes_transferir(p jsonb) returns uuid
language plpgsql as $$
declare
  tid uuid := gen_random_uuid();
  o uuid := (p->>'origen')::uuid;
  d uuid := (p->>'destino')::uuid;
  imp numeric := (p->>'importe')::numeric;
  f date := coalesce((p->>'fecha')::date, public.hoy());
  fe date := coalesce((p->>'fecha_efectiva')::date, f);
  est text := coalesce(p->>'estado', 'realizado');
  concepto text := coalesce(nullif(trim(p->>'concepto'), ''), 'Transferencia entre cuentas');
  medio text := coalesce(p->>'medio', 'transferencia');
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  if o is null or d is null or o = d then raise exception 'Elegí cuenta de origen y de destino distintas.'; end if;
  if imp is null or imp <= 0 then raise exception 'Importe inválido.'; end if;
  insert into public.tes_movimientos (fecha, tipo, sentido, concepto, medio, cuenta_id, transferencia_id, importe, fecha_prevista, fecha_efectiva, estado, comprobante, observaciones)
  values (f, 'transferencia', 'salida', concepto, medio, o, tid, imp, fe, case when est = 'realizado' then fe end, est, p->>'comprobante', p->>'observaciones'),
         (f, 'transferencia', 'entrada', concepto, medio, d, tid, imp, fe, case when est = 'realizado' then fe end, est, p->>'comprobante', p->>'observaciones');
  return tid;
end $$;

-- Cobro de una factura (desde Cobranzas): cobro + cheque (si corresponde) + movimiento de tesorería
create or replace function public.tes_registrar_cobro(p jsonb) returns jsonb
language plpgsql as $$
declare
  fac public.facturas;
  cli public.clientes;
  cat uuid;
  medio text := p->>'medio';
  cuenta uuid := nullif(p->>'cuenta_id', '')::uuid;
  f date := coalesce((p->>'fecha')::date, public.hoy());
  imp numeric := (p->>'monto')::numeric;
  cob uuid; chq uuid; mov uuid;
  ch jsonb := p->'cheque';
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  select * into fac from public.facturas where id = (p->>'factura_id')::uuid;
  if fac.id is null then raise exception 'Factura inexistente.'; end if;
  select * into cli from public.clientes where id = fac.cliente_id;
  select id into cat from public.tes_categorias where clave = 'cobranza';
  if cuenta is null and medio <> 'endoso' then raise exception 'Elegí la cuenta donde entra el cobro.'; end if;

  insert into public.cobros (factura_id, fecha, monto, medio_pago, referencia, observaciones)
  values (fac.id, f, imp, case medio when 'efectivo' then 'Efectivo' when 'cheque' then 'Cheque' when 'echeq' then 'E-cheq' when 'tarjeta' then 'Tarjeta' else 'Transferencia' end,
          nullif(p->>'referencia', ''), nullif(p->>'observaciones', ''))
  returning id into cob;

  if medio in ('cheque','echeq') then
    if ch is null or coalesce(ch->>'numero', '') = '' or coalesce(ch->>'fecha_pago', '') = '' then
      raise exception 'Cargá número y fecha de pago del cheque.';
    end if;
    insert into public.tes_cheques (sentido, formato, numero, banco, contraparte, cuit, cliente_id, importe, fecha_emision, fecha_pago, cuenta_id, estado, cobro_id)
    values ('recibido', case when medio = 'echeq' then 'echeq' else 'fisico' end, ch->>'numero', nullif(ch->>'banco', ''), cli.razon_social,
            coalesce(nullif(ch->>'cuit', ''), cli.cuit_dni), cli.id, imp, nullif(ch->>'fecha_emision', '')::date, (ch->>'fecha_pago')::date, cuenta, 'en_cartera', cob)
    returning id into chq;
    -- Queda pendiente: no es plata disponible hasta que se acredita
    insert into public.tes_movimientos (fecha, tipo, sentido, categoria_id, concepto, contraparte, medio, cuenta_id, importe, fecha_prevista, estado, comprobante, cheque_id, cobro_id, factura_id)
    values (f, 'ingreso', 'entrada', cat, format('Cobro %s %s', fac.tipo_comprobante, fac.numero), cli.razon_social, medio, cuenta, imp,
            greatest((ch->>'fecha_pago')::date, f), 'pendiente', format('%s N° %s', case when medio = 'echeq' then 'E-cheq' else 'Cheque' end, ch->>'numero'), chq, cob, fac.id)
    returning id into mov;
  else
    insert into public.tes_movimientos (fecha, tipo, sentido, categoria_id, concepto, contraparte, medio, cuenta_id, importe, fecha_prevista, fecha_efectiva, estado, comprobante, cobro_id, factura_id)
    values (f, 'ingreso', 'entrada', cat, format('Cobro %s %s', fac.tipo_comprobante, fac.numero), cli.razon_social, medio, cuenta, imp,
            f, f, 'realizado', nullif(p->>'referencia', ''), cob, fac.id)
    returning id into mov;
  end if;
  return jsonb_build_object('cobro_id', cob, 'cheque_id', chq, 'movimiento_id', mov);
end $$;

-- Ejecutar un movimiento pendiente: pagar / cobrar (con transferencia, efectivo o cheque)
create or replace function public.tes_ejecutar(p_mov uuid, p jsonb) returns uuid
language plpgsql as $$
declare
  m public.tes_movimientos;
  v_medio text := coalesce(p->>'medio', 'transferencia');
  v_cuenta uuid := nullif(p->>'cuenta_id', '')::uuid;
  f date := coalesce((p->>'fecha')::date, public.hoy());
  ch jsonb := p->'cheque';
  chq uuid;
  cat public.tes_categorias;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  select * into m from public.tes_movimientos where id = p_mov for update;
  if m.id is null then raise exception 'Movimiento inexistente.'; end if;
  if m.estado not in ('pendiente','autorizado') then raise exception 'Este movimiento ya está %.', m.estado; end if;
  if m.tipo = 'transferencia' then raise exception 'Las transferencias se cargan ya realizadas.'; end if;
  if v_cuenta is null then raise exception 'Elegí la cuenta.'; end if;
  select * into cat from public.tes_categorias where id = m.categoria_id;

  if v_medio in ('cheque','echeq') then
    if coalesce(ch->>'numero', '') = '' or coalesce(ch->>'fecha_pago', '') = '' then raise exception 'Cargá número y fecha de pago del cheque.'; end if;
    if m.tipo = 'egreso' and m.estado <> 'autorizado' and coalesce(cat.requiere_autorizacion, true) and not public.es_gerencia() then
      raise exception 'Sin autorización explícita no se paga (A08). Pedí la autorización a Gerencia.';
    end if;
    insert into public.tes_cheques (sentido, formato, numero, banco, contraparte, cuit, importe, fecha_emision, fecha_pago, cuenta_id, estado)
    values (case when m.tipo = 'egreso' then 'emitido' else 'recibido' end, case when v_medio = 'echeq' then 'echeq' else 'fisico' end,
            ch->>'numero', nullif(ch->>'banco', ''), coalesce(m.contraparte, m.concepto), nullif(ch->>'cuit', ''), m.importe,
            coalesce(nullif(ch->>'fecha_emision', '')::date, f), (ch->>'fecha_pago')::date, v_cuenta,
            case when m.tipo = 'egreso' then 'emitido' else 'en_cartera' end)
    returning id into chq;
    perform set_config('tes.bypass_aut', '1', true);
    update public.tes_movimientos
       set cheque_id = chq, medio = v_medio, cuenta_id = v_cuenta, fecha_prevista = greatest((ch->>'fecha_pago')::date, f),
           comprobante = coalesce(nullif(p->>'comprobante', ''), format('%s N° %s', case when v_medio = 'echeq' then 'E-cheq' else 'Cheque' end, ch->>'numero')),
           estado = case when m.tipo = 'egreso' then 'autorizado' else 'pendiente' end
     where id = p_mov;
    perform set_config('tes.bypass_aut', '', true);
  else
    if m.tipo = 'egreso' and coalesce(trim(p->>'comprobante'), '') = '' then
      raise exception 'Cargá el comprobante u orden de pago (A08: registrar con su respaldo).';
    end if;
    update public.tes_movimientos
       set estado = 'realizado', medio = v_medio, cuenta_id = v_cuenta, fecha_efectiva = f,
           comprobante = coalesce(nullif(p->>'comprobante', ''), comprobante)
     where id = p_mov;
  end if;
  return p_mov;
end $$;

-- Acciones sobre cheques: depositar, acreditar, debitar, endosar, rechazar, anular
create or replace function public.tes_cheque_accion(p_cheque uuid, p_accion text, p jsonb default '{}'::jsonb) returns void
language plpgsql as $$
declare
  c public.tes_cheques;
  m public.tes_movimientos;
  f date := coalesce((p->>'fecha')::date, public.hoy());
  v_cuenta uuid := nullif(p->>'cuenta_id', '')::uuid;
  v_motivo text := nullif(trim(p->>'motivo'), '');
  cat_rech uuid;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  select * into c from public.tes_cheques where id = p_cheque for update;
  if c.id is null then raise exception 'Cheque inexistente.'; end if;
  select * into m from public.tes_movimientos where cheque_id = c.id and estado <> 'anulado' and sentido = case when c.sentido = 'recibido' then 'entrada' else 'salida' end
   order by created_at limit 1;

  if p_accion = 'depositar' then
    if c.sentido <> 'recibido' or c.estado <> 'en_cartera' then raise exception 'Solo se depositan cheques en cartera.'; end if;
    if v_cuenta is null then v_cuenta := c.cuenta_id; end if;
    if v_cuenta is null then raise exception 'Elegí la cuenta donde se deposita.'; end if;
    update public.tes_cheques set estado = 'depositado', fecha_deposito = f, cuenta_id = v_cuenta where id = c.id;
    if m.id is not null then
      update public.tes_movimientos set cuenta_id = v_cuenta, fecha_prevista = greatest(c.fecha_pago, f) where id = m.id;
    end if;

  elsif p_accion in ('acreditar','debitar') then
    if p_accion = 'acreditar' and (c.sentido <> 'recibido' or c.estado not in ('en_cartera','depositado')) then raise exception 'Solo se acreditan cheques recibidos en cartera o depositados.'; end if;
    if p_accion = 'debitar' and (c.sentido <> 'emitido' or c.estado <> 'emitido') then raise exception 'Solo se debitan cheques emitidos pendientes.'; end if;
    update public.tes_cheques set estado = case when p_accion = 'acreditar' then 'acreditado' else 'debitado' end, fecha_efectiva = f,
           cuenta_id = coalesce(v_cuenta, cuenta_id) where id = c.id;
    if m.id is not null then
      perform set_config('tes.bypass_aut', '1', true);
      update public.tes_movimientos set estado = 'realizado', fecha_efectiva = f, cuenta_id = coalesce(v_cuenta, c.cuenta_id, m.cuenta_id) where id = m.id;
      perform set_config('tes.bypass_aut', '', true);
    end if;

  elsif p_accion = 'endosar' then
    if c.sentido <> 'recibido' or c.estado <> 'en_cartera' then raise exception 'Solo se endosan cheques en cartera.'; end if;
    if coalesce(trim(p->>'destinatario'), '') = '' then raise exception 'Indicá a quién se endosa.'; end if;
    update public.tes_cheques set estado = 'endosado', endosado_a = p->>'destinatario', fecha_efectiva = f where id = c.id;
    perform set_config('tes.bypass_aut', '1', true);
    -- El cobro queda hecho, pero no pasa por ninguna cuenta
    if m.id is not null then
      update public.tes_movimientos set estado = 'realizado', medio = 'endoso', cuenta_id = null, fecha_efectiva = f where id = m.id;
    end if;
    -- El pago al proveedor: uno ya cargado y autorizado, o uno nuevo
    if nullif(p->>'mov_pago', '') is not null then
      update public.tes_movimientos set estado = 'realizado', medio = 'endoso', cuenta_id = null, fecha_efectiva = f, cheque_id = c.id,
             comprobante = coalesce(comprobante, format('Endoso cheque N° %s', c.numero))
       where id = (p->>'mov_pago')::uuid and tipo = 'egreso' and estado = 'autorizado';
      if not found then raise exception 'El pago elegido tiene que estar autorizado.'; end if;
    else
      if nullif(p->>'categoria_id', '') is null then raise exception 'Elegí la categoría del pago.'; end if;
      perform set_config('tes.bypass_aut', '', true);
      insert into public.tes_movimientos (fecha, tipo, sentido, categoria_id, concepto, contraparte, medio, cuenta_id, importe, fecha_prevista, fecha_efectiva, estado, comprobante, cheque_id)
      values (f, 'egreso', 'salida', (p->>'categoria_id')::uuid, coalesce(nullif(p->>'concepto', ''), format('Pago con cheque endosado N° %s', c.numero)),
              p->>'destinatario', 'endoso', null, c.importe, f, f, 'realizado', format('Endoso cheque N° %s', c.numero), c.id);
    end if;
    perform set_config('tes.bypass_aut', '', true);

  elsif p_accion = 'rechazar' then
    if c.estado in ('rechazado','anulado','debitado','endosado') then raise exception 'Ese cheque no se puede rechazar (estado: %).', c.estado; end if;
    if v_motivo is null then raise exception 'Indicá el motivo del rechazo.'; end if;
    update public.tes_cheques set estado = 'rechazado', motivo = v_motivo, fecha_efectiva = f where id = c.id;
    if c.sentido = 'recibido' then
      if m.id is not null and m.estado <> 'realizado' then
        update public.tes_movimientos set estado = 'anulado', motivo_anulacion = 'Cheque rechazado: ' || v_motivo where id = m.id;
      elsif m.id is not null then
        -- Ya se había acreditado: el banco lo debita de vuelta
        select id into cat_rech from public.tes_categorias where clave = 'cheque_rechazado';
        perform set_config('tes.bypass_aut', '1', true);
        insert into public.tes_movimientos (fecha, tipo, sentido, categoria_id, concepto, contraparte, medio, cuenta_id, importe, fecha_prevista, fecha_efectiva, estado, comprobante, cheque_id)
        values (f, 'egreso', 'salida', cat_rech, format('Cheque N° %s rechazado: %s', c.numero, v_motivo), c.contraparte, 'debito_automatico',
                coalesce(c.cuenta_id, m.cuenta_id), c.importe, f, f, 'realizado', format('Rechazo cheque N° %s', c.numero), c.id);
        perform set_config('tes.bypass_aut', '', true);
      end if;
      -- La factura del cliente vuelve a quedar con deuda
      if c.cobro_id is not null then perform public.tes_revertir_cobro(c.cobro_id); end if;
    else
      -- Cheque propio rechazado: la deuda con el proveedor sigue pendiente
      if m.id is not null then
        perform set_config('tes.bypass_aut', '1', true);
        update public.tes_movimientos set cheque_id = null, estado = 'autorizado',
               observaciones = concat_ws(' · ', observaciones, format('Cheque N° %s rechazado (%s)', c.numero, v_motivo))
         where id = m.id;
        perform set_config('tes.bypass_aut', '', true);
      end if;
    end if;

  elsif p_accion = 'anular' then
    if c.estado not in ('en_cartera','emitido') then raise exception 'Solo se anulan cheques en cartera o emitidos sin debitar.'; end if;
    if v_motivo is null then raise exception 'Indicá el motivo.'; end if;
    update public.tes_cheques set estado = 'anulado', motivo = v_motivo where id = c.id;
    if m.id is not null then
      if c.sentido = 'emitido' then
        perform set_config('tes.bypass_aut', '1', true);
        update public.tes_movimientos set cheque_id = null, observaciones = concat_ws(' · ', observaciones, format('Cheque N° %s anulado (%s)', c.numero, v_motivo)) where id = m.id;
        perform set_config('tes.bypass_aut', '', true);
      else
        update public.tes_movimientos set estado = 'anulado', motivo_anulacion = 'Cheque anulado: ' || v_motivo where id = m.id;
        if c.cobro_id is not null then perform public.tes_revertir_cobro(c.cobro_id); end if;
      end if;
    end if;
  else
    raise exception 'Acción desconocida: %', p_accion;
  end if;
end $$;

-- Borra el cobro de una factura (cheque rechazado o anulado): la deuda vuelve
create or replace function public.tes_revertir_cobro(p_cobro uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  update public.tes_movimientos set cobro_id = null where cobro_id = p_cobro;
  update public.tes_cheques set cobro_id = null where cobro_id = p_cobro;
  delete from public.cobros where id = p_cobro;
end $$;

-- ---------- Conciliación bancaria ----------
create or replace function public.tes_conciliar(p_extracto uuid, p_mov uuid) returns void
language plpgsql as $$
declare
  e public.tes_extractos;
  m public.tes_movimientos;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  select * into e from public.tes_extractos where id = p_extracto for update;
  select * into m from public.tes_movimientos where id = p_mov for update;
  if e.id is null or m.id is null then raise exception 'No encontré el movimiento o la línea del extracto.'; end if;
  if e.estado <> 'pendiente' then raise exception 'Esa línea del extracto ya está %.', e.estado; end if;
  if m.conciliado then raise exception 'Ese movimiento ya está conciliado.'; end if;
  if m.estado = 'anulado' then raise exception 'Ese movimiento está anulado.'; end if;
  if m.cuenta_id is distinct from e.cuenta_id then raise exception 'El movimiento es de otra cuenta.'; end if;
  if (e.importe > 0) <> (m.sentido = 'entrada') then raise exception 'Uno es crédito y el otro débito.'; end if;
  if abs(e.importe) <> m.importe then raise exception 'Los importes no coinciden (% contra %).', abs(e.importe), m.importe; end if;

  perform set_config('tes.bypass_aut', '1', true);
  -- Si estaba pendiente, el banco confirma que se hizo
  if m.estado <> 'realizado' then
    update public.tes_movimientos set estado = 'realizado', fecha_efectiva = e.fecha where id = m.id;
    if m.cheque_id is not null then
      update public.tes_cheques set estado = case when sentido = 'recibido' then 'acreditado' else 'debitado' end, fecha_efectiva = e.fecha
       where id = m.cheque_id and estado in ('en_cartera','depositado','emitido');
    end if;
  end if;
  update public.tes_movimientos set conciliado = true, extracto_id = e.id where id = m.id;
  perform set_config('tes.bypass_aut', '', true);
  update public.tes_extractos set estado = 'conciliado', movimiento_id = m.id where id = e.id;
end $$;

create or replace function public.tes_desconciliar(p_extracto uuid) returns void
language plpgsql as $$
declare e public.tes_extractos;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  select * into e from public.tes_extractos where id = p_extracto for update;
  if e.movimiento_id is not null then
    update public.tes_movimientos set conciliado = false, extracto_id = null where id = e.movimiento_id;
  end if;
  update public.tes_extractos set estado = 'pendiente', movimiento_id = null, nota = null where id = e.id;
end $$;

-- Línea del extracto que no estaba cargada (débito automático, comisión, transferencia recibida…)
create or replace function public.tes_crear_desde_extracto(p_extracto uuid, p jsonb) returns uuid
language plpgsql as $$
declare
  e public.tes_extractos;
  mid uuid;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  select * into e from public.tes_extractos where id = p_extracto for update;
  if e.estado <> 'pendiente' then raise exception 'Esa línea ya está %.', e.estado; end if;
  if nullif(p->>'categoria_id', '') is null then raise exception 'Elegí la categoría.'; end if;
  if public.tes_dia_cerrado(e.fecha) then
    raise exception 'Esa línea es del % y la jornada ya está cerrada. Si la diferencia ya se justificó en el cierre, usá "Ignorar" con esa nota; si no, Gerencia tiene que reabrir la jornada para cargarla.', to_char(e.fecha, 'DD/MM/YYYY');
  end if;
  perform set_config('tes.bypass_aut', '1', true);
  insert into public.tes_movimientos (fecha, tipo, sentido, categoria_id, concepto, contraparte, medio, cuenta_id, importe, fecha_prevista, fecha_efectiva, estado, comprobante, observaciones)
  values (e.fecha, case when e.importe > 0 then 'ingreso' else 'egreso' end, case when e.importe > 0 then 'entrada' else 'salida' end,
          (p->>'categoria_id')::uuid, coalesce(nullif(trim(p->>'concepto'), ''), e.descripcion), nullif(p->>'contraparte', ''),
          coalesce(nullif(p->>'medio', ''), case when e.importe > 0 then 'transferencia' else 'debito_automatico' end),
          e.cuenta_id, abs(e.importe), e.fecha, e.fecha, 'realizado', coalesce(e.referencia, 'Extracto bancario'), 'Cargado desde el extracto: ' || e.descripcion)
  returning id into mid;
  perform set_config('tes.bypass_aut', '', true);
  perform public.tes_conciliar(e.id, mid);
  return mid;
end $$;

-- ---------- Apertura y cierre ----------
create or replace function public.tes_abrir_jornada(p_fecha date, p_saldos jsonb, p_obs text default null) returns uuid
language plpgsql as $$
declare
  jid uuid;
  c record;
  previa record;
  ingresado numeric;
  datos jsonb := '[]'::jsonb;
  sist numeric;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso para abrir la jornada.'; end if;
  if exists (select 1 from public.tes_jornadas where fecha = p_fecha) then raise exception 'Ya existe la jornada del %.', to_char(p_fecha, 'DD/MM/YYYY'); end if;
  select fecha into previa from public.tes_jornadas where fecha < p_fecha and estado = 'abierta' order by fecha limit 1;
  if found then raise exception 'La jornada del % sigue abierta. Cerrala antes de abrir otra (A06: no se postergan cierres).', to_char(previa.fecha, 'DD/MM/YYYY'); end if;

  insert into public.tes_jornadas (fecha, observaciones) values (p_fecha, nullif(trim(coalesce(p_obs, '')), '')) returning id into jid;
  for c in select * from public.tes_cuentas where activa order by orden loop
    sist := public.tes_saldo_cuenta(c.id, p_fecha - 1);
    select (x->>'saldo_inicial')::numeric into ingresado from jsonb_array_elements(coalesce(p_saldos, '[]'::jsonb)) x where (x->>'cuenta_id')::uuid = c.id;
    insert into public.tes_jornada_saldos (jornada_id, cuenta_id, saldo_sistema, saldo_inicial)
    values (jid, c.id, sist, coalesce(ingresado, sist));
    datos := datos || jsonb_build_object('cuenta', c.nombre, 'sistema', sist, 'inicial', coalesce(ingresado, sist));
  end loop;
  insert into public.tes_jornada_eventos (jornada_id, accion, datos) values (jid, 'apertura', datos);
  return jid;
end $$;

create or replace function public.tes_cerrar_jornada(p_jornada uuid, p_reales jsonb, p_checklist jsonb, p_obs text default null) returns void
language plpgsql as $$
declare
  j public.tes_jornadas;
  s record;
  v_esp numeric;
  v_real numeric;
  v_just text;
  item text;
  requeridos text[] := array['ingresos','egresos','comprobantes','bancos','cheques','cobros','pagos'];
  datos jsonb := '[]'::jsonb;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso para cerrar la jornada.'; end if;
  select * into j from public.tes_jornadas where id = p_jornada for update;
  if j.id is null then raise exception 'Jornada inexistente.'; end if;
  if j.estado = 'cerrada' then raise exception 'La jornada ya está cerrada.'; end if;
  foreach item in array requeridos loop
    if coalesce((p_checklist->>item)::boolean, false) = false then
      raise exception 'Checklist de cierre incompleto: falta "%".', item;
    end if;
  end loop;

  for s in select js.*, c.nombre from public.tes_jornada_saldos js join public.tes_cuentas c on c.id = js.cuenta_id where js.jornada_id = j.id loop
    v_esp := s.saldo_inicial + coalesce((
      select sum(case when sentido = 'entrada' then importe else -importe end)
        from public.tes_movimientos where cuenta_id = s.cuenta_id and estado = 'realizado' and fecha_efectiva = j.fecha), 0);
    select (x->>'saldo_real')::numeric, nullif(trim(x->>'justificacion'), '') into v_real, v_just
      from jsonb_array_elements(coalesce(p_reales, '[]'::jsonb)) x where (x->>'cuenta_id')::uuid = s.cuenta_id;
    if v_real is null then raise exception 'Falta el saldo real de %.', s.nombre; end if;
    if v_real <> v_esp and v_just is null then
      raise exception 'En % hay una diferencia de $ % (esperado %, real %). Tenés que justificarla.', s.nombre, v_real - v_esp, v_esp, v_real;
    end if;
    update public.tes_jornada_saldos set saldo_esperado = v_esp, saldo_real = v_real, diferencia = v_real - v_esp, justificacion = v_just where id = s.id;
    datos := datos || jsonb_build_object('cuenta', s.nombre, 'inicial', s.saldo_inicial, 'esperado', v_esp, 'real', v_real, 'diferencia', v_real - v_esp, 'justificacion', v_just);
    v_real := null; v_just := null;
  end loop;

  update public.tes_jornadas
     set estado = 'cerrada', checklist = checklist || p_checklist, cerrada_por = auth.uid(), cerrada_at = now(),
         observaciones = coalesce(nullif(trim(coalesce(p_obs, '')), ''), observaciones)
   where id = j.id;
  insert into public.tes_jornada_eventos (jornada_id, accion, datos, motivo) values (j.id, 'cierre', datos, nullif(trim(coalesce(p_obs, '')), ''));
end $$;

create or replace function public.tes_reabrir_jornada(p_jornada uuid, p_motivo text) returns void
language plpgsql as $$
declare
  j public.tes_jornadas;
  previo jsonb;
begin
  if not public.es_gerencia() then raise exception 'Solo Gerencia puede reabrir una jornada.'; end if;
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Indicá el motivo de la reapertura.'; end if;
  select * into j from public.tes_jornadas where id = p_jornada for update;
  if j.estado <> 'cerrada' then raise exception 'La jornada no está cerrada.'; end if;
  select jsonb_agg(jsonb_build_object('cuenta_id', cuenta_id, 'inicial', saldo_inicial, 'esperado', saldo_esperado, 'real', saldo_real, 'diferencia', diferencia, 'justificacion', justificacion))
    into previo from public.tes_jornada_saldos where jornada_id = j.id;
  perform set_config('tes.reabriendo', '1', true);
  update public.tes_jornadas set estado = 'abierta', cerrada_por = null, cerrada_at = null where id = j.id;
  perform set_config('tes.reabriendo', '', true);
  insert into public.tes_jornada_eventos (jornada_id, accion, motivo, datos) values (j.id, 'reapertura', p_motivo, previo);
end $$;

-- Cambiar el saldo inicial de una jornada abierta (queda en el historial)
create or replace function public.tes_corregir_inicial(p_jornada uuid, p_cuenta uuid, p_monto numeric, p_motivo text) returns void
language plpgsql as $$
declare anterior numeric;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Indicá el motivo de la corrección.'; end if;
  select saldo_inicial into anterior from public.tes_jornada_saldos where jornada_id = p_jornada and cuenta_id = p_cuenta;
  update public.tes_jornada_saldos set saldo_inicial = p_monto where jornada_id = p_jornada and cuenta_id = p_cuenta;
  insert into public.tes_jornada_eventos (jornada_id, accion, motivo, datos)
  values (p_jornada, 'correccion', p_motivo, jsonb_build_object('cuenta_id', p_cuenta, 'antes', anterior, 'despues', p_monto));
end $$;

-- =====================================================================
--  Permisos: Tesorería es de Administración y Gerencia
-- =====================================================================
alter table public.tes_cuentas          enable row level security;
alter table public.tes_categorias       enable row level security;
alter table public.tes_cheques          enable row level security;
alter table public.tes_movimientos      enable row level security;
alter table public.tes_extractos        enable row level security;
alter table public.tes_jornadas         enable row level security;
alter table public.tes_jornada_saldos   enable row level security;
alter table public.tes_jornada_eventos  enable row level security;

drop policy if exists tes_cuentas_sel on public.tes_cuentas;
create policy tes_cuentas_sel on public.tes_cuentas for select to authenticated using (public.puede_editar());
drop policy if exists tes_cuentas_upd on public.tes_cuentas;
create policy tes_cuentas_upd on public.tes_cuentas for update to authenticated using (public.es_gerencia()) with check (public.es_gerencia());

drop policy if exists tes_cat_sel on public.tes_categorias;
create policy tes_cat_sel on public.tes_categorias for select to authenticated using (public.puede_editar());
drop policy if exists tes_cat_ins on public.tes_categorias;
create policy tes_cat_ins on public.tes_categorias for insert to authenticated with check (public.puede_editar());
drop policy if exists tes_cat_upd on public.tes_categorias;
create policy tes_cat_upd on public.tes_categorias for update to authenticated using (public.puede_editar()) with check (public.puede_editar());

drop policy if exists tes_mov_sel on public.tes_movimientos;
create policy tes_mov_sel on public.tes_movimientos for select to authenticated using (public.puede_editar());
drop policy if exists tes_mov_ins on public.tes_movimientos;
create policy tes_mov_ins on public.tes_movimientos for insert to authenticated with check (public.puede_editar());
drop policy if exists tes_mov_upd on public.tes_movimientos;
create policy tes_mov_upd on public.tes_movimientos for update to authenticated using (public.puede_editar()) with check (public.puede_editar());

drop policy if exists tes_chq_sel on public.tes_cheques;
create policy tes_chq_sel on public.tes_cheques for select to authenticated using (public.puede_editar());
drop policy if exists tes_chq_ins on public.tes_cheques;
create policy tes_chq_ins on public.tes_cheques for insert to authenticated with check (public.puede_editar());
drop policy if exists tes_chq_upd on public.tes_cheques;
create policy tes_chq_upd on public.tes_cheques for update to authenticated using (public.puede_editar()) with check (public.puede_editar());

drop policy if exists tes_ext_sel on public.tes_extractos;
create policy tes_ext_sel on public.tes_extractos for select to authenticated using (public.puede_editar());
drop policy if exists tes_ext_ins on public.tes_extractos;
create policy tes_ext_ins on public.tes_extractos for insert to authenticated with check (public.puede_editar());
drop policy if exists tes_ext_upd on public.tes_extractos;
create policy tes_ext_upd on public.tes_extractos for update to authenticated using (public.puede_editar()) with check (public.puede_editar());
drop policy if exists tes_ext_del on public.tes_extractos;
create policy tes_ext_del on public.tes_extractos for delete to authenticated using (public.puede_editar() and estado = 'pendiente');

drop policy if exists tes_jor_sel on public.tes_jornadas;
create policy tes_jor_sel on public.tes_jornadas for select to authenticated using (public.puede_editar());
drop policy if exists tes_jor_ins on public.tes_jornadas;
create policy tes_jor_ins on public.tes_jornadas for insert to authenticated with check (public.puede_editar());
drop policy if exists tes_jor_upd on public.tes_jornadas;
create policy tes_jor_upd on public.tes_jornadas for update to authenticated using (public.puede_editar()) with check (public.puede_editar());

drop policy if exists tes_js_sel on public.tes_jornada_saldos;
create policy tes_js_sel on public.tes_jornada_saldos for select to authenticated using (public.puede_editar());
drop policy if exists tes_js_ins on public.tes_jornada_saldos;
create policy tes_js_ins on public.tes_jornada_saldos for insert to authenticated with check (public.puede_editar());
drop policy if exists tes_js_upd on public.tes_jornada_saldos;
create policy tes_js_upd on public.tes_jornada_saldos for update to authenticated using (public.puede_editar()) with check (public.puede_editar());

drop policy if exists tes_je_sel on public.tes_jornada_eventos;
create policy tes_je_sel on public.tes_jornada_eventos for select to authenticated using (public.puede_editar());
drop policy if exists tes_je_ins on public.tes_jornada_eventos;
create policy tes_je_ins on public.tes_jornada_eventos for insert to authenticated with check (public.puede_editar());

-- =====================================================================
--  DE&CO · Migración 08 · Cuentas a Cobrar (Sintesys), Cuentas a Pagar,
--  transferencias con fecha diferida, reservas mínimas y simulaciones.
--  Requiere la migración 07 (Tesorería). Se puede correr más de una vez.
-- =====================================================================

-- ---------- Historial de cambios de fechas (cobros y pagos) ----------
create table if not exists public.hist_fechas (
  id          bigserial primary key,
  entidad     text not null check (entidad in ('factura','obligacion')),
  entidad_id  uuid not null,
  campo       text not null,
  antes       date,
  despues     date,
  motivo      text,
  usuario     uuid default auth.uid() references public.perfiles(id),
  fecha       timestamptz not null default now()
);
create index if not exists hist_fechas_ent_idx on public.hist_fechas (entidad, entidad_id);

-- ---------- Lotes de importación (Excel de Sintesys) ----------
create table if not exists public.imp_lotes (
  id           uuid primary key default gen_random_uuid(),
  tipo         text not null check (tipo in ('cobrar','pagar')),
  archivo      text,
  filas        int not null default 0,
  nuevas       int not null default 0,
  actualizadas int not null default 0,
  sin_cambios  int not null default 0,
  errores      jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid() references public.perfiles(id)
);

-- =====================================================================
--  CUENTAS A COBRAR
-- =====================================================================
alter table public.facturas add column if not exists origen               text not null default 'manual';
alter table public.facturas add column if not exists vendedor             text;
alter table public.facturas add column if not exists vencimiento_original date;
alter table public.facturas add column if not exists fecha_estimada_cobro date;
alter table public.facturas add column if not exists ajuste_previo        numeric(14,2) not null default 0;  -- cobrado antes de pasar a la app (según Sintesys)
alter table public.facturas add column if not exists saldo_sintesys       numeric(14,2);
alter table public.facturas add column if not exists ult_lote             uuid references public.imp_lotes(id);
update public.facturas set vencimiento_original = fecha_vencimiento where vencimiento_original is null;
do $$ begin
  alter table public.facturas add constraint facturas_origen_chk check (origen in ('manual','sintesys'));
exception when duplicate_object then null; end $$;

create or replace function public.tg_facturas_reglas() returns trigger
language plpgsql security definer set search_path = public as $$
declare est text;
  imp boolean := coalesce(current_setting('imp.sintesys', true), '') = '1';
begin
  if tg_op = 'INSERT' then
    select estado into est from public.clientes where id = new.cliente_id;
    -- Lo que viene de Sintesys ya está facturado oficialmente: no se bloquea por el estado del cliente
    if est is distinct from 'activo' and new.origen <> 'sintesys' then
      raise exception 'El cliente no está habilitado para facturación (A01/A03). Validalo primero.';
    end if;
    if new.origen <> 'sintesys' then new.ajuste_previo := 0; end if;
    new.ajuste_previo := greatest(0, least(coalesce(new.ajuste_previo, 0), new.monto));
    new.saldo  := new.monto - new.ajuste_previo;
    new.estado := case when new.saldo <= 0 then 'cobrado' else 'pendiente' end;
    new.fecha_cobro := null;
    new.vencimiento_original := new.fecha_vencimiento;
  else
    -- El vencimiento original no se pierde nunca
    new.vencimiento_original := old.vencimiento_original;
    -- A05: no cambiar fechas ni medio de pago sin autorización (solo Gerencia, o la reimportación de Sintesys)
    if (new.fecha_vencimiento   is distinct from old.fecha_vencimiento
     or new.medio_pago_acordado is distinct from old.medio_pago_acordado
     or new.monto               is distinct from old.monto
     or new.cliente_id          is distinct from old.cliente_id)
     and not public.es_gerencia() and not imp then
      raise exception 'Cambiar vencimiento, monto, cliente o medio de pago requiere autorización de Gerencia (A05).';
    end if;
    if new.ajuste_previo is distinct from old.ajuste_previo and coalesce(current_setting('cob.ajuste', true), '') <> '1' and not imp then
      raise exception 'El ajuste de saldo se hace desde "Ajustar con Sintesys", con motivo.';
    end if;
    if new.estado = 'anulada' and old.estado <> 'anulada' and not public.es_gerencia() then
      raise exception 'Solo Gerencia puede anular comprobantes.';
    end if;
    if new.monto is distinct from old.monto or new.ajuste_previo is distinct from old.ajuste_previo then
      new.saldo := new.monto - new.ajuste_previo - coalesce((select sum(monto) from public.cobros where factura_id = new.id), 0);
      if new.estado <> 'anulada' then new.estado := case when new.saldo <= 0 then 'cobrado' else 'pendiente' end; end if;
    end if;
  end if;
  return new;
end $$;

create or replace function public.tg_cobros_recalcular() returns trigger
language plpgsql security definer set search_path = public as $$
declare fid uuid; cobrado numeric; ultima date;
begin
  if tg_op = 'DELETE' then fid := old.factura_id; else fid := new.factura_id; end if;
  select coalesce(sum(monto), 0), max(fecha) into cobrado, ultima from public.cobros where factura_id = fid;
  update public.facturas f
     set saldo       = f.monto - f.ajuste_previo - cobrado,
         estado      = case when f.estado = 'anulada' then 'anulada'
                            when f.monto - f.ajuste_previo - cobrado <= 0 then 'cobrado' else 'pendiente' end,
         fecha_cobro = case when f.monto - f.ajuste_previo - cobrado <= 0 then ultima else null end
   where f.id = fid;
  -- Promesas de pago de esa factura (o del cliente sin factura) quedan cumplidas
  if tg_op = 'INSERT' then
    update public.cob_promesas p set estado = 'cumplida', cumplida_at = now()
     where p.estado = 'pendiente'
       and (p.factura_id = fid or (p.factura_id is null and p.cliente_id = (select cliente_id from public.facturas where id = fid)));
  end if;
  return null;
end $$;

-- Registro de cambios de fechas (lee el motivo de la sesión, si lo hay)
create or replace function public.tg_hist_fechas() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  ent text := case when tg_table_name = 'facturas' then 'factura' else 'obligacion' end;
  mot text := nullif(current_setting('hist.motivo', true), '');
begin
  if tg_table_name = 'facturas' then
    if new.fecha_vencimiento is distinct from old.fecha_vencimiento then
      insert into public.hist_fechas (entidad, entidad_id, campo, antes, despues, motivo) values (ent, new.id, 'vencimiento', old.fecha_vencimiento, new.fecha_vencimiento, mot);
    end if;
    if new.fecha_estimada_cobro is distinct from old.fecha_estimada_cobro then
      insert into public.hist_fechas (entidad, entidad_id, campo, antes, despues, motivo) values (ent, new.id, 'fecha_estimada', old.fecha_estimada_cobro, new.fecha_estimada_cobro, mot);
    end if;
  else
    if new.vencimiento is distinct from old.vencimiento then
      insert into public.hist_fechas (entidad, entidad_id, campo, antes, despues, motivo) values (ent, new.id, 'vencimiento', old.vencimiento, new.vencimiento, mot);
    end if;
    if new.fecha_estimada_pago is distinct from old.fecha_estimada_pago then
      insert into public.hist_fechas (entidad, entidad_id, campo, antes, despues, motivo) values (ent, new.id, 'fecha_estimada', old.fecha_estimada_pago, new.fecha_estimada_pago, mot);
    end if;
  end if;
  return null;
end $$;
drop trigger if exists facturas_hist on public.facturas;
create trigger facturas_hist after update on public.facturas
  for each row execute function public.tg_hist_fechas();

-- Cambiar la fecha estimada de cobro (queda en el historial con motivo)
create or replace function public.cob_cambiar_fecha(p_factura uuid, p_fecha date, p_motivo text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.tiene_acceso() or public.mi_rol() = 'pendiente' then raise exception 'No tenés permiso.'; end if;
  perform set_config('hist.motivo', coalesce(p_motivo, ''), true);
  update public.facturas set fecha_estimada_cobro = p_fecha where id = p_factura;
  perform set_config('hist.motivo', '', true);
end $$;

-- Ajustar el saldo con lo que dice Sintesys (cobros hechos fuera de la app). No genera movimiento de caja.
create or replace function public.cob_ajustar_sintesys(p_factura uuid, p_saldo numeric, p_motivo text) returns void
language plpgsql as $$
declare f public.facturas; cobrado numeric;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Indicá el motivo del ajuste.'; end if;
  select * into f from public.facturas where id = p_factura for update;
  select coalesce(sum(monto), 0) into cobrado from public.cobros where factura_id = f.id;
  if p_saldo < 0 or p_saldo > f.monto - cobrado then raise exception 'Saldo inválido (entre 0 y %).', f.monto - cobrado; end if;
  perform set_config('cob.ajuste', '1', true);
  update public.facturas set ajuste_previo = f.monto - cobrado - p_saldo where id = f.id;
  perform set_config('cob.ajuste', '', true);
  insert into public.gestiones_cobranza (factura_id, cliente_id, tipo, nota)
  values (f.id, f.cliente_id, 'otro', format('Saldo ajustado con Sintesys: de %s a %s. Motivo: %s', f.saldo, p_saldo, p_motivo));
end $$;

-- Importación del Excel de Sintesys (cuentas a cobrar). No duplica: busca por tipo + número.
create or replace function public.cob_importar_sintesys(p_filas jsonb, p_archivo text default null) returns jsonb
language plpgsql as $$
declare
  lote uuid; r jsonb; f public.facturas; cid uuid; n_new int := 0; n_upd int := 0; n_same int := 0; n_saldadas int := 0;
  errs jsonb := '[]'::jsonb; v_tipo text; v_num text; v_monto numeric; v_saldo numeric; v_venc date; v_emi date; i int := 0;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso para importar.'; end if;
  insert into public.imp_lotes (tipo, archivo, filas) values ('cobrar', p_archivo, jsonb_array_length(p_filas)) returning id into lote;
  perform set_config('imp.sintesys', '1', true);
  for r in select * from jsonb_array_elements(p_filas) loop
    i := i + 1;
    begin
      v_tipo := coalesce(nullif(trim(r->>'tipo_comprobante'), ''), 'Comprobante');
      v_num := trim(r->>'numero');
      v_monto := (r->>'monto')::numeric;
      v_saldo := coalesce((r->>'saldo')::numeric, v_monto);
      v_emi := coalesce((r->>'fecha_emision')::date, (r->>'fecha_vencimiento')::date, public.hoy());
      v_venc := greatest(coalesce((r->>'fecha_vencimiento')::date, v_emi), v_emi);
      if coalesce(v_num, '') = '' then raise exception 'falta el número de comprobante'; end if;
      if v_monto is null or v_monto <= 0 then raise exception 'importe inválido'; end if;
      select * into f from public.facturas where tipo_comprobante = v_tipo and numero = v_num;
      if f.id is not null then
        if (f.vendedor, f.saldo_sintesys, f.fecha_vencimiento) is not distinct from (coalesce(nullif(r->>'vendedor', ''), f.vendedor), v_saldo, v_venc) then
          n_same := n_same + 1;
          update public.facturas set ult_lote = lote where id = f.id;
        else
          perform set_config('hist.motivo', 'Reimportación de Sintesys', true);
          update public.facturas
             set vendedor = coalesce(nullif(r->>'vendedor', ''), vendedor), saldo_sintesys = v_saldo,
                 fecha_vencimiento = greatest(v_venc, fecha_emision), ult_lote = lote
           where id = f.id;
          perform set_config('hist.motivo', '', true);
          n_upd := n_upd + 1;
        end if;
      else
        if v_saldo <= 0 then n_saldadas := n_saldadas + 1; continue; end if;
        cid := nullif(r->>'cliente_id', '')::uuid;
        if cid is null then
          select id into cid from public.clientes where cuit_dni = nullif(regexp_replace(coalesce(r->'cliente_nuevo'->>'cuit', ''), '[^0-9]', '', 'g'), '');
        end if;
        if cid is null then
          if coalesce(trim(r->'cliente_nuevo'->>'razon_social'), '') = '' then raise exception 'falta el cliente'; end if;
          insert into public.clientes (razon_social, cuit_dni, estado, observaciones)
          values (trim(r->'cliente_nuevo'->>'razon_social'), nullif(regexp_replace(coalesce(r->'cliente_nuevo'->>'cuit', ''), '[^0-9]', '', 'g'), ''),
                  'pendiente', 'Creado desde la importación de Sintesys')
          returning id into cid;
        end if;
        insert into public.facturas (cliente_id, tipo_comprobante, numero, fecha_emision, fecha_vencimiento, medio_pago_acordado, monto,
                                     origen, vendedor, ajuste_previo, saldo_sintesys, ult_lote, observaciones)
        values (cid, v_tipo, v_num, v_emi, v_venc, coalesce(nullif(r->>'medio_pago', ''), 'Sin informar'), v_monto,
                'sintesys', nullif(r->>'vendedor', ''), v_monto - v_saldo, v_saldo, lote, nullif(r->>'observaciones', ''));
        n_new := n_new + 1;
      end if;
    exception when others then
      errs := errs || jsonb_build_object('fila', coalesce((r->>'fila')::int, i), 'comprobante', concat_ws(' ', v_tipo, v_num), 'error', sqlerrm);
    end;
  end loop;
  perform set_config('imp.sintesys', '', true);
  update public.imp_lotes set nuevas = n_new, actualizadas = n_upd, sin_cambios = n_same, errores = errs where id = lote;
  return jsonb_build_object('lote', lote, 'nuevas', n_new, 'actualizadas', n_upd, 'sin_cambios', n_same, 'saldadas', n_saldadas, 'errores', errs);
end $$;

-- ---------- Promesas de pago ----------
create table if not exists public.cob_promesas (
  id           uuid primary key default gen_random_uuid(),
  cliente_id   uuid not null references public.clientes(id),
  factura_id   uuid references public.facturas(id) on delete cascade,
  fecha_promesa date not null,
  monto        numeric(14,2),
  nota         text,
  estado       text not null default 'pendiente' check (estado in ('pendiente','cumplida','cancelada')),
  cumplida_at  timestamptz,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid() references public.perfiles(id)
);
create index if not exists cob_promesas_idx on public.cob_promesas (estado, fecha_promesa);

-- Registrar una promesa: también mueve la fecha estimada de cobro (con historial)
create or replace function public.cob_registrar_promesa(p jsonb) returns uuid
language plpgsql as $$
declare pid uuid; fid uuid := nullif(p->>'factura_id', '')::uuid; cid uuid;
begin
  if not public.tiene_acceso() or public.mi_rol() = 'pendiente' then raise exception 'No tenés permiso.'; end if;
  if (p->>'fecha_promesa') is null then raise exception 'Indicá la fecha que prometió pagar.'; end if;
  cid := coalesce(nullif(p->>'cliente_id', '')::uuid, (select cliente_id from public.facturas where id = fid));
  insert into public.cob_promesas (cliente_id, factura_id, fecha_promesa, monto, nota)
  values (cid, fid, (p->>'fecha_promesa')::date, nullif(p->>'monto', '')::numeric, nullif(p->>'nota', ''))
  returning id into pid;
  if fid is not null then
    perform public.cob_cambiar_fecha(fid, (p->>'fecha_promesa')::date, 'Promesa de pago' || coalesce(': ' || nullif(p->>'nota', ''), ''));
  end if;
  insert into public.gestiones_cobranza (factura_id, cliente_id, tipo, nota)
  values (fid, cid, 'respuesta_cliente', format('Promesa de pago para el %s%s%s', to_char((p->>'fecha_promesa')::date, 'DD/MM/YYYY'),
          coalesce(' por $ ' || (p->>'monto'), ''), coalesce('. ' || nullif(p->>'nota', ''), '')));
  return pid;
end $$;

-- ---------- Pagos informados por el cliente (no tocan saldos hasta confirmarse) ----------
create table if not exists public.cob_pagos_informados (
  id            uuid primary key default gen_random_uuid(),
  cliente_id    uuid not null references public.clientes(id),
  factura_id    uuid references public.facturas(id),   -- factura sugerida (la imputación final se elige al confirmar)
  fecha         date not null default public.hoy(),
  monto         numeric(14,2) not null check (monto > 0),
  medio         text not null default 'transferencia',
  referencia    text,
  nota          text,
  estado        text not null default 'pendiente_validacion' check (estado in ('pendiente_validacion','confirmado','rechazado')),
  motivo        text,
  imputaciones  jsonb,
  validado_por  uuid references public.perfiles(id),
  validado_at   timestamptz,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid() references public.perfiles(id)
);
create index if not exists cob_pi_idx on public.cob_pagos_informados (estado);

-- Confirmar: imputa a las facturas y entra a Caja y Bancos (un movimiento por factura)
create or replace function public.cob_confirmar_pago(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare pi public.cob_pagos_informados; x jsonb; total numeric := 0; n int;
begin
  if not public.puede_editar() then raise exception 'Solo Administración o Gerencia confirman pagos.'; end if;
  select * into pi from public.cob_pagos_informados where id = p_id for update;
  if pi.estado <> 'pendiente_validacion' then raise exception 'Ese pago ya está %.', pi.estado; end if;
  n := jsonb_array_length(coalesce(p->'imputaciones', '[]'::jsonb));
  if n = 0 then raise exception 'Elegí a qué factura(s) se imputa.'; end if;
  if coalesce(p->>'medio', pi.medio) in ('cheque','echeq') and n > 1 then raise exception 'Un cheque se imputa a una sola factura.'; end if;
  for x in select * from jsonb_array_elements(p->'imputaciones') loop
    total := total + (x->>'monto')::numeric;
    if (select cliente_id from public.facturas where id = (x->>'factura_id')::uuid) is distinct from pi.cliente_id then
      raise exception 'Hay una factura que no es de este cliente.';
    end if;
    perform public.tes_registrar_cobro(jsonb_build_object(
      'factura_id', x->>'factura_id', 'monto', x->>'monto', 'fecha', coalesce(p->>'fecha', pi.fecha::text),
      'medio', coalesce(p->>'medio', pi.medio), 'cuenta_id', p->>'cuenta_id', 'referencia', coalesce(pi.referencia, 'Pago informado'),
      'observaciones', 'Pago informado por el cliente y validado', 'cheque', p->'cheque'));
  end loop;
  if total > pi.monto + 0.004 then raise exception 'Lo imputado (%) supera lo informado (%).', total, pi.monto; end if;
  update public.cob_pagos_informados
     set estado = 'confirmado', imputaciones = p->'imputaciones', validado_por = auth.uid(), validado_at = now(),
         motivo = case when total < pi.monto then format('Se imputaron %s de %s', total, pi.monto) end
   where id = pi.id;
end $$;

-- =====================================================================
--  CUENTAS A PAGAR
-- =====================================================================
create table if not exists public.pag_obligaciones (
  id                  uuid primary key default gen_random_uuid(),
  origen              text not null default 'manual' check (origen in ('manual','sintesys')),
  clave               text unique,                          -- evita duplicar al reimportar (proveedor|comprobante|cuota)
  tipo                text not null default 'proveedor' check (tipo in ('proveedor','sueldos','alquiler','servicios','impuestos','gastos','cheque','prestamo','otro')),
  proveedor           text not null,
  cuit                text,
  categoria_id        uuid references public.tes_categorias(id),
  comprobante         text,
  concepto            text,
  fecha_emision       date,
  vencimiento         date,
  vencimiento_original date,
  fecha_estimada_pago date,
  importe             numeric(14,2) not null check (importe > 0),
  ajuste_previo       numeric(14,2) not null default 0,     -- pagado antes de pasar a la app (según Sintesys)
  pagado              numeric(14,2) not null default 0,
  saldo               numeric(14,2) not null default 0,
  saldo_sintesys      numeric(14,2),
  prioridad           text not null default 'media' check (prioridad in ('alta','media','baja')),
  estado              text not null default 'pendiente_decision' check (estado in
                        ('pendiente_revision','pendiente_decision','autorizado','programado','reprogramado','pagado','cancelado')),
  cuenta_id           uuid references public.tes_cuentas(id),  -- de dónde se piensa pagar
  medio_previsto      text,
  plan_id             uuid,
  cuota               int,
  cuotas              int,
  observaciones       text,
  motivo              text,
  decidido_por        uuid references public.perfiles(id),
  decidido_at         timestamptz,
  ult_lote            uuid references public.imp_lotes(id),
  created_at          timestamptz not null default now(),
  created_by          uuid default auth.uid() references public.perfiles(id),
  updated_at          timestamptz not null default now(),
  updated_by          uuid default auth.uid() references public.perfiles(id)
);
create index if not exists pag_obl_estado_idx on public.pag_obligaciones (estado, fecha_estimada_pago, vencimiento);
create index if not exists pag_obl_plan_idx on public.pag_obligaciones (plan_id);

alter table public.tes_movimientos add column if not exists obligacion_id uuid references public.pag_obligaciones(id);
create index if not exists tes_mov_obl_idx on public.tes_movimientos (obligacion_id);

create or replace function public.tg_pag_reglas() returns trigger
language plpgsql security definer set search_path = public as $$
declare imp boolean := coalesce(current_setting('imp.sintesys', true), '') = '1';
  sis boolean := coalesce(current_setting('pag.recalc', true), '') = '1';
begin
  if tg_op = 'INSERT' then
    new.vencimiento_original := new.vencimiento;
    new.pagado := 0;
    new.ajuste_previo := greatest(0, least(coalesce(new.ajuste_previo, 0), new.importe));
    new.saldo := new.importe - new.ajuste_previo;
    if new.estado in ('autorizado','programado','reprogramado') and not public.es_gerencia() then
      raise exception 'Solo los dueños (Gerencia) deciden qué se paga.';
    end if;
    if new.estado = 'pagado' or new.saldo <= 0 then new.estado := 'pagado'; end if;
    if new.estado in ('autorizado','programado','reprogramado') then new.decidido_por := auth.uid(); new.decidido_at := now(); end if;
    return new;
  end if;
  new.vencimiento_original := old.vencimiento_original;
  if sis then return new; end if;   -- recálculo automático de pagos
  if new.estado is distinct from old.estado then
    if new.estado = 'pagado' then raise exception 'El estado "Pagado" lo pone el sistema cuando se registran los pagos.'; end if;
    if old.estado = 'pagado' and not public.es_gerencia() then raise exception 'Ya está pagada.'; end if;
    if new.estado in ('autorizado','programado','cancelado') and old.estado not in ('autorizado','programado','reprogramado')
       and not public.es_gerencia() then
      raise exception 'Solo los dueños (Gerencia) deciden qué se paga, se programa o se cancela.';
    end if;
    if new.estado = 'cancelado' and not public.es_gerencia() then raise exception 'Solo Gerencia cancela obligaciones.'; end if;
    if new.estado = 'cancelado' and coalesce(trim(new.motivo), '') = '' then raise exception 'Indicá el motivo de la cancelación.'; end if;
    if new.estado = 'cancelado' and new.pagado > 0 then raise exception 'Tiene pagos registrados: no se puede cancelar.'; end if;
    if new.estado in ('autorizado','programado') then new.decidido_por := auth.uid(); new.decidido_at := now(); end if;
  end if;
  -- Si Administración cambia el importe de algo ya decidido, vuelve a decisión
  if new.importe is distinct from old.importe then
    if new.importe < old.pagado + old.ajuste_previo then raise exception 'El importe no puede ser menor a lo ya pagado.'; end if;
    new.saldo := new.importe - new.ajuste_previo - new.pagado;
    if old.estado in ('autorizado','programado','reprogramado') and not public.es_gerencia() and not imp then
      new.estado := 'pendiente_decision'; new.decidido_por := null; new.decidido_at := null;
    end if;
  end if;
  -- Cambio de fecha estimada sobre algo decidido: queda "Reprogramado" (sigue autorizado)
  if new.fecha_estimada_pago is distinct from old.fecha_estimada_pago and old.estado in ('autorizado','programado')
     and new.estado = old.estado and old.fecha_estimada_pago is not null then
    new.estado := 'reprogramado';
  end if;
  if new.vencimiento is distinct from old.vencimiento and not public.es_gerencia() and not imp then
    raise exception 'El vencimiento lo cambia Gerencia o la reimportación de Sintesys. Para mover el pago, cambiá la fecha estimada.';
  end if;
  return new;
end $$;
drop trigger if exists pag_reglas on public.pag_obligaciones;
create trigger pag_reglas before insert or update on public.pag_obligaciones for each row execute function public.tg_pag_reglas();
drop trigger if exists pag_updated on public.pag_obligaciones;
create trigger pag_updated before update on public.pag_obligaciones for each row execute function public.tg_updated();
drop trigger if exists pag_audit on public.pag_obligaciones;
create trigger pag_audit after insert or update or delete on public.pag_obligaciones for each row execute function public.tg_auditoria();
drop trigger if exists pag_hist on public.pag_obligaciones;
create trigger pag_hist after update on public.pag_obligaciones for each row execute function public.tg_hist_fechas();

-- Recalcula lo pagado: cuenta lo realizado y los cheques entregados (la deuda con el proveedor queda saldada)
create or replace function public.pag_recalcular(p_obl uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o public.pag_obligaciones; pag numeric;
begin
  select * into o from public.pag_obligaciones where id = p_obl for update;
  if o.id is null then return; end if;
  select coalesce(sum(importe), 0) into pag from public.tes_movimientos
   where obligacion_id = p_obl and estado <> 'anulado' and (estado = 'realizado' or cheque_id is not null);
  perform set_config('pag.recalc', '1', true);
  update public.pag_obligaciones
     set pagado = pag, saldo = importe - ajuste_previo - pag,
         estado = case when importe - ajuste_previo - pag <= 0 then 'pagado'
                       when estado = 'pagado' then 'autorizado' else estado end
   where id = p_obl;
  perform set_config('pag.recalc', '', true);
end $$;

create or replace function public.tg_tes_mov_obl() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE','DELETE') and old.obligacion_id is not null then perform public.pag_recalcular(old.obligacion_id); end if;
  if tg_op in ('INSERT','UPDATE') and new.obligacion_id is not null then
    perform public.pag_recalcular(new.obligacion_id);
  end if;
  return null;
end $$;
drop trigger if exists tes_mov_obl on public.tes_movimientos;
create trigger tes_mov_obl after insert or update or delete on public.tes_movimientos for each row execute function public.tg_tes_mov_obl();

-- Un cheque emitido para una obligación que se rechaza o anula: el pago se anula y la deuda vuelve
create or replace function public.tg_tes_mov_a_obl() returns trigger
language plpgsql as $$
begin
  if new.obligacion_id is not null and old.cheque_id is not null and new.cheque_id is null and new.estado <> 'anulado' then
    new.estado := 'anulado';
    new.motivo_anulacion := coalesce(nullif(new.observaciones, ''), 'Cheque rechazado o anulado');
  end if;
  return new;
end $$;
drop trigger if exists tes_mov_a_obl on public.tes_movimientos;
create trigger tes_mov_a_obl before update on public.tes_movimientos for each row execute function public.tg_tes_mov_a_obl();

-- Registrar un pago (total o parcial) de una obligación decidida. Crea el egreso en Caja y Bancos.
create or replace function public.pag_registrar_pago(p_obl uuid, p jsonb) returns uuid
language plpgsql as $$
declare
  o public.pag_obligaciones; imp numeric := (p->>'importe')::numeric; v_medio text := coalesce(p->>'medio', 'transferencia');
  v_cuenta uuid := nullif(p->>'cuenta_id', '')::uuid; f date := coalesce((p->>'fecha')::date, public.hoy());
  ch jsonb := p->'cheque'; chq uuid; mid uuid; cat uuid;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  select * into o from public.pag_obligaciones where id = p_obl for update;
  if o.id is null then raise exception 'Obligación inexistente.'; end if;
  if o.estado not in ('autorizado','programado','reprogramado') then
    raise exception 'Todavía no está autorizada por los dueños (estado: %). El sistema no paga nada sin decisión.', o.estado;
  end if;
  if imp is null or imp <= 0 then raise exception 'Importe inválido.'; end if;
  if imp > o.saldo + 0.004 then raise exception 'El pago (%) supera el saldo pendiente (%).', imp, o.saldo; end if;
  if v_cuenta is null and v_medio <> 'endoso' then raise exception 'Elegí la cuenta de donde sale.'; end if;
  cat := coalesce(o.categoria_id, (select id from public.tes_categorias where tipo = 'egreso' and rubro = 'Proveedores' order by orden limit 1));
  perform set_config('tes.bypass_aut', '1', true);
  if v_medio in ('cheque','echeq') then
    if coalesce(ch->>'numero', '') = '' or coalesce(ch->>'fecha_pago', '') = '' then raise exception 'Cargá número y fecha de pago del cheque.'; end if;
    insert into public.tes_cheques (sentido, formato, numero, banco, contraparte, cuit, importe, fecha_emision, fecha_pago, cuenta_id, estado)
    values ('emitido', case when v_medio = 'echeq' then 'echeq' else 'fisico' end, ch->>'numero', nullif(ch->>'banco', ''), o.proveedor, o.cuit, imp,
            coalesce(nullif(ch->>'fecha_emision', '')::date, f), (ch->>'fecha_pago')::date, v_cuenta, 'emitido')
    returning id into chq;
    insert into public.tes_movimientos (fecha, tipo, sentido, categoria_id, concepto, contraparte, medio, cuenta_id, importe, fecha_prevista, estado, comprobante, cheque_id, obligacion_id)
    values (f, 'egreso', 'salida', cat, coalesce(o.concepto, o.comprobante, 'Pago') , o.proveedor, v_medio, v_cuenta, imp, greatest((ch->>'fecha_pago')::date, f), 'autorizado',
            coalesce(nullif(p->>'comprobante', ''), format('%s N° %s', case when v_medio = 'echeq' then 'E-cheq' else 'Cheque' end, ch->>'numero')), chq, o.id)
    returning id into mid;
  else
    if coalesce(trim(p->>'comprobante'), '') = '' then raise exception 'Cargá el comprobante u orden de pago.'; end if;
    insert into public.tes_movimientos (fecha, tipo, sentido, categoria_id, concepto, contraparte, medio, cuenta_id, importe, fecha_prevista, fecha_efectiva, estado, comprobante, observaciones, obligacion_id)
    values (f, 'egreso', 'salida', cat, coalesce(o.concepto, o.comprobante, 'Pago'), o.proveedor, v_medio, v_cuenta, imp, f, f, 'realizado',
            p->>'comprobante', nullif(p->>'observaciones', ''), o.id)
    returning id into mid;
  end if;
  perform set_config('tes.bypass_aut', '', true);
  return mid;
end $$;

-- Cambiar la fecha estimada de pago (con motivo, queda en el historial)
create or replace function public.pag_cambiar_fecha(p_obl uuid, p_fecha date, p_motivo text) returns void
language plpgsql as $$
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  perform set_config('hist.motivo', coalesce(p_motivo, ''), true);
  update public.pag_obligaciones set fecha_estimada_pago = p_fecha where id = p_obl;
  perform set_config('hist.motivo', '', true);
end $$;

-- Importación de cuentas a pagar de Sintesys. No duplica: usa la clave proveedor|comprobante.
create or replace function public.pag_importar_sintesys(p_filas jsonb, p_archivo text default null) returns jsonb
language plpgsql as $$
declare
  lote uuid; r jsonb; o public.pag_obligaciones; n_new int := 0; n_upd int := 0; n_same int := 0; n_saldadas int := 0;
  errs jsonb := '[]'::jsonb; v_imp numeric; v_saldo numeric; v_venc date; i int := 0;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso para importar.'; end if;
  insert into public.imp_lotes (tipo, archivo, filas) values ('pagar', p_archivo, jsonb_array_length(p_filas)) returning id into lote;
  perform set_config('imp.sintesys', '1', true);
  for r in select * from jsonb_array_elements(p_filas) loop
    i := i + 1;
    begin
      if coalesce(r->>'clave', '') = '' then raise exception 'falta proveedor o comprobante'; end if;
      v_imp := (r->>'importe')::numeric;
      v_saldo := coalesce((r->>'saldo')::numeric, v_imp);
      v_venc := (r->>'vencimiento')::date;
      if v_imp is null or v_imp <= 0 then raise exception 'importe inválido'; end if;
      select * into o from public.pag_obligaciones where clave = r->>'clave';
      if o.id is not null then
        if (o.saldo_sintesys, o.vencimiento) is not distinct from (v_saldo, coalesce(v_venc, o.vencimiento)) then
          n_same := n_same + 1;
          update public.pag_obligaciones set ult_lote = lote where id = o.id;
        else
          perform set_config('hist.motivo', 'Reimportación de Sintesys', true);
          update public.pag_obligaciones set saldo_sintesys = v_saldo, vencimiento = coalesce(v_venc, vencimiento), ult_lote = lote where id = o.id;
          perform set_config('hist.motivo', '', true);
          n_upd := n_upd + 1;
        end if;
      else
        if v_saldo <= 0 then n_saldadas := n_saldadas + 1; continue; end if;
        insert into public.pag_obligaciones (origen, clave, tipo, proveedor, cuit, categoria_id, comprobante, concepto, fecha_emision, vencimiento,
                                            importe, ajuste_previo, saldo_sintesys, estado, ult_lote)
        values ('sintesys', r->>'clave', coalesce(nullif(r->>'tipo', ''), 'proveedor'), trim(r->>'proveedor'),
                nullif(regexp_replace(coalesce(r->>'cuit', ''), '[^0-9]', '', 'g'), ''), nullif(r->>'categoria_id', '')::uuid,
                nullif(r->>'comprobante', ''), nullif(r->>'concepto', ''), (r->>'fecha_emision')::date, v_venc,
                v_imp, v_imp - v_saldo, v_saldo, 'pendiente_revision', lote);
        n_new := n_new + 1;
      end if;
    exception when others then
      errs := errs || jsonb_build_object('fila', coalesce((r->>'fila')::int, i), 'comprobante', concat_ws(' ', r->>'proveedor', r->>'comprobante'), 'error', sqlerrm);
    end;
  end loop;
  perform set_config('imp.sintesys', '', true);
  update public.imp_lotes set nuevas = n_new, actualizadas = n_upd, sin_cambios = n_same, errores = errs where id = lote;
  return jsonb_build_object('lote', lote, 'nuevas', n_new, 'actualizadas', n_upd, 'sin_cambios', n_same, 'saldadas', n_saldadas, 'errores', errs);
end $$;

-- =====================================================================
--  CAJA Y BANCOS · ajustes
-- =====================================================================
alter table public.tes_cuentas add column if not exists reserva_minima numeric(14,2) not null default 0;
alter table public.tes_cuentas add column if not exists cobro_default  boolean not null default false;
alter table public.tes_cuentas add column if not exists pago_default   boolean not null default false;
update public.tes_cuentas set cobro_default = true, pago_default = true
 where codigo = 'galicia' and not exists (select 1 from public.tes_cuentas where cobro_default or pago_default);
drop trigger if exists tes_cuentas_audit on public.tes_cuentas;
create trigger tes_cuentas_audit after insert or update on public.tes_cuentas for each row execute function public.tg_auditoria();

-- Reserva mínima y cuentas por defecto (las configura Administración)
create or replace function public.tes_config_cuenta(p_cuenta uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  if p ? 'reserva_minima' then
    if (p->>'reserva_minima')::numeric < 0 then raise exception 'La reserva no puede ser negativa.'; end if;
    update public.tes_cuentas set reserva_minima = (p->>'reserva_minima')::numeric where id = p_cuenta;
  end if;
  if coalesce((p->>'cobro_default')::boolean, false) then
    update public.tes_cuentas set cobro_default = (id = p_cuenta);
  end if;
  if coalesce((p->>'pago_default')::boolean, false) then
    update public.tes_cuentas set pago_default = (id = p_cuenta);
  end if;
end $$;

-- Transferencia propia con fecha de salida y de acreditación (pueden ser distintas o futuras)
create or replace function public.tes_transferir(p jsonb) returns uuid
language plpgsql as $$
declare
  tid uuid := gen_random_uuid();
  o uuid := (p->>'origen')::uuid;
  d uuid := (p->>'destino')::uuid;
  imp numeric := (p->>'importe')::numeric;
  f date := coalesce((p->>'fecha')::date, public.hoy());
  fs date := coalesce((p->>'fecha_salida')::date, (p->>'fecha_efectiva')::date, f);
  fa date := coalesce((p->>'fecha_acreditacion')::date, fs);
  v_concepto text := coalesce(nullif(trim(p->>'concepto'), ''), 'Transferencia entre cuentas');
  v_medio text := coalesce(p->>'medio', 'transferencia');
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  if o is null or d is null or o = d then raise exception 'Elegí cuenta de origen y de destino distintas.'; end if;
  if imp is null or imp <= 0 then raise exception 'Importe inválido.'; end if;
  if fa < fs then raise exception 'La acreditación no puede ser antes de la salida.'; end if;
  insert into public.tes_movimientos (fecha, tipo, sentido, concepto, medio, cuenta_id, transferencia_id, importe, fecha_prevista, fecha_efectiva, estado, comprobante, observaciones)
  values (f, 'transferencia', 'salida', v_concepto, v_medio, o, tid, imp, fs, case when fs <= public.hoy() then fs end,
          case when fs <= public.hoy() then 'realizado' else 'pendiente' end, p->>'comprobante', p->>'observaciones'),
         (f, 'transferencia', 'entrada', v_concepto, v_medio, d, tid, imp, fa, case when fa <= public.hoy() then fa end,
          case when fa <= public.hoy() then 'realizado' else 'pendiente' end, p->>'comprobante', p->>'observaciones');
  return tid;
end $$;

-- Confirmar la salida o la acreditación de una transferencia que estaba pendiente
create or replace function public.tes_confirmar_transferencia(p_mov uuid, p_fecha date default null) returns void
language plpgsql as $$
declare m public.tes_movimientos;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  select * into m from public.tes_movimientos where id = p_mov for update;
  if m.tipo <> 'transferencia' or m.estado <> 'pendiente' then raise exception 'Solo se confirman patas de transferencia pendientes.'; end if;
  perform set_config('tes.bypass_aut', '1', true);
  update public.tes_movimientos set estado = 'realizado', fecha_efectiva = coalesce(p_fecha, public.hoy()) where id = m.id;
  perform set_config('tes.bypass_aut', '', true);
end $$;

-- Simulaciones de transferencias (no tocan saldos ni crean movimientos)
create table if not exists public.tes_simulaciones (
  id                  uuid primary key default gen_random_uuid(),
  origen              uuid not null references public.tes_cuentas(id),
  destino             uuid not null references public.tes_cuentas(id),
  importe             numeric(14,2) not null check (importe > 0),
  fecha_salida        date not null,
  fecha_acreditacion  date not null,
  nota                text,
  estado              text not null default 'activa' check (estado in ('activa','descartada','confirmada')),
  transferencia_id    uuid,
  created_at          timestamptz not null default now(),
  created_by          uuid default auth.uid() references public.perfiles(id),
  check (origen <> destino),
  check (fecha_acreditacion >= fecha_salida)
);

create or replace function public.tes_confirmar_simulacion(p_sim uuid) returns uuid
language plpgsql as $$
declare s public.tes_simulaciones; tid uuid;
begin
  if not public.es_gerencia() then raise exception 'Solo la persona autorizada (Gerencia) confirma una transferencia simulada. Administración puede cargar la transferencia real en Tesorería.'; end if;
  select * into s from public.tes_simulaciones where id = p_sim for update;
  if s.estado <> 'activa' then raise exception 'Esa simulación ya está %.', s.estado; end if;
  tid := public.tes_transferir(jsonb_build_object('origen', s.origen, 'destino', s.destino, 'importe', s.importe, 'fecha', public.hoy(),
         'fecha_salida', s.fecha_salida, 'fecha_acreditacion', s.fecha_acreditacion, 'concepto', coalesce(s.nota, 'Transferencia preventiva (simulada y confirmada)')));
  update public.tes_simulaciones set estado = 'confirmada', transferencia_id = tid where id = s.id;
  return tid;
end $$;

-- Permisos de la migración 08
alter table public.hist_fechas          enable row level security;
alter table public.imp_lotes            enable row level security;
alter table public.cob_promesas         enable row level security;
alter table public.cob_pagos_informados enable row level security;
alter table public.pag_obligaciones     enable row level security;
alter table public.tes_simulaciones     enable row level security;

drop policy if exists hist_sel on public.hist_fechas;
create policy hist_sel on public.hist_fechas for select to authenticated using (public.tiene_acceso());
drop policy if exists hist_ins on public.hist_fechas;
create policy hist_ins on public.hist_fechas for insert to authenticated with check (public.tiene_acceso());

drop policy if exists lotes_sel on public.imp_lotes;
create policy lotes_sel on public.imp_lotes for select to authenticated using (public.tiene_acceso());
drop policy if exists lotes_ins on public.imp_lotes;
create policy lotes_ins on public.imp_lotes for insert to authenticated with check (public.puede_editar());
drop policy if exists lotes_upd on public.imp_lotes;
create policy lotes_upd on public.imp_lotes for update to authenticated using (public.puede_editar());

-- Promesas y pagos informados: Ventas también los carga (gestión comercial)
drop policy if exists prom_sel on public.cob_promesas;
create policy prom_sel on public.cob_promesas for select to authenticated using (public.tiene_acceso());
drop policy if exists prom_ins on public.cob_promesas;
create policy prom_ins on public.cob_promesas for insert to authenticated with check (public.tiene_acceso());
drop policy if exists prom_upd on public.cob_promesas;
create policy prom_upd on public.cob_promesas for update to authenticated using (public.tiene_acceso()) with check (public.tiene_acceso());

drop policy if exists pi_sel on public.cob_pagos_informados;
create policy pi_sel on public.cob_pagos_informados for select to authenticated using (public.tiene_acceso());
drop policy if exists pi_ins on public.cob_pagos_informados;
create policy pi_ins on public.cob_pagos_informados for insert to authenticated with check (public.tiene_acceso() and estado = 'pendiente_validacion');
drop policy if exists pi_upd on public.cob_pagos_informados;
create policy pi_upd on public.cob_pagos_informados for update to authenticated using (public.puede_editar()) with check (public.puede_editar());

drop policy if exists pag_sel on public.pag_obligaciones;
create policy pag_sel on public.pag_obligaciones for select to authenticated using (public.puede_editar());
drop policy if exists pag_ins on public.pag_obligaciones;
create policy pag_ins on public.pag_obligaciones for insert to authenticated with check (public.puede_editar());
drop policy if exists pag_upd on public.pag_obligaciones;
create policy pag_upd on public.pag_obligaciones for update to authenticated using (public.puede_editar()) with check (public.puede_editar());

drop policy if exists sim_all on public.tes_simulaciones;
create policy sim_all on public.tes_simulaciones for all to authenticated using (public.puede_editar()) with check (public.puede_editar());


-- =====================================================================
-- Migración 10 · Tipos de comprobante de venta + edición de cheques emitidos
-- Correr DESPUÉS de las migraciones 02 a 09. Se puede correr más de una vez.
-- No borra ni cambia el sentido de ningún dato existente.
--
-- 1) facturas.tipo: factura_a, nota_credito_a, nota_debito_a, factura_b,
--    nota_credito_b, nota_debito_b, presupuesto, anula_presupuesto.
--    facturas.signo (calculada): +1 suman a la deuda / totales, −1 restan
--    (notas de crédito y anula presupuesto). monto y saldo siguen siempre positivos.
--    Los comprobantes que ya existían se clasifican por su texto (tipo_comprobante):
--    "Factura A/B/E", "Nota de débito A/B", "Remito / Presupuesto"… todos suman,
--    igual que antes, así que ningún total cambia.
-- 2) Las notas de crédito no se "cobran": se imputan contra una factura del
--    mismo cliente (cob_imputar_credito). No entra plata a Caja.
-- 3) v_clientes_saldos: saldo con signo (las NC restan).
-- 4) Importación de Sintesys: reconoce NC/ND/presupuestos y los importes negativos.
-- 5) tes_cheque_editar: corrige un cheque emitido con las mismas validaciones
--    del alta y actualiza el pago vinculado.
-- =====================================================================

-- ---------- 1. Tipo de comprobante -----------------------------------
alter table public.facturas add column if not exists tipo text;

-- Clasifica un texto libre (lo que cargaba la app o trae Sintesys). Misma lógica que lib/comprobantes.ts
create or replace function public.factura_tipo_de(p_texto text, p_negativo boolean default false) returns text
language plpgsql immutable set search_path = public as $$
declare
  t text := upper(translate(coalesce(p_texto, ''), 'áéíóúÁÉÍÓÚüÜ', 'aeiouAEIOUuU'));
  clase text;
  letra text;
begin
  if lower(trim(coalesce(p_texto, ''))) in ('factura_a','nota_credito_a','nota_debito_a','factura_b','nota_credito_b','nota_debito_b','presupuesto','anula_presupuesto') then
    return lower(trim(p_texto));
  end if;
  if t ~ 'ANULA' and t ~ 'PRESUP' then clase := 'anula_presupuesto';
  elsif t ~ 'PRESUP|REMITO|(^|[^A-Z])X($|[^A-Z])' then clase := 'presupuesto';
  elsif t ~ 'NOTA\s+DE\s+CRED|(^|[^A-Z])N/?C[ABCEM]?($|[^A-Z])|(^|[^A-Z])NCE?($|[^A-Z])' then clase := 'nota_credito';
  elsif t ~ 'NOTA\s+DE\s+DEB|(^|[^A-Z])N/?D[ABCEM]?($|[^A-Z])|(^|[^A-Z])NDE?($|[^A-Z])' then clase := 'nota_debito';
  else clase := 'factura';
  end if;
  if coalesce(p_negativo, false) then
    if clase = 'presupuesto' then clase := 'anula_presupuesto';
    elsif clase in ('factura','nota_debito') then clase := 'nota_credito';
    end if;
  end if;
  if clase in ('presupuesto','anula_presupuesto') then return clase; end if;
  letra := (regexp_match(t, '(?:^|[^A-Z/])(?:FCE|FC|FAC|FA|NCE|NC|NDE|ND|N/C|N/D)?\s*([ABCEM])(?:[^A-Z]|$)'))[1];
  return clase || '_' || case when letra in ('B','C','E') then 'b' else 'a' end;
end $$;

-- Comprobantes existentes: se clasifican por el texto (sin disparar triggers: no cambia updated_at ni la auditoría)
do $$
begin
  if exists (select 1 from public.facturas where tipo is null) then
    alter table public.facturas disable trigger user;
    update public.facturas set tipo = public.factura_tipo_de(tipo_comprobante) where tipo is null;
    alter table public.facturas enable trigger user;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'facturas_tipo_chk') then
    alter table public.facturas add constraint facturas_tipo_chk
      check (tipo in ('factura_a','nota_credito_a','nota_debito_a','factura_b','nota_credito_b','nota_debito_b','presupuesto','anula_presupuesto'));
  end if;
end $$;
alter table public.facturas alter column tipo set not null;

alter table public.facturas add column if not exists signo smallint
  generated always as (case when tipo in ('nota_credito_a','nota_credito_b','anula_presupuesto') then -1 else 1 end) stored;

create index if not exists facturas_tipo_idx on public.facturas (tipo);

comment on column public.facturas.tipo  is 'Tipo de comprobante de venta. Facturas, notas de débito y presupuestos suman; notas de crédito y anula presupuesto restan.';
comment on column public.facturas.signo is '+1 suma a la deuda del cliente y a los totales · −1 resta (NC / anula presupuesto). monto y saldo son siempre positivos.';

-- Reglas de facturas (versión de la migración 08 + tipo)
create or replace function public.tg_facturas_reglas() returns trigger
language plpgsql security definer set search_path = public as $$
declare est text;
  imp boolean := coalesce(current_setting('imp.sintesys', true), '') = '1';
begin
  if tg_op = 'INSERT' then
    new.tipo := coalesce(nullif(lower(trim(new.tipo)), ''), public.factura_tipo_de(new.tipo_comprobante));
    select estado into est from public.clientes where id = new.cliente_id;
    -- Lo que viene de Sintesys ya está facturado oficialmente: no se bloquea por el estado del cliente
    if est is distinct from 'activo' and new.origen <> 'sintesys' then
      raise exception 'El cliente no está habilitado para facturación (A01/A03). Validalo primero.';
    end if;
    if new.origen <> 'sintesys' then new.ajuste_previo := 0; end if;
    new.ajuste_previo := greatest(0, least(coalesce(new.ajuste_previo, 0), new.monto));
    new.saldo  := new.monto - new.ajuste_previo;
    new.estado := case when new.saldo <= 0 then 'cobrado' else 'pendiente' end;
    new.fecha_cobro := null;
    new.vencimiento_original := new.fecha_vencimiento;
  else
    new.tipo := coalesce(nullif(lower(trim(new.tipo)), ''), old.tipo, public.factura_tipo_de(new.tipo_comprobante));
    -- El vencimiento original no se pierde nunca
    new.vencimiento_original := old.vencimiento_original;
    -- A05: no cambiar fechas ni medio de pago sin autorización (solo Gerencia, o la reimportación de Sintesys)
    if (new.fecha_vencimiento   is distinct from old.fecha_vencimiento
     or new.medio_pago_acordado is distinct from old.medio_pago_acordado
     or new.monto               is distinct from old.monto
     or new.cliente_id          is distinct from old.cliente_id)
     and not public.es_gerencia() and not imp then
      raise exception 'Cambiar vencimiento, monto, cliente o medio de pago requiere autorización de Gerencia (A05).';
    end if;
    -- Cambiar el tipo da vuelta el signo (suma ↔ resta): solo Gerencia
    if old.tipo is not null and new.tipo is distinct from old.tipo and not public.es_gerencia() then
      raise exception 'Cambiar el tipo de comprobante requiere autorización de Gerencia.';
    end if;
    if new.ajuste_previo is distinct from old.ajuste_previo and coalesce(current_setting('cob.ajuste', true), '') <> '1' and not imp then
      raise exception 'El ajuste de saldo se hace desde "Ajustar con Sintesys", con motivo.';
    end if;
    if new.estado = 'anulada' and old.estado <> 'anulada' and not public.es_gerencia() then
      raise exception 'Solo Gerencia puede anular comprobantes.';
    end if;
    if new.monto is distinct from old.monto or new.ajuste_previo is distinct from old.ajuste_previo then
      new.saldo := new.monto - new.ajuste_previo - coalesce((select sum(monto) from public.cobros where factura_id = new.id), 0);
      if new.estado <> 'anulada' then new.estado := case when new.saldo <= 0 then 'cobrado' else 'pendiente' end; end if;
    end if;
  end if;
  return new;
end $$;

-- ---------- 2. Cobros e imputación de créditos ------------------------
create or replace function public.tg_cobros_validar() returns trigger
language plpgsql set search_path = public as $$
declare f public.facturas;
begin
  select * into f from public.facturas where id = new.factura_id for update;
  if f.estado = 'anulada' then raise exception 'La factura está anulada'; end if;
  if f.signo < 0 and coalesce(current_setting('cob.imputacion', true), '') <> '1' then
    raise exception 'Las notas de crédito y las anulaciones de presupuesto no se cobran: se imputan contra una factura del cliente.';
  end if;
  if new.monto > f.saldo then
    raise exception 'El cobro (%) supera el saldo de la factura (%). Verificá coincidencia con la factura (A05).', new.monto, f.saldo;
  end if;
  return new;
end $$;

-- Igual que la migración 08, pero una imputación de crédito no da por cumplida una promesa de pago
create or replace function public.tg_cobros_recalcular() returns trigger
language plpgsql security definer set search_path = public as $$
declare fid uuid; cobrado numeric; ultima date;
begin
  if tg_op = 'DELETE' then fid := old.factura_id; else fid := new.factura_id; end if;
  select coalesce(sum(monto), 0), max(fecha) into cobrado, ultima from public.cobros where factura_id = fid;
  update public.facturas f
     set saldo       = f.monto - f.ajuste_previo - cobrado,
         estado      = case when f.estado = 'anulada' then 'anulada'
                            when f.monto - f.ajuste_previo - cobrado <= 0 then 'cobrado' else 'pendiente' end,
         fecha_cobro = case when f.monto - f.ajuste_previo - cobrado <= 0 then ultima else null end
   where f.id = fid;
  -- Promesas de pago de esa factura (o del cliente sin factura) quedan cumplidas
  if tg_op = 'INSERT' and coalesce(current_setting('cob.imputacion', true), '') <> '1' then
    update public.cob_promesas p set estado = 'cumplida', cumplida_at = now()
     where p.estado = 'pendiente'
       and (p.factura_id = fid or (p.factura_id is null and p.cliente_id = (select cliente_id from public.facturas where id = fid)));
  end if;
  return null;
end $$;

-- Imputa una nota de crédito / anula presupuesto contra una factura, ND o presupuesto del mismo cliente.
-- Baja el saldo de los dos comprobantes (queda como "cobro" de medio "Nota de crédito"). No entra a Caja.
create or replace function public.cob_imputar_credito(p_credito uuid, p_factura uuid, p_monto numeric default null) returns numeric
language plpgsql set search_path = public as $$
declare cr public.facturas; fa public.facturas; v numeric; maximo numeric;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  select * into cr from public.facturas where id = p_credito for update;
  select * into fa from public.facturas where id = p_factura for update;
  if cr.id is null or fa.id is null then raise exception 'Comprobante inexistente.'; end if;
  if cr.signo > 0 then raise exception 'Lo que se imputa tiene que ser una nota de crédito o una anulación de presupuesto.'; end if;
  if fa.signo < 0 then raise exception 'El crédito se imputa contra una factura, nota de débito o presupuesto.'; end if;
  if cr.cliente_id <> fa.cliente_id then raise exception 'Los dos comprobantes tienen que ser del mismo cliente.'; end if;
  if cr.estado <> 'pendiente' or fa.estado <> 'pendiente' then raise exception 'Los dos comprobantes tienen que estar pendientes.'; end if;
  maximo := least(cr.saldo, fa.saldo);
  v := round(coalesce(p_monto, maximo), 2);
  if v is null or v <= 0 or v > maximo then raise exception 'Importe inválido: podés imputar hasta %.', maximo; end if;
  perform set_config('cob.imputacion', '1', true);
  insert into public.cobros (factura_id, fecha, monto, medio_pago, referencia, observaciones)
  values (fa.id, public.hoy(), v, 'Nota de crédito', format('%s %s', cr.tipo_comprobante, cr.numero), 'Imputación de crédito (no entra a Caja)');
  insert into public.cobros (factura_id, fecha, monto, medio_pago, referencia, observaciones)
  values (cr.id, public.hoy(), v, 'Imputación', format('%s %s', fa.tipo_comprobante, fa.numero), 'Crédito imputado (no entra a Caja)');
  perform set_config('cob.imputacion', '', true);
  insert into public.gestiones_cobranza (factura_id, cliente_id, tipo, nota) values
    (fa.id, fa.cliente_id, 'otro', format('Se imputó %s de %s %s', v, cr.tipo_comprobante, cr.numero)),
    (cr.id, cr.cliente_id, 'otro', format('Imputado %s contra %s %s', v, fa.tipo_comprobante, fa.numero));
  return v;
end $$;

-- ---------- 3. Saldos por cliente (con signo) -------------------------
create or replace view public.v_clientes_saldos with (security_invoker = true) as
select c.*,
       coalesce(sum(f.signo * f.saldo), 0) as saldo,
       -- Lo vencido de facturas/ND/presupuestos, descontando los créditos a favor (nunca más que el saldo)
       greatest(0, least(coalesce(sum(f.signo * f.saldo), 0),
                         coalesce(sum(f.saldo) filter (where f.signo > 0 and f.fecha_vencimiento < public.hoy()), 0))) as vencido,
       count(f.id) as facturas_pendientes
  from public.clientes c
  left join public.facturas f on f.cliente_id = c.id and f.estado = 'pendiente'
 group by c.id;

-- ---------- 4. Importación de Sintesys (reconoce el tipo) -------------
create or replace function public.cob_importar_sintesys(p_filas jsonb, p_archivo text default null) returns jsonb
language plpgsql set search_path = public as $$
declare
  lote uuid; r jsonb; f public.facturas; cid uuid; n_new int := 0; n_upd int := 0; n_same int := 0; n_saldadas int := 0;
  errs jsonb := '[]'::jsonb; v_tipo text; v_cod text; v_num text; v_monto numeric; v_saldo numeric; v_venc date; v_emi date; i int := 0;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso para importar.'; end if;
  insert into public.imp_lotes (tipo, archivo, filas) values ('cobrar', p_archivo, jsonb_array_length(p_filas)) returning id into lote;
  perform set_config('imp.sintesys', '1', true);
  for r in select * from jsonb_array_elements(p_filas) loop
    i := i + 1;
    begin
      v_tipo := coalesce(nullif(trim(r->>'tipo_comprobante'), ''), 'Comprobante');
      v_num := trim(r->>'numero');
      v_monto := abs((r->>'monto')::numeric);
      v_saldo := abs(coalesce((r->>'saldo')::numeric, (r->>'monto')::numeric));
      -- El tipo lo manda la app ya clasificado; si no, se deduce del texto (y del signo del importe)
      v_cod := coalesce(nullif(lower(trim(r->>'tipo')), ''),
                        public.factura_tipo_de(v_tipo, coalesce((r->>'negativo')::boolean, false) or (r->>'monto')::numeric < 0));
      v_emi := coalesce((r->>'fecha_emision')::date, (r->>'fecha_vencimiento')::date, public.hoy());
      v_venc := greatest(coalesce((r->>'fecha_vencimiento')::date, v_emi), v_emi);
      if coalesce(v_num, '') = '' then raise exception 'falta el número de comprobante'; end if;
      if v_monto is null or v_monto <= 0 then raise exception 'importe inválido'; end if;
      select * into f from public.facturas where tipo_comprobante = v_tipo and numero = v_num;
      if f.id is not null then
        if (f.vendedor, f.saldo_sintesys, f.fecha_vencimiento) is not distinct from (coalesce(nullif(r->>'vendedor', ''), f.vendedor), v_saldo, v_venc) then
          n_same := n_same + 1;
          update public.facturas set ult_lote = lote where id = f.id;
        else
          perform set_config('hist.motivo', 'Reimportación de Sintesys', true);
          update public.facturas
             set vendedor = coalesce(nullif(r->>'vendedor', ''), vendedor), saldo_sintesys = v_saldo,
                 fecha_vencimiento = greatest(v_venc, fecha_emision), ult_lote = lote
           where id = f.id;
          perform set_config('hist.motivo', '', true);
          n_upd := n_upd + 1;
        end if;
      else
        if v_saldo <= 0 then n_saldadas := n_saldadas + 1; continue; end if;
        cid := nullif(r->>'cliente_id', '')::uuid;
        if cid is null then
          select id into cid from public.clientes where cuit_dni = nullif(regexp_replace(coalesce(r->'cliente_nuevo'->>'cuit', ''), '[^0-9]', '', 'g'), '');
        end if;
        if cid is null then
          if coalesce(trim(r->'cliente_nuevo'->>'razon_social'), '') = '' then raise exception 'falta el cliente'; end if;
          insert into public.clientes (razon_social, cuit_dni, estado, observaciones)
          values (trim(r->'cliente_nuevo'->>'razon_social'), nullif(regexp_replace(coalesce(r->'cliente_nuevo'->>'cuit', ''), '[^0-9]', '', 'g'), ''),
                  'pendiente', 'Creado desde la importación de Sintesys')
          returning id into cid;
        end if;
        insert into public.facturas (cliente_id, tipo_comprobante, tipo, numero, fecha_emision, fecha_vencimiento, medio_pago_acordado, monto,
                                     origen, vendedor, ajuste_previo, saldo_sintesys, ult_lote, observaciones)
        values (cid, v_tipo, v_cod, v_num, v_emi, v_venc, coalesce(nullif(r->>'medio_pago', ''), 'Sin informar'), v_monto,
                'sintesys', nullif(r->>'vendedor', ''), v_monto - v_saldo, v_saldo, lote, nullif(r->>'observaciones', ''));
        n_new := n_new + 1;
      end if;
    exception when others then
      errs := errs || jsonb_build_object('fila', coalesce((r->>'fila')::int, i), 'comprobante', concat_ws(' ', v_tipo, v_num), 'error', sqlerrm);
    end;
  end loop;
  perform set_config('imp.sintesys', '', true);
  update public.imp_lotes set nuevas = n_new, actualizadas = n_upd, sin_cambios = n_same, errores = errs where id = lote;
  return jsonb_build_object('lote', lote, 'nuevas', n_new, 'actualizadas', n_upd, 'sin_cambios', n_same, 'saldadas', n_saldadas, 'errores', errs);
end $$;

-- ---------- 5. Editar un cheque emitido -------------------------------
-- Pendiente de débito (estado "emitido"): se corrigen todos los datos, con las validaciones del alta.
-- Ya debitado, rechazado o anulado: solo los datos descriptivos (número, banco, proveedor, CUIT, emisión, observaciones).
-- Cambiar el importe de un pago ya autorizado necesita a Gerencia (A08). El pago vinculado se actualiza solo.
create or replace function public.tes_cheque_editar(p_cheque uuid, p jsonb) returns void
language plpgsql set search_path = public as $$
declare
  c public.tes_cheques;
  m public.tes_movimientos;
  o public.pag_obligaciones;
  completo boolean;
  v_formato text; v_numero text; v_banco text; v_contra text; v_cuit text; v_obs text;
  v_imp numeric; v_emi date; v_pago date; v_cuenta uuid;
  auto_old text; auto_new text;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  select * into c from public.tes_cheques where id = p_cheque for update;
  if c.id is null then raise exception 'Cheque inexistente.'; end if;
  if c.sentido <> 'emitido' then raise exception 'Desde acá se corrigen solo los cheques emitidos.'; end if;
  completo := c.estado = 'emitido';

  v_formato := coalesce(nullif(p->>'formato', ''), c.formato);
  v_numero  := nullif(trim(coalesce(p->>'numero', c.numero)), '');
  v_banco   := case when p ? 'banco' then nullif(trim(p->>'banco'), '') else c.banco end;
  v_contra  := nullif(trim(coalesce(p->>'contraparte', c.contraparte)), '');
  v_cuit    := case when p ? 'cuit' then nullif(trim(p->>'cuit'), '') else c.cuit end;
  v_emi     := case when p ? 'fecha_emision' then nullif(p->>'fecha_emision', '')::date else c.fecha_emision end;
  v_obs     := case when p ? 'observaciones' then nullif(trim(p->>'observaciones'), '') else c.observaciones end;
  v_imp     := case when p ? 'importe' then nullif(p->>'importe', '')::numeric else c.importe end;
  v_pago    := case when p ? 'fecha_pago' then nullif(p->>'fecha_pago', '')::date else c.fecha_pago end;
  v_cuenta  := case when p ? 'cuenta_id' then nullif(p->>'cuenta_id', '')::uuid else c.cuenta_id end;

  if v_formato not in ('fisico','echeq') then raise exception 'Formato inválido (físico o e-cheq).'; end if;
  if v_numero is null then raise exception 'Cargá número y fecha de pago del cheque.'; end if;
  if v_contra is null then raise exception 'Indicá a quién se le emitió el cheque.'; end if;

  if completo then
    if v_pago is null then raise exception 'Cargá número y fecha de pago del cheque.'; end if;
    if v_imp is null or v_imp <= 0 then raise exception 'Importe inválido.'; end if;
    v_imp := round(v_imp, 2);
    if v_cuenta is null then raise exception 'Elegí la cuenta de débito.'; end if;
    if not exists (select 1 from public.tes_cuentas where id = v_cuenta and (activa or id = c.cuenta_id)) then
      raise exception 'La cuenta elegida no existe o está inactiva.';
    end if;
    if v_imp <> c.importe and not public.es_gerencia() then
      raise exception 'Cambiar el importe de un cheque emitido requiere autorización de Gerencia (A08).';
    end if;
  elsif (v_imp, v_pago, v_cuenta) is distinct from (c.importe, c.fecha_pago, c.cuenta_id) then
    raise exception 'El cheque ya está %: solo se pueden corregir número, banco, proveedor, CUIT, fecha de emisión y observaciones.', c.estado;
  end if;

  if c.estado <> 'anulado' and exists (
       select 1 from public.tes_cheques x
        where x.id <> c.id and x.sentido = 'emitido' and x.estado <> 'anulado'
          and x.numero = v_numero and coalesce(x.banco, '') = coalesce(v_banco, '')) then
    raise exception 'Ya hay otro cheque emitido con el número % (%).', v_numero, coalesce(v_banco, 'sin banco');
  end if;

  select * into m from public.tes_movimientos
   where cheque_id = c.id and sentido = 'salida' and estado <> 'anulado'
   order by created_at limit 1;

  if completo and m.id is not null and m.obligacion_id is not null and v_imp > c.importe then
    select * into o from public.pag_obligaciones where id = m.obligacion_id;
    if v_imp - c.importe > coalesce(o.saldo, 0) + 0.004 then
      raise exception 'El nuevo importe supera lo que queda por pagar de esa obligación (%).', o.saldo;
    end if;
  end if;

  update public.tes_cheques
     set formato = v_formato, numero = v_numero, banco = v_banco, contraparte = v_contra, cuit = v_cuit,
         importe = v_imp, fecha_emision = v_emi, fecha_pago = v_pago, cuenta_id = v_cuenta, observaciones = v_obs
   where id = c.id;

  if m.id is not null then
    auto_old := format('%s N° %s', case when c.formato = 'echeq' then 'E-cheq' else 'Cheque' end, c.numero);
    auto_new := format('%s N° %s', case when v_formato = 'echeq' then 'E-cheq' else 'Cheque' end, v_numero);
    perform set_config('tes.bypass_aut', '1', true);
    update public.tes_movimientos
       set comprobante    = case when comprobante is null or comprobante = auto_old then auto_new else comprobante end,
           contraparte    = case when contraparte is not distinct from c.contraparte then v_contra else contraparte end,
           importe        = case when completo then v_imp else importe end,
           cuenta_id      = case when completo then v_cuenta else cuenta_id end,
           fecha_prevista = case when completo then greatest(v_pago, fecha) else fecha_prevista end,
           medio          = case when completo and medio in ('cheque','echeq') then case when v_formato = 'echeq' then 'echeq' else 'cheque' end else medio end
     where id = m.id;
    perform set_config('tes.bypass_aut', '', true);
  end if;
end $$;

-- ---------- Permisos de las funciones nuevas --------------------------
revoke execute on function public.cob_imputar_credito(uuid, uuid, numeric) from public, anon;
grant  execute on function public.cob_imputar_credito(uuid, uuid, numeric) to authenticated;
revoke execute on function public.tes_cheque_editar(uuid, jsonb) from public, anon;
grant  execute on function public.tes_cheque_editar(uuid, jsonb) to authenticated;
revoke execute on function public.factura_tipo_de(text, boolean) from public, anon;
grant  execute on function public.factura_tipo_de(text, boolean) to authenticated;

-- ---------- Permisos (por si el proyecto no los trae por defecto) -----
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
