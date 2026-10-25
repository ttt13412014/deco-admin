-- =====================================================================
-- Migración 12 · Formato de facturación "Presupuesto" y CUIT/DNI opcional
-- Correr DESPUÉS de las migraciones 02 a 11. Se puede correr más de una vez.
-- No borra ni modifica ningún dato: solo amplía un CHECK y reemplaza la
-- función del trigger de validación de clientes.
--
--  · clientes.tipo_factura acepta 'Presupuesto' además de 'A', 'B', 'E'.
--  · El CUIT/DNI deja de ser obligatorio para habilitar (validar) un cliente.
--    Si se carga, se sigue validando el formato (11 dígitos CUIT o 7-8 DNI) y
--    se guarda solo con números; vacío se guarda como NULL (el UNIQUE de
--    cuit_dni admite muchos NULL, así que no choca entre clientes sin CUIT).
-- =====================================================================

-- ---------- 1. tipo_factura: agregar 'Presupuesto' --------------------
alter table public.clientes drop constraint if exists clientes_tipo_factura_check;
alter table public.clientes add constraint clientes_tipo_factura_check
  check (tipo_factura in ('A', 'B', 'E', 'Presupuesto'));

-- ---------- 2. CUIT/DNI opcional (también al habilitar) ---------------
alter table public.clientes alter column cuit_dni drop not null;

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
    -- CUIT/DNI ya no es obligatorio (migración 12)
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
