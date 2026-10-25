-- =====================================================================
--  MIGRACIÓN 02 · Hoja de ruta + dirección/ubicación de clientes
--  Correr SOLO si ya ejecutaste schema.sql antes de esta versión.
--  (Si arrancás de cero, alcanza con schema.sql.)
-- =====================================================================

alter table public.clientes alter column cuit_dni drop not null;
alter table public.clientes add column if not exists provincia text default 'Córdoba';
alter table public.clientes add column if not exists ubicacion text;

create or replace function public.tg_clientes_validar() returns trigger
language plpgsql as $$
declare faltan text[] := '{}';
begin
  new.cuit_dni := nullif(regexp_replace(coalesce(new.cuit_dni, ''), '[^0-9]', '', 'g'), '');
  if new.cuit_dni is not null and length(new.cuit_dni) not in (7, 8, 11) then
    raise exception 'CUIT/DNI inválido: debe tener 11 dígitos (CUIT) o 7-8 (DNI)';
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

drop view if exists public.v_clientes_saldos;
create view public.v_clientes_saldos with (security_invoker = true) as
select c.*,
       coalesce(sum(f.saldo), 0)                                                    as saldo,
       coalesce(sum(f.saldo) filter (where f.fecha_vencimiento < public.hoy()), 0) as vencido,
       count(f.id)                                                                  as facturas_pendientes
  from public.clientes c
  left join public.facturas f on f.cliente_id = c.id and f.estado = 'pendiente'
 group by c.id;

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
  nota_entrega   text
);
create index if not exists paradas_hoja_idx on public.hoja_ruta_paradas (hoja_id, orden);

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
      (hoja_id, orden, cliente_id, destino, direccion, telefono, que_lleva, bultos, observaciones, entregado, entregado_at, nota_entrega)
    values (hid, i, nullif(p->>'cliente_id', '')::uuid, p->>'destino', p->>'direccion', p->>'telefono', p->>'que_lleva',
            nullif(p->>'bultos', '')::int, p->>'observaciones', coalesce((p->>'entregado')::boolean, false),
            nullif(p->>'entregado_at', '')::timestamptz, p->>'nota_entrega');
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
create policy hojas_sel on public.hojas_ruta for select to authenticated using (true);
drop policy if exists hojas_ins on public.hojas_ruta;
create policy hojas_ins on public.hojas_ruta for insert to authenticated with check (public.puede_editar());
drop policy if exists hojas_upd on public.hojas_ruta;
create policy hojas_upd on public.hojas_ruta for update to authenticated using (public.puede_editar()) with check (public.puede_editar());
drop policy if exists hojas_del on public.hojas_ruta;
create policy hojas_del on public.hojas_ruta for delete to authenticated using (public.puede_editar());

drop policy if exists paradas_sel on public.hoja_ruta_paradas;
create policy paradas_sel on public.hoja_ruta_paradas for select to authenticated using (true);
drop policy if exists paradas_ins on public.hoja_ruta_paradas;
create policy paradas_ins on public.hoja_ruta_paradas for insert to authenticated with check (public.puede_editar());
drop policy if exists paradas_del on public.hoja_ruta_paradas;
create policy paradas_del on public.hoja_ruta_paradas for delete to authenticated using (public.puede_editar());
-- Cualquier usuario (ej. el chofer) puede marcar entregas
drop policy if exists paradas_upd on public.hoja_ruta_paradas;
create policy paradas_upd on public.hoja_ruta_paradas for update to authenticated using (true) with check (true);

-- ---------- Permisos (por si el proyecto no los trae por defecto) -----
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
