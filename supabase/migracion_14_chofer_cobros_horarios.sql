-- =====================================================================
-- Migración 14 · Hoja de ruta: link del chofer, monto cobrado, pago al
-- repartidor y horarios de atención de los clientes para ordenar la ruta.
-- Correr DESPUÉS de la migración 13. Se puede correr más de una vez.
-- Solo AGREGA columnas y funciones: no borra ni modifica datos existentes.
--
--  · clientes: horario_desde/hasta (+ segundo horario para horario cortado)
--  · hojas_ruta: hora_salida, min_por_parada, pago_repartidor y
--    token_chofer (link secreto para el chofer, se genera a pedido)
--  · hoja_ruta_paradas: resultado (entregado / no_entregado), motivo,
--    monto_cobrado, forma_pago, marcado_at, marcado_por, llegada_estimada
--  · El chofer NO es usuario del sistema: entra con el link secreto y solo
--    puede ver y marcar las paradas de ESA hoja, a través de dos funciones
--    (chofer_hoja / chofer_marcar). No tiene acceso a ninguna tabla.
-- =====================================================================

-- ---------- 1. Columnas nuevas -----------------------------------------
alter table public.clientes add column if not exists horario_desde  time;
alter table public.clientes add column if not exists horario_hasta  time;
alter table public.clientes add column if not exists horario2_desde time;
alter table public.clientes add column if not exists horario2_hasta time;

alter table public.hojas_ruta add column if not exists hora_salida     time;
alter table public.hojas_ruta add column if not exists min_por_parada  int;
alter table public.hojas_ruta add column if not exists pago_repartidor numeric(14,2);
alter table public.hojas_ruta add column if not exists token_chofer    text;
create unique index if not exists hojas_ruta_token_chofer_idx on public.hojas_ruta (token_chofer) where token_chofer is not null;

alter table public.hoja_ruta_paradas add column if not exists resultado        text;
alter table public.hoja_ruta_paradas add column if not exists motivo           text;
alter table public.hoja_ruta_paradas add column if not exists monto_cobrado    numeric(14,2);
alter table public.hoja_ruta_paradas add column if not exists forma_pago       text;
alter table public.hoja_ruta_paradas add column if not exists marcado_at       timestamptz;
alter table public.hoja_ruta_paradas add column if not exists marcado_por      text;
alter table public.hoja_ruta_paradas add column if not exists llegada_estimada time;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'paradas_resultado_chk') then
    alter table public.hoja_ruta_paradas add constraint paradas_resultado_chk
      check (resultado is null or resultado in ('entregado','no_entregado'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'paradas_forma_pago_chk') then
    alter table public.hoja_ruta_paradas add constraint paradas_forma_pago_chk
      check (forma_pago is null or forma_pago in ('efectivo','transferencia','cheque','mixto'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'paradas_cobrado_chk') then
    alter table public.hoja_ruta_paradas add constraint paradas_cobrado_chk check (monto_cobrado is null or monto_cobrado >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'hojas_min_parada_chk') then
    alter table public.hojas_ruta add constraint hojas_min_parada_chk check (min_por_parada is null or min_por_parada between 0 and 240);
  end if;
end $$;

-- ---------- 2. "entregado" y "resultado" siempre de acuerdo -------------
-- (la casilla "Entregado" de la pantalla de admin sigue funcionando igual)
create or replace function public.tg_paradas_resultado() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.resultado is distinct from old.resultado then
    new.entregado := (new.resultado is not distinct from 'entregado');
  elsif tg_op = 'UPDATE' and new.entregado is distinct from old.entregado then
    new.resultado := case when new.entregado then 'entregado' else null end;
  elsif tg_op = 'INSERT' then
    if new.resultado is not null then new.entregado := (new.resultado is not distinct from 'entregado');
    elsif new.entregado then new.resultado := 'entregado'; end if;
  end if;
  -- El motivo es solo para "no entregado"
  if new.resultado is distinct from 'no_entregado' then new.motivo := null; end if;
  return new;
end $$;

drop trigger if exists paradas_a_resultado on public.hoja_ruta_paradas;
create trigger paradas_a_resultado before insert or update on public.hoja_ruta_paradas
  for each row execute function public.tg_paradas_resultado();

-- ---------- 3. Guardar hoja: conserva lo que marcó el chofer ------------
-- Antes se borraban y recreaban las paradas. Ahora cada parada conserva su id
-- y lo marcado en la calle (entregado / no entregado, motivo, cobrado) se toma
-- de la base, así no se pisa si el chofer marcó mientras se editaba la hoja.
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
       monto_factura, comprobantes, resultado, motivo, monto_cobrado, forma_pago, marcado_at, marcado_por, llegada_estimada)
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
            nullif(p->>'llegada_estimada', '')::time);
  end loop;
  return hid;
