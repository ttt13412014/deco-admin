-- =====================================================================
--  MIGRACIÓN 04 · Flujo de fondos (A08)
--  Correr si ya ejecutaste schema.sql o migraciones anteriores.
-- =====================================================================
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

-- ---------- Permisos (por si el proyecto no los trae por defecto) -----
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
