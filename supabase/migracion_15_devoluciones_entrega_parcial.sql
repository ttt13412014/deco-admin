-- =====================================================================
-- Migración 15 · Hoja de ruta: devoluciones y entrega parcial
-- Correr DESPUÉS de la migración 14. Se puede correr más de una vez.
-- Solo AGREGA columnas y reemplaza funciones: no borra ni modifica datos.
--
--  · hoja_ruta_paradas: devolucion_detalle (qué devolvió), devolucion_motivo,
--    devolucion_monto (opcional). Hay devolución si hay detalle.
--  · resultado acepta 'parcial' (entrega parcial: cuenta como entregada; el
--    motivo dice qué faltó).
--  · chofer_marcar suma los datos de la devolución y sigue tocando solo las
--    paradas de la hoja del link.
-- =====================================================================

alter table public.hoja_ruta_paradas add column if not exists devolucion_detalle text;
alter table public.hoja_ruta_paradas add column if not exists devolucion_motivo  text;
alter table public.hoja_ruta_paradas add column if not exists devolucion_monto   numeric(14,2);

do $$ begin
  -- Se amplía el control para aceptar 'parcial' (los valores que ya existen siguen valiendo)
  if exists (select 1 from pg_constraint where conname = 'paradas_resultado_chk'
             and pg_get_constraintdef(oid) not like '%parcial%') then
    alter table public.hoja_ruta_paradas drop constraint paradas_resultado_chk;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'paradas_resultado_chk') then
    alter table public.hoja_ruta_paradas add constraint paradas_resultado_chk
      check (resultado is null or resultado in ('entregado','parcial','no_entregado'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'paradas_devolucion_monto_chk') then
    alter table public.hoja_ruta_paradas add constraint paradas_devolucion_monto_chk check (devolucion_monto is null or devolucion_monto >= 0);
  end if;
end $$;

-- ---------- entregado / resultado / motivo / devolución coherentes ----------
create or replace function public.tg_paradas_resultado() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.resultado is distinct from old.resultado then
    new.entregado := coalesce(new.resultado in ('entregado','parcial'), false);
  elsif tg_op = 'UPDATE' and new.entregado is distinct from old.entregado then
    new.resultado := case when new.entregado then 'entregado' else null end;
  elsif tg_op = 'INSERT' then
    if new.resultado is not null then new.entregado := (new.resultado in ('entregado','parcial'));
    elsif new.entregado then new.resultado := 'entregado'; end if;
  end if;
  -- El motivo es para "no entregado" y "entrega parcial" (qué faltó y por qué)
  if new.resultado is null or new.resultado = 'entregado' then new.motivo := null; end if;
  -- La devolución va con algo marcado; sin detalle no hay devolución
  if new.resultado is null or coalesce(trim(new.devolucion_detalle), '') = '' then
    new.devolucion_detalle := null; new.devolucion_motivo := null; new.devolucion_monto := null;
  end if;
  return new;
end $$;

-- ---------- Guardar hoja: también conserva la devolución marcada ----------
create or replace function public.guardar_hoja_ruta(p_hoja jsonb, p_paradas jsonb)
 returns uuid
 language plpgsql
 set search_path = public
as $function$
declare hid uuid; p jsonb; i int := 0; previas jsonb := '{}'::jsonb; o jsonb; pid uuid;
begin
  if not public.puede_armar_rutas() then raise exception 'No tenés permiso para armar hojas de ruta.'; end if;
  if coalesce(trim(p_hoja->>'origen'), '') = '' then raise exception 'Indicá el punto de salida.'; end if;
  if jsonb_array_length(coalesce(p_paradas, '[]'::jsonb)) = 0 then raise exception 'Agregá al menos una parada.'; end if;

  hid := nullif(p_hoja->>'id', '')::uuid;
  if hid is null then
    insert into public.hojas_ruta (fecha, nombre, chofer, chofer_telefono, origen, volver_origen, observaciones,
                                   hora_salida, min_por_parada, pago_repartidor)
    values (coalesce((p_hoja->>'fecha')::date, public.hoy()), p_hoja->>'nombre', p_hoja->>'chofer', p_hoja->>'chofer_telefono',
            p_hoja->>'origen', coalesce((p_hoja->>'volver_origen')::boolean, true), p_hoja->>'observaciones',
            nullif(p_hoja->>'hora_salida', '')::time, nullif(p_hoja->>'min_por_parada', '')::int,
            nullif(p_hoja->>'pago_repartidor', '')::numeric)
    returning id into hid;
  else
    update public.hojas_ruta
       set fecha = coalesce((p_hoja->>'fecha')::date, fecha), nombre = p_hoja->>'nombre', chofer = p_hoja->>'chofer',
           chofer_telefono = p_hoja->>'chofer_telefono', origen = p_hoja->>'origen',
           volver_origen = coalesce((p_hoja->>'volver_origen')::boolean, true), observaciones = p_hoja->>'observaciones',
           hora_salida = case when p_hoja ? 'hora_salida' then nullif(p_hoja->>'hora_salida', '')::time else hora_salida end,
           min_por_parada = case when p_hoja ? 'min_por_parada' then nullif(p_hoja->>'min_por_parada', '')::int else min_por_parada end,
           pago_repartidor = case when p_hoja ? 'pago_repartidor' then nullif(p_hoja->>'pago_repartidor', '')::numeric else pago_repartidor end
     where id = hid;
    if not found then raise exception 'Hoja de ruta inexistente'; end if;
    select coalesce(jsonb_object_agg(x.id::text, to_jsonb(x)), '{}'::jsonb) into previas
      from public.hoja_ruta_paradas x where x.hoja_id = hid;
    delete from public.hoja_ruta_paradas where hoja_id = hid;
  end if;

  for p in select * from jsonb_array_elements(p_paradas) loop
    i := i + 1;
    if coalesce(trim(p->>'direccion'), '') = '' then
      raise exception 'La parada % (%) no tiene dirección.', i, p->>'destino';
    end if;
    o := previas -> (p->>'id');          -- la misma parada, como estaba en la base (o null si es nueva)
    pid := case when o is not null then (o->>'id')::uuid else gen_random_uuid() end;
    if o is not null then previas := previas - (p->>'id'); end if;  -- un id no se usa dos veces
    insert into public.hoja_ruta_paradas
      (id, hoja_id, orden, cliente_id, destino, direccion, telefono, que_lleva, bultos, observaciones, entregado, entregado_at, nota_entrega, lat, lng,
       monto_factura, comprobantes, resultado, motivo, monto_cobrado, forma_pago, marcado_at, marcado_por, llegada_estimada,
       devolucion_detalle, devolucion_motivo, devolucion_monto)
    values (pid, hid, i, nullif(p->>'cliente_id', '')::uuid, p->>'destino', p->>'direccion', p->>'telefono', p->>'que_lleva',
            nullif(p->>'bultos', '')::int, p->>'observaciones',
            coalesce((coalesce(o, p)->>'entregado')::boolean, false),
            nullif(coalesce(o, p)->>'entregado_at', '')::timestamptz, coalesce(o, p)->>'nota_entrega',
            nullif(p->>'lat', '')::double precision, nullif(p->>'lng', '')::double precision,
            nullif(p->>'monto_factura', '')::numeric,
            case when jsonb_typeof(p->'comprobantes') = 'array' then p->'comprobantes' else '[]'::jsonb end,
            nullif(coalesce(o, p)->>'resultado', ''), coalesce(o, p)->>'motivo',
            nullif(coalesce(o, p)->>'monto_cobrado', '')::numeric, nullif(coalesce(o, p)->>'forma_pago', ''),
            nullif(coalesce(o, p)->>'marcado_at', '')::timestamptz, coalesce(o, p)->>'marcado_por',
            nullif(p->>'llegada_estimada', '')::time,
            nullif(coalesce(o, p)->>'devolucion_detalle', ''), coalesce(o, p)->>'devolucion_motivo',
            nullif(coalesce(o, p)->>'devolucion_monto', '')::numeric);
  end loop;
  return hid;
end $function$;

grant execute on function public.guardar_hoja_ruta(jsonb, jsonb) to authenticated;

-- ---------- Lo que ve el chofer (+ devolución) ----------
create or replace function public.chofer_hoja(p_token text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path = public
as $function$
declare hid uuid; r jsonb;
begin
  hid := public.chofer_hoja_id(p_token);
  if hid is null then raise exception 'Link vencido o inválido. Pedile uno nuevo a la oficina.'; end if;
  select jsonb_build_object(
           'fecha', h.fecha, 'nombre', h.nombre, 'chofer', h.chofer, 'origen', h.origen,
           'volver_origen', h.volver_origen, 'observaciones', h.observaciones, 'estado', h.estado,
           'hora_salida', to_char(h.hora_salida, 'HH24:MI'),
           'paradas', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id', p.id, 'orden', p.orden, 'destino', p.destino, 'direccion', p.direccion,
                      'telefono', p.telefono, 'que_lleva', p.que_lleva, 'bultos', p.bultos,
                      'observaciones', p.observaciones, 'entregado', p.entregado, 'resultado', p.resultado,
                      'motivo', p.motivo, 'nota_entrega', p.nota_entrega, 'monto_factura', p.monto_factura,
                      'comprobantes', (select coalesce(jsonb_agg(jsonb_build_object(
                                          'tipo', c->>'tipo', 'letra', c->>'letra', 'numero', c->>'numero', 'monto', c->'monto')), '[]'::jsonb)
                                         from jsonb_array_elements(case when jsonb_typeof(p.comprobantes) = 'array' then p.comprobantes else '[]'::jsonb end) c),
                      'monto_cobrado', p.monto_cobrado, 'forma_pago', p.forma_pago, 'marcado_at', p.marcado_at,
                      'devolucion_detalle', p.devolucion_detalle, 'devolucion_motivo', p.devolucion_motivo, 'devolucion_monto', p.devolucion_monto,
                      'lat', p.lat, 'lng', p.lng, 'llegada_estimada', to_char(p.llegada_estimada, 'HH24:MI'),
                      'horario_desde', to_char(c.horario_desde, 'HH24:MI'), 'horario_hasta', to_char(c.horario_hasta, 'HH24:MI'),
                      'horario2_desde', to_char(c.horario2_desde, 'HH24:MI'), 'horario2_hasta', to_char(c.horario2_hasta, 'HH24:MI'),
                      'horarios', c.horarios
                    ) order by p.orden)
               from public.hoja_ruta_paradas p
               left join public.clientes c on c.id = p.cliente_id
              where p.hoja_id = h.id), '[]'::jsonb)
         ) into r
    from public.hojas_ruta h where h.id = hid;
  return r;