end $function$;

grant execute on function public.guardar_hoja_ruta(jsonb, jsonb) to authenticated;

-- ---------- 4. Link secreto del chofer -----------------------------------
-- Lo pide Administración / Gerencia / Ventas desde la hoja. p_renovar = true
-- genera uno nuevo y el anterior deja de funcionar.
create or replace function public.link_chofer_hoja(p_hoja uuid, p_renovar boolean default false)
 returns text
 language plpgsql
 security definer
 set search_path = public
as $function$
declare t text;
begin
  if not public.puede_armar_rutas() then raise exception 'No tenés permiso.'; end if;
  select token_chofer into t from public.hojas_ruta where id = p_hoja;
  if not found then raise exception 'Hoja de ruta inexistente'; end if;
  if t is null or p_renovar then
    t := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    update public.hojas_ruta set token_chofer = t where id = p_hoja;
  end if;
  return t;
end $function$;

revoke all on function public.link_chofer_hoja(uuid, boolean) from public, anon;
grant execute on function public.link_chofer_hoja(uuid, boolean) to authenticated;

-- Hoja válida para ese link (vence 7 días después de la fecha del reparto)
create or replace function public.chofer_hoja_id(p_token text)
 returns uuid
 language sql
 stable
 security definer
 set search_path = public
as $function$
  select id from public.hojas_ruta
   where p_token is not null and length(p_token) >= 32
     and token_chofer = p_token
     and fecha >= public.hoy() - 7
$function$;
revoke all on function public.chofer_hoja_id(text) from public, anon, authenticated;

-- Lo que ve el chofer: solo su hoja y sus paradas (sin datos de facturación del cliente)
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

-- El chofer marca una parada: entregado / no_entregado (con motivo) / pendiente (deshacer)
create or replace function public.chofer_marcar(
  p_token text, p_parada uuid, p_resultado text,
  p_motivo text default null, p_monto_cobrado numeric default null, p_forma_pago text default null, p_nota text default null)
 returns void
 language plpgsql
 security definer
 set search_path = public
as $function$
declare hid uuid;
begin
  hid := public.chofer_hoja_id(p_token);
  if hid is null then raise exception 'Link vencido o inválido. Pedile uno nuevo a la oficina.'; end if;
  if p_resultado not in ('entregado', 'no_entregado', 'pendiente') then raise exception 'Estado inválido.'; end if;
  if p_resultado = 'no_entregado' and coalesce(trim(p_motivo), '') = '' then raise exception 'Indicá el motivo.'; end if;
  if p_monto_cobrado is not null and (p_monto_cobrado < 0 or p_monto_cobrado > 999999999) then raise exception 'Monto cobrado inválido.'; end if;
  if p_forma_pago is not null and p_forma_pago not in ('efectivo','transferencia','cheque','mixto') then raise exception 'Forma de pago inválida.'; end if;

  update public.hoja_ruta_paradas
     set resultado     = nullif(p_resultado, 'pendiente'),
         entregado     = (p_resultado = 'entregado'),
         entregado_at  = case when p_resultado = 'entregado' then coalesce(entregado_at, now()) else null end,
         motivo        = case when p_resultado = 'no_entregado' then left(trim(p_motivo), 300) else null end,
         monto_cobrado = case when p_resultado = 'pendiente' then null else round(p_monto_cobrado, 2) end,
         forma_pago    = case when p_resultado = 'pendiente' or p_monto_cobrado is null or p_monto_cobrado = 0 then null else p_forma_pago end,
         nota_entrega  = case when p_resultado = 'pendiente' then null else nullif(left(trim(coalesce(p_nota, '')), 300), '') end,
         marcado_at    = case when p_resultado = 'pendiente' then null else now() end,
         marcado_por   = case when p_resultado = 'pendiente' then null else 'chofer' end
   where id = p_parada and hoja_id = hid;
  if not found then raise exception 'Esa parada ya no está en la hoja. Actualizá la pantalla.'; end if;
end $function$;

revoke all on function public.chofer_hoja(text) from public;
revoke all on function public.chofer_marcar(text, uuid, text, text, numeric, text, text) from public;
grant execute on function public.chofer_hoja(text) to anon, authenticated;
grant execute on function public.chofer_marcar(text, uuid, text, text, numeric, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
