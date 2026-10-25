-- =====================================================================
--  MIGRACIÓN 09 · Monto de factura en cada parada de la hoja de ruta
--  - monto_factura: lo que se factura en esa parada (las notas de crédito restan)
--  - comprobantes:  facturas / notas de crédito leídas de PDF (número, fecha, CUIT…)
--  Solo AGREGA columnas y actualiza la función que guarda la hoja.
--  No borra ni modifica datos existentes. Se puede correr más de una vez.
-- =====================================================================

alter table public.hoja_ruta_paradas add column if not exists monto_factura numeric(14,2);
alter table public.hoja_ruta_paradas add column if not exists comprobantes jsonb not null default '[]'::jsonb;

-- Guarda la hoja y sus paradas en una sola operación (igual que antes + montos)
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

grant execute on function public.guardar_hoja_ruta(jsonb, jsonb) to authenticated;

-- Para que la API de Supabase vea las columnas nuevas enseguida
notify pgrst, 'reload schema';
