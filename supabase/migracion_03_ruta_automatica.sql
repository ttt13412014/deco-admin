-- =====================================================================
--  MIGRACIÓN 03 · Ruta automática (ubicación de clientes y paradas)
--  Correr si ya ejecutaste schema.sql o migracion_02 antes de esta versión.
-- =====================================================================

alter table public.clientes add column if not exists lat double precision;
alter table public.clientes add column if not exists lng double precision;
alter table public.hoja_ruta_paradas add column if not exists lat double precision;
alter table public.hoja_ruta_paradas add column if not exists lng double precision;

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

drop view if exists public.v_clientes_saldos;
create view public.v_clientes_saldos with (security_invoker = true) as
select c.*,
       coalesce(sum(f.saldo), 0)                                                    as saldo,
       coalesce(sum(f.saldo) filter (where f.fecha_vencimiento < public.hoy()), 0) as vencido,
       count(f.id)                                                                  as facturas_pendientes
  from public.clientes c
  left join public.facturas f on f.cliente_id = c.id and f.estado = 'pendiente'
 group by c.id;

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
      (hoja_id, orden, cliente_id, destino, direccion, telefono, que_lleva, bultos, observaciones, entregado, entregado_at, nota_entrega, lat, lng)
    values (hid, i, nullif(p->>'cliente_id', '')::uuid, p->>'destino', p->>'direccion', p->>'telefono', p->>'que_lleva',
            nullif(p->>'bultos', '')::int, p->>'observaciones', coalesce((p->>'entregado')::boolean, false),
            nullif(p->>'entregado_at', '')::timestamptz, p->>'nota_entrega',
            nullif(p->>'lat', '')::double precision, nullif(p->>'lng', '')::double precision);
  end loop;
  return hid;
end $$;
