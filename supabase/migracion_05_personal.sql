-- =====================================================================
--  MIGRACIÓN 05 · Personal y novedades
--  Correr si ya ejecutaste schema.sql o migraciones anteriores.
-- =====================================================================
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

-- ---------- Permisos (por si el proyecto no los trae por defecto) -----
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
