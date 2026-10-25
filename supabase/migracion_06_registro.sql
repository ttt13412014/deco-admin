-- =====================================================================
--  MIGRACIÓN 06 · Registro desde la app
--  El primero que se registra queda Gerencia; los demás quedan "pendiente"
--  (sin acceso a ningún dato) hasta que Gerencia les asigne un rol.
--  Correr si ya ejecutaste schema.sql antes de esta versión.
-- =====================================================================

alter table public.perfiles drop constraint if exists perfiles_rol_check;
alter table public.perfiles add constraint perfiles_rol_check check (rol in ('administracion','ventas','gerencia','pendiente'));
alter table public.perfiles alter column rol set default 'pendiente';

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

drop policy if exists perfiles_sel on public.perfiles;
create policy perfiles_sel on public.perfiles for select to authenticated using (public.tiene_acceso() or id = auth.uid());
drop policy if exists clientes_sel on public.clientes;
create policy clientes_sel on public.clientes for select to authenticated using (public.tiene_acceso());
drop policy if exists facturas_sel on public.facturas;
create policy facturas_sel on public.facturas for select to authenticated using (public.tiene_acceso());
drop policy if exists cobros_sel on public.cobros;
create policy cobros_sel on public.cobros for select to authenticated using (public.tiene_acceso());
drop policy if exists gestiones_sel on public.gestiones_cobranza;
create policy gestiones_sel on public.gestiones_cobranza for select to authenticated using (public.tiene_acceso());
drop policy if exists gestiones_ins on public.gestiones_cobranza;
create policy gestiones_ins on public.gestiones_cobranza for insert to authenticated with check (public.tiene_acceso());
drop policy if exists hojas_sel on public.hojas_ruta;
create policy hojas_sel on public.hojas_ruta for select to authenticated using (public.tiene_acceso());
drop policy if exists paradas_sel on public.hoja_ruta_paradas;
create policy paradas_sel on public.hoja_ruta_paradas for select to authenticated using (public.tiene_acceso());
drop policy if exists paradas_upd on public.hoja_ruta_paradas;
create policy paradas_upd on public.hoja_ruta_paradas for update to authenticated using (public.tiene_acceso()) with check (public.tiene_acceso());

grant execute on all functions in schema public to authenticated;
