-- =====================================================================
-- Migración 16 · Hoja de ruta: "Terminé el recorrido" (informe de la ruta)
-- Correr DESPUÉS de la migración 15. Se puede correr más de una vez.
-- Solo AGREGA columnas y funciones: no borra ni modifica datos existentes.
--
--  · hojas_ruta: finalizada_at (cuándo se terminó el recorrido) y
--    finalizada_por ('chofer' o el nombre de quien la cerró en la oficina).
--  · chofer_finalizar(token): el chofer, desde su link, marca la hoja como
--    terminada (estado 'completada' + finalizada_at). Mismo esquema que
--    chofer_hoja / chofer_marcar (security definer, ejecutable por anon).
--  · hoja_ruta_finalizar(hoja, terminada): la oficina (Administración,
--    Gerencia, Ventas) la da por terminada o la reabre (deshacer).
--  · Mientras la hoja esté terminada, el estado queda en 'completada'
--    aunque se corrija alguna parada.
--  · chofer_hoja devuelve también finalizada_at / finalizada_por.
--  · La columna pago_repartidor NO se toca (la app deja de usarla).
-- =====================================================================

-- ---------- 1. Columnas nuevas -----------------------------------------
alter table public.hojas_ruta add column if not exists finalizada_at  timestamptz;
alter table public.hojas_ruta add column if not exists finalizada_por text;
create index if not exists hojas_ruta_finalizada_idx on public.hojas_ruta (finalizada_at) where finalizada_at is not null;

-- ---------- 2. El estado respeta la hoja terminada ----------------------
create or replace function public.tg_paradas_estado() returns trigger
 language plpgsql
 security definer
 set search_path = public
as $function$
declare hid uuid; tot int; ok int; nuevo text;
begin
  if tg_op = 'DELETE' then hid := old.hoja_id; else hid := new.hoja_id; end if;
  if tg_op = 'UPDATE' and new.entregado and not old.entregado then
    update public.hoja_ruta_paradas set entregado_at = coalesce(entregado_at, now()) where id = new.id;
  end if;
  select count(*), count(*) filter (where entregado) into tot, ok from public.hoja_ruta_paradas where hoja_id = hid;
  update public.hojas_ruta
     set estado = case when finalizada_at is not null then 'completada'
                       when tot > 0 and ok = tot then 'completada' when ok > 0 then 'en_curso' else estado end
   where id = hid
     and estado is distinct from (case when finalizada_at is not null then 'completada'
                                       when tot > 0 and ok = tot then 'completada' when ok > 0 then 'en_curso' else estado end);
  return null;
end $function$;

-- ---------- 3. El chofer termina el recorrido ---------------------------
create or replace function public.chofer_finalizar(p_token text)
 returns timestamptz
 language plpgsql
 security definer
 set search_path = public
as $function$
declare hid uuid; t timestamptz;
begin
  hid := public.chofer_hoja_id(p_token);
  if hid is null then raise exception 'Link vencido o inválido. Pedile uno nuevo a la oficina.'; end if;
  update public.hojas_ruta
     set finalizada_at = coalesce(finalizada_at, now()),
         finalizada_por = coalesce(finalizada_por, 'chofer'),
         estado = 'completada'
   where id = hid
  returning finalizada_at into t;
  return t;
end $function$;

revoke all on function public.chofer_finalizar(text) from public;
grant execute on function public.chofer_finalizar(text) to anon, authenticated;

-- ---------- 4. La oficina la da por terminada o la reabre ---------------
create or replace function public.hoja_ruta_finalizar(p_hoja uuid, p_terminada boolean default true)
 returns timestamptz
 language plpgsql
 security definer
 set search_path = public
as $function$
declare t timestamptz; tot int; ok int; quien text;
begin
  if not public.puede_armar_rutas() then raise exception 'No tenés permiso.'; end if;
  if p_terminada then
    select coalesce(nullif(trim(nombre), ''), 'oficina') into quien from public.perfiles where id = auth.uid();
    update public.hojas_ruta
       set finalizada_at = coalesce(finalizada_at, now()),
           finalizada_por = coalesce(finalizada_por, quien, 'oficina'),
           estado = 'completada'
     where id = p_hoja
    returning finalizada_at into t;
  else
    select count(*), count(*) filter (where entregado) into tot, ok from public.hoja_ruta_paradas where hoja_id = p_hoja;
    update public.hojas_ruta
       set finalizada_at = null,
           finalizada_por = null,
           estado = case when tot > 0 and ok = tot then 'completada' when ok > 0 then 'en_curso' else 'borrador' end
     where id = p_hoja;
    t := null;
  end if;
  if not found then raise exception 'Hoja de ruta inexistente'; end if;
  return t;
end $function$;

revoke all on function public.hoja_ruta_finalizar(uuid, boolean) from public, anon;
grant execute on function public.hoja_ruta_finalizar(uuid, boolean) to authenticated;

-- ---------- 5. Lo que ve el chofer (+ si ya terminó) ---------------------
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
           'finalizada_at', h.finalizada_at, 'finalizada_por', h.finalizada_por,
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

revoke all on function public.chofer_hoja(text) from public;
grant execute on function public.chofer_hoja(text) to anon, authenticated;

notify pgrst, 'reload schema';
