-- =====================================================================
-- Migración 11 · Rol Ventas acotado: solo Clientes (consulta + carga) y Hoja de ruta
-- Correr DESPUÉS de las migraciones 02 a 10. Se puede correr más de una vez.
-- No borra ni modifica ningún dato: solo funciones, políticas (RLS) y un trigger.
-- Administración y Gerencia quedan exactamente con los mismos permisos que antes.
--
-- Ventas PUEDE:
--   · ver y buscar clientes (sin saldos: la vista v_clientes_saldos le da 0
--     porque ya no lee facturas)
--   · dar de alta / editar / importar clientes. Siempre quedan "pendientes":
--     validar, habilitar o inhabilitar sigue siendo de Administración/Gerencia (A01)
--   · ver, armar, editar y duplicar hojas de ruta y marcar entregas
--     (incluye el monto de factura por parada que se carga en la hoja)
-- Ventas NO PUEDE (ni por la app ni por la API):
--   · facturas, cobros, gestiones de cobranza, promesas, pagos informados,
--     historial de fechas, lotes de importación (antes podía leerlos)
--   · caja, bancos, cheques, pagos, flujo, personal, auditoría (ya estaban cerrados)
--   · eliminar hojas de ruta
-- =====================================================================

-- ---------- 1. Funciones de rol ----------------------------------------
create or replace function public.es_ventas() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select rol = 'ventas' from public.perfiles where id = auth.uid()), false)
$$;

-- Alta y edición de clientes
create or replace function public.puede_cargar_clientes() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select rol in ('administracion','gerencia','ventas') from public.perfiles where id = auth.uid()), false)
$$;

-- Armar y editar hojas de ruta
create or replace function public.puede_armar_rutas() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select rol in ('administracion','gerencia','ventas') from public.perfiles where id = auth.uid()), false)
$$;

-- ---------- 2. Clientes: Ventas carga, pero no valida ------------------
create or replace function public.tg_clientes_ventas_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if public.es_ventas() then
    if tg_op = 'INSERT' then
      new.estado := 'pendiente';   -- lo valida Administración/Gerencia (A01)
    elsif new.estado is distinct from old.estado then
      raise exception 'Solo Administración o Gerencia pueden validar, habilitar o inhabilitar clientes.';
    end if;
  end if;
  return new;
end $$;

-- El nombre empieza con "clientes_a" para correr antes que clientes_validar
drop trigger if exists clientes_a_ventas_guard on public.clientes;
create trigger clientes_a_ventas_guard before insert or update on public.clientes
  for each row execute function public.tg_clientes_ventas_guard();

drop policy if exists clientes_ins on public.clientes;
create policy clientes_ins on public.clientes for insert to authenticated with check (public.puede_cargar_clientes());
drop policy if exists clientes_upd on public.clientes;
create policy clientes_upd on public.clientes for update to authenticated using (public.puede_cargar_clientes()) with check (public.puede_cargar_clientes());

-- ---------- 3. Hojas de ruta: Ventas arma y edita (no elimina) ---------
drop policy if exists hojas_ins on public.hojas_ruta;
create policy hojas_ins on public.hojas_ruta for insert to authenticated with check (public.puede_armar_rutas());
drop policy if exists hojas_upd on public.hojas_ruta;
create policy hojas_upd on public.hojas_ruta for update to authenticated using (public.puede_armar_rutas()) with check (public.puede_armar_rutas());
-- hojas_del sigue con puede_editar() (Administración/Gerencia)

drop policy if exists paradas_ins on public.hoja_ruta_paradas;
create policy paradas_ins on public.hoja_ruta_paradas for insert to authenticated with check (public.puede_armar_rutas());
-- guardar_hoja_ruta reemplaza las paradas al editar: necesita borrar
drop policy if exists paradas_del on public.hoja_ruta_paradas;
create policy paradas_del on public.hoja_ruta_paradas for delete to authenticated using (public.puede_armar_rutas());

create or replace function public.guardar_hoja_ruta(p_hoja jsonb, p_paradas jsonb)
 returns uuid
 language plpgsql
as $function$
declare hid uuid; p jsonb; i int := 0;
begin
  if not public.puede_armar_rutas() then raise exception 'No tenés permiso para armar hojas de ruta.'; end if;
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
end $function$;

-- ---------- 4. Datos financieros: solo Administración y Gerencia -------
-- (antes: cualquier rol con acceso, incluido Ventas)
drop policy if exists facturas_sel on public.facturas;
create policy facturas_sel on public.facturas for select to authenticated using (public.puede_editar());

drop policy if exists cobros_sel on public.cobros;
create policy cobros_sel on public.cobros for select to authenticated using (public.puede_editar());

drop policy if exists gestiones_sel on public.gestiones_cobranza;
create policy gestiones_sel on public.gestiones_cobranza for select to authenticated using (public.puede_editar());
drop policy if exists gestiones_ins on public.gestiones_cobranza;
create policy gestiones_ins on public.gestiones_cobranza for insert to authenticated with check (public.puede_editar());

drop policy if exists prom_sel on public.cob_promesas;
create policy prom_sel on public.cob_promesas for select to authenticated using (public.puede_editar());
drop policy if exists prom_ins on public.cob_promesas;
create policy prom_ins on public.cob_promesas for insert to authenticated with check (public.puede_editar());
drop policy if exists prom_upd on public.cob_promesas;
create policy prom_upd on public.cob_promesas for update to authenticated using (public.puede_editar()) with check (public.puede_editar());

drop policy if exists pi_sel on public.cob_pagos_informados;
create policy pi_sel on public.cob_pagos_informados for select to authenticated using (public.puede_editar());
drop policy if exists pi_ins on public.cob_pagos_informados;
create policy pi_ins on public.cob_pagos_informados for insert to authenticated with check (public.puede_editar() and estado = 'pendiente_validacion');

drop policy if exists hist_sel on public.hist_fechas;
create policy hist_sel on public.hist_fechas for select to authenticated using (public.puede_editar());
drop policy if exists hist_ins on public.hist_fechas;
create policy hist_ins on public.hist_fechas for insert to authenticated with check (public.puede_editar());

drop policy if exists lotes_sel on public.imp_lotes;
create policy lotes_sel on public.imp_lotes for select to authenticated using (public.puede_editar());

-- Cambiar la fecha estimada de cobro era posible para cualquier rol con acceso
create or replace function public.cob_cambiar_fecha(p_factura uuid, p_fecha date, p_motivo text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  perform set_config('hist.motivo', coalesce(p_motivo, ''), true);
  update public.facturas set fecha_estimada_cobro = p_fecha where id = p_factura;
  perform set_config('hist.motivo', '', true);
end $function$;