end $function$;

-- ---------- El chofer marca (+ entrega parcial y devolución) ----------
drop function if exists public.chofer_marcar(text, uuid, text, text, numeric, text, text);
create or replace function public.chofer_marcar(
  p_token text, p_parada uuid, p_resultado text,
  p_motivo text default null, p_monto_cobrado numeric default null, p_forma_pago text default null, p_nota text default null,
  p_devolucion_detalle text default null, p_devolucion_motivo text default null, p_devolucion_monto numeric default null)
 returns void
 language plpgsql
 security definer
 set search_path = public
as $function$
declare hid uuid; pend boolean := (p_resultado = 'pendiente'); dev text := nullif(left(trim(coalesce(p_devolucion_detalle, '')), 300), '');
begin
  hid := public.chofer_hoja_id(p_token);
  if hid is null then raise exception 'Link vencido o inválido. Pedile uno nuevo a la oficina.'; end if;
  if p_resultado not in ('entregado', 'parcial', 'no_entregado', 'pendiente') then raise exception 'Estado inválido.'; end if;
  if p_resultado = 'no_entregado' and coalesce(trim(p_motivo), '') = '' then raise exception 'Indicá el motivo.'; end if;
  if p_monto_cobrado is not null and (p_monto_cobrado < 0 or p_monto_cobrado > 999999999) then raise exception 'Monto cobrado inválido.'; end if;
  if p_devolucion_monto is not null and (p_devolucion_monto < 0 or p_devolucion_monto > 999999999) then raise exception 'Monto de la devolución inválido.'; end if;
  if p_forma_pago is not null and p_forma_pago not in ('efectivo','transferencia','cheque','mixto') then raise exception 'Forma de pago inválida.'; end if;

  update public.hoja_ruta_paradas
     set resultado     = nullif(p_resultado, 'pendiente'),
         entregado     = p_resultado in ('entregado', 'parcial'),
         entregado_at  = case when p_resultado in ('entregado', 'parcial') then coalesce(entregado_at, now()) else null end,
         motivo        = case when p_resultado in ('no_entregado', 'parcial') then nullif(left(trim(coalesce(p_motivo, '')), 300), '') else null end,
         monto_cobrado = case when pend then null else round(p_monto_cobrado, 2) end,
         forma_pago    = case when pend or p_monto_cobrado is null or p_monto_cobrado = 0 then null else p_forma_pago end,
         nota_entrega  = case when pend then null else nullif(left(trim(coalesce(p_nota, '')), 300), '') end,
         devolucion_detalle = case when pend then null else dev end,
         devolucion_motivo  = case when pend or dev is null then null else nullif(left(trim(coalesce(p_devolucion_motivo, '')), 120), '') end,
         devolucion_monto   = case when pend or dev is null then null else round(p_devolucion_monto, 2) end,
         marcado_at    = case when pend then null else now() end,
         marcado_por   = case when pend then null else 'chofer' end
   where id = p_parada and hoja_id = hid;
  if not found then raise exception 'Esa parada ya no está en la hoja. Actualizá la pantalla.'; end if;
end $function$;

revoke all on function public.chofer_hoja(text) from public;
revoke all on function public.chofer_marcar(text, uuid, text, text, numeric, text, text, text, text, numeric) from public;
grant execute on function public.chofer_hoja(text) to anon, authenticated;
grant execute on function public.chofer_marcar(text, uuid, text, text, numeric, text, text, text, text, numeric) to anon, authenticated;

notify pgrst, 'reload schema';
