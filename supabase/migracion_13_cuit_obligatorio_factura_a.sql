-- =====================================================================
-- Migración 13 · CUIT obligatorio solo para clientes con Factura A
-- Correr DESPUÉS de la migración 12. Se puede correr más de una vez.
-- No borra ni modifica datos: solo reemplaza la función del trigger de
-- validación de clientes. Para habilitar (estado 'activo') un cliente con
-- tipo_factura 'A' hace falta un CUIT de 11 dígitos; B, E y Presupuesto
-- siguen con CUIT/DNI opcional. Los clientes ya guardados no se tocan.
-- =====================================================================

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
    -- CUIT/DNI opcional (migración 12), salvo Factura A: CUIT de 11 dígitos (migración 13)
    if new.tipo_factura = 'A' and coalesce(length(new.cuit_dni), 0) <> 11 then faltan := array_append(faltan, 'CUIT (Factura A)'); end if;
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
