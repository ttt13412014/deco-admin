-- =====================================================================
-- Migración 10 · Tipos de comprobante de venta + edición de cheques emitidos
-- Correr DESPUÉS de las migraciones 02 a 09. Se puede correr más de una vez.
-- No borra ni cambia el sentido de ningún dato existente.
--
-- 1) facturas.tipo: factura_a, nota_credito_a, nota_debito_a, factura_b,
--    nota_credito_b, nota_debito_b, presupuesto, anula_presupuesto.
--    facturas.signo (calculada): +1 suman a la deuda / totales, −1 restan
--    (notas de crédito y anula presupuesto). monto y saldo siguen siempre positivos.
--    Los comprobantes que ya existían se clasifican por su texto (tipo_comprobante):
--    "Factura A/B/E", "Nota de débito A/B", "Remito / Presupuesto"… todos suman,
--    igual que antes, así que ningún total cambia.
-- 2) Las notas de crédito no se "cobran": se imputan contra una factura del
--    mismo cliente (cob_imputar_credito). No entra plata a Caja.
-- 3) v_clientes_saldos: saldo con signo (las NC restan).
-- 4) Importación de Sintesys: reconoce NC/ND/presupuestos y los importes negativos.
-- 5) tes_cheque_editar: corrige un cheque emitido con las mismas validaciones
--    del alta y actualiza el pago vinculado.
-- =====================================================================

-- ---------- 1. Tipo de comprobante -----------------------------------
alter table public.facturas add column if not exists tipo text;

-- Clasifica un texto libre (lo que cargaba la app o trae Sintesys). Misma lógica que lib/comprobantes.ts
create or replace function public.factura_tipo_de(p_texto text, p_negativo boolean default false) returns text
language plpgsql immutable set search_path = public as $$
declare
  t text := upper(translate(coalesce(p_texto, ''), 'áéíóúÁÉÍÓÚüÜ', 'aeiouAEIOUuU'));
  clase text;
  letra text;
begin
  if lower(trim(coalesce(p_texto, ''))) in ('factura_a','nota_credito_a','nota_debito_a','factura_b','nota_credito_b','nota_debito_b','presupuesto','anula_presupuesto') then
    return lower(trim(p_texto));
  end if;
  if t ~ 'ANULA' and t ~ 'PRESUP' then clase := 'anula_presupuesto';
  elsif t ~ 'PRESUP|REMITO|(^|[^A-Z])X($|[^A-Z])' then clase := 'presupuesto';
  elsif t ~ 'NOTA\s+DE\s+CRED|(^|[^A-Z])N/?C[ABCEM]?($|[^A-Z])|(^|[^A-Z])NCE?($|[^A-Z])' then clase := 'nota_credito';
  elsif t ~ 'NOTA\s+DE\s+DEB|(^|[^A-Z])N/?D[ABCEM]?($|[^A-Z])|(^|[^A-Z])NDE?($|[^A-Z])' then clase := 'nota_debito';
  else clase := 'factura';
  end if;
  if coalesce(p_negativo, false) then
    if clase = 'presupuesto' then clase := 'anula_presupuesto';
    elsif clase in ('factura','nota_debito') then clase := 'nota_credito';
    end if;
  end if;
  if clase in ('presupuesto','anula_presupuesto') then return clase; end if;
  letra := (regexp_match(t, '(?:^|[^A-Z/])(?:FCE|FC|FAC|FA|NCE|NC|NDE|ND|N/C|N/D)?\s*([ABCEM])(?:[^A-Z]|$)'))[1];
  return clase || '_' || case when letra in ('B','C','E') then 'b' else 'a' end;
end $$;

-- Comprobantes existentes: se clasifican por el texto (sin disparar triggers: no cambia updated_at ni la auditoría)
do $$
begin
  if exists (select 1 from public.facturas where tipo is null) then
    alter table public.facturas disable trigger user;
    update public.facturas set tipo = public.factura_tipo_de(tipo_comprobante) where tipo is null;
    alter table public.facturas enable trigger user;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'facturas_tipo_chk') then
    alter table public.facturas add constraint facturas_tipo_chk
      check (tipo in ('factura_a','nota_credito_a','nota_debito_a','factura_b','nota_credito_b','nota_debito_b','presupuesto','anula_presupuesto'));
  end if;
end $$;
alter table public.facturas alter column tipo set not null;

alter table public.facturas add column if not exists signo smallint
  generated always as (case when tipo in ('nota_credito_a','nota_credito_b','anula_presupuesto') then -1 else 1 end) stored;

create index if not exists facturas_tipo_idx on public.facturas (tipo);

comment on column public.facturas.tipo  is 'Tipo de comprobante de venta. Facturas, notas de débito y presupuestos suman; notas de crédito y anula presupuesto restan.';
comment on column public.facturas.signo is '+1 suma a la deuda del cliente y a los totales · −1 resta (NC / anula presupuesto). monto y saldo son siempre positivos.';

-- Reglas de facturas (versión de la migración 08 + tipo)
create or replace function public.tg_facturas_reglas() returns trigger
language plpgsql security definer set search_path = public as $$
declare est text;
  imp boolean := coalesce(current_setting('imp.sintesys', true), '') = '1';
begin
  if tg_op = 'INSERT' then
    new.tipo := coalesce(nullif(lower(trim(new.tipo)), ''), public.factura_tipo_de(new.tipo_comprobante));
    select estado into est from public.clientes where id = new.cliente_id;
    -- Lo que viene de Sintesys ya está facturado oficialmente: no se bloquea por el estado del cliente
    if est is distinct from 'activo' and new.origen <> 'sintesys' then
      raise exception 'El cliente no está habilitado para facturación (A01/A03). Validalo primero.';
    end if;
    if new.origen <> 'sintesys' then new.ajuste_previo := 0; end if;
    new.ajuste_previo := greatest(0, least(coalesce(new.ajuste_previo, 0), new.monto));
    new.saldo  := new.monto - new.ajuste_previo;
    new.estado := case when new.saldo <= 0 then 'cobrado' else 'pendiente' end;
    new.fecha_cobro := null;
    new.vencimiento_original := new.fecha_vencimiento;
  else
    new.tipo := coalesce(nullif(lower(trim(new.tipo)), ''), old.tipo, public.factura_tipo_de(new.tipo_comprobante));
    -- El vencimiento original no se pierde nunca
    new.vencimiento_original := old.vencimiento_original;
    -- A05: no cambiar fechas ni medio de pago sin autorización (solo Gerencia, o la reimportación de Sintesys)
    if (new.fecha_vencimiento   is distinct from old.fecha_vencimiento
     or new.medio_pago_acordado is distinct from old.medio_pago_acordado
     or new.monto               is distinct from old.monto
     or new.cliente_id          is distinct from old.cliente_id)
     and not public.es_gerencia() and not imp then
      raise exception 'Cambiar vencimiento, monto, cliente o medio de pago requiere autorización de Gerencia (A05).';
    end if;
    -- Cambiar el tipo da vuelta el signo (suma ↔ resta): solo Gerencia
    if old.tipo is not null and new.tipo is distinct from old.tipo and not public.es_gerencia() then
      raise exception 'Cambiar el tipo de comprobante requiere autorización de Gerencia.';
    end if;
    if new.ajuste_previo is distinct from old.ajuste_previo and coalesce(current_setting('cob.ajuste', true), '') <> '1' and not imp then
      raise exception 'El ajuste de saldo se hace desde "Ajustar con Sintesys", con motivo.';
    end if;
    if new.estado = 'anulada' and old.estado <> 'anulada' and not public.es_gerencia() then
      raise exception 'Solo Gerencia puede anular comprobantes.';
    end if;
    if new.monto is distinct from old.monto or new.ajuste_previo is distinct from old.ajuste_previo then
      new.saldo := new.monto - new.ajuste_previo - coalesce((select sum(monto) from public.cobros where factura_id = new.id), 0);
      if new.estado <> 'anulada' then new.estado := case when new.saldo <= 0 then 'cobrado' else 'pendiente' end; end if;
    end if;
  end if;
  return new;
end $$;

-- ---------- 2. Cobros e imputación de créditos ------------------------
create or replace function public.tg_cobros_validar() returns trigger
language plpgsql set search_path = public as $$
declare f public.facturas;
begin
  select * into f from public.facturas where id = new.factura_id for update;
  if f.estado = 'anulada' then raise exception 'La factura está anulada'; end if;
  if f.signo < 0 and coalesce(current_setting('cob.imputacion', true), '') <> '1' then
    raise exception 'Las notas de crédito y las anulaciones de presupuesto no se cobran: se imputan contra una factura del cliente.';
  end if;
  if new.monto > f.saldo then
    raise exception 'El cobro (%) supera el saldo de la factura (%). Verificá coincidencia con la factura (A05).', new.monto, f.saldo;
  end if;
  return new;
end $$;

-- Igual que la migración 08, pero una imputación de crédito no da por cumplida una promesa de pago
create or replace function public.tg_cobros_recalcular() returns trigger
language plpgsql security definer set search_path = public as $$
declare fid uuid; cobrado numeric; ultima date;
begin
  if tg_op = 'DELETE' then fid := old.factura_id; else fid := new.factura_id; end if;
  select coalesce(sum(monto), 0), max(fecha) into cobrado, ultima from public.cobros where factura_id = fid;
  update public.facturas f
     set saldo       = f.monto - f.ajuste_previo - cobrado,
         estado      = case when f.estado = 'anulada' then 'anulada'
                            when f.monto - f.ajuste_previo - cobrado <= 0 then 'cobrado' else 'pendiente' end,
         fecha_cobro = case when f.monto - f.ajuste_previo - cobrado <= 0 then ultima else null end
   where f.id = fid;
  -- Promesas de pago de esa factura (o del cliente sin factura) quedan cumplidas
  if tg_op = 'INSERT' and coalesce(current_setting('cob.imputacion', true), '') <> '1' then
    update public.cob_promesas p set estado = 'cumplida', cumplida_at = now()
     where p.estado = 'pendiente'
       and (p.factura_id = fid or (p.factura_id is null and p.cliente_id = (select cliente_id from public.facturas where id = fid)));
  end if;
  return null;
end $$;

-- Imputa una nota de crédito / anula presupuesto contra una factura, ND o presupuesto del mismo cliente.
-- Baja el saldo de los dos comprobantes (queda como "cobro" de medio "Nota de crédito"). No entra a Caja.
create or replace function public.cob_imputar_credito(p_credito uuid, p_factura uuid, p_monto numeric default null) returns numeric
language plpgsql set search_path = public as $$
declare cr public.facturas; fa public.facturas; v numeric; maximo numeric;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  select * into cr from public.facturas where id = p_credito for update;
  select * into fa from public.facturas where id = p_factura for update;
  if cr.id is null or fa.id is null then raise exception 'Comprobante inexistente.'; end if;
  if cr.signo > 0 then raise exception 'Lo que se imputa tiene que ser una nota de crédito o una anulación de presupuesto.'; end if;
  if fa.signo < 0 then raise exception 'El crédito se imputa contra una factura, nota de débito o presupuesto.'; end if;
  if cr.cliente_id <> fa.cliente_id then raise exception 'Los dos comprobantes tienen que ser del mismo cliente.'; end if;
  if cr.estado <> 'pendiente' or fa.estado <> 'pendiente' then raise exception 'Los dos comprobantes tienen que estar pendientes.'; end if;
  maximo := least(cr.saldo, fa.saldo);
  v := round(coalesce(p_monto, maximo), 2);
  if v is null or v <= 0 or v > maximo then raise exception 'Importe inválido: podés imputar hasta %.', maximo; end if;
  perform set_config('cob.imputacion', '1', true);
  insert into public.cobros (factura_id, fecha, monto, medio_pago, referencia, observaciones)
  values (fa.id, public.hoy(), v, 'Nota de crédito', format('%s %s', cr.tipo_comprobante, cr.numero), 'Imputación de crédito (no entra a Caja)');
  insert into public.cobros (factura_id, fecha, monto, medio_pago, referencia, observaciones)
  values (cr.id, public.hoy(), v, 'Imputación', format('%s %s', fa.tipo_comprobante, fa.numero), 'Crédito imputado (no entra a Caja)');
  perform set_config('cob.imputacion', '', true);
  insert into public.gestiones_cobranza (factura_id, cliente_id, tipo, nota) values
    (fa.id, fa.cliente_id, 'otro', format('Se imputó %s de %s %s', v, cr.tipo_comprobante, cr.numero)),
    (cr.id, cr.cliente_id, 'otro', format('Imputado %s contra %s %s', v, fa.tipo_comprobante, fa.numero));
  return v;
end $$;

-- ---------- 3. Saldos por cliente (con signo) -------------------------
create or replace view public.v_clientes_saldos with (security_invoker = true) as
select c.*,
       coalesce(sum(f.signo * f.saldo), 0) as saldo,
       -- Lo vencido de facturas/ND/presupuestos, descontando los créditos a favor (nunca más que el saldo)
       greatest(0, least(coalesce(sum(f.signo * f.saldo), 0),
                         coalesce(sum(f.saldo) filter (where f.signo > 0 and f.fecha_vencimiento < public.hoy()), 0))) as vencido,
       count(f.id) as facturas_pendientes
  from public.clientes c
  left join public.facturas f on f.cliente_id = c.id and f.estado = 'pendiente'
 group by c.id;

-- ---------- 4. Importación de Sintesys (reconoce el tipo) -------------
create or replace function public.cob_importar_sintesys(p_filas jsonb, p_archivo text default null) returns jsonb
language plpgsql set search_path = public as $$
declare
  lote uuid; r jsonb; f public.facturas; cid uuid; n_new int := 0; n_upd int := 0; n_same int := 0; n_saldadas int := 0;
  errs jsonb := '[]'::jsonb; v_tipo text; v_cod text; v_num text; v_monto numeric; v_saldo numeric; v_venc date; v_emi date; i int := 0;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso para importar.'; end if;
  insert into public.imp_lotes (tipo, archivo, filas) values ('cobrar', p_archivo, jsonb_array_length(p_filas)) returning id into lote;
  perform set_config('imp.sintesys', '1', true);
  for r in select * from jsonb_array_elements(p_filas) loop
    i := i + 1;
    begin
      v_tipo := coalesce(nullif(trim(r->>'tipo_comprobante'), ''), 'Comprobante');
      v_num := trim(r->>'numero');
      v_monto := abs((r->>'monto')::numeric);
      v_saldo := abs(coalesce((r->>'saldo')::numeric, (r->>'monto')::numeric));
      -- El tipo lo manda la app ya clasificado; si no, se deduce del texto (y del signo del importe)
      v_cod := coalesce(nullif(lower(trim(r->>'tipo')), ''),
                        public.factura_tipo_de(v_tipo, coalesce((r->>'negativo')::boolean, false) or (r->>'monto')::numeric < 0));
      v_emi := coalesce((r->>'fecha_emision')::date, (r->>'fecha_vencimiento')::date, public.hoy());
      v_venc := greatest(coalesce((r->>'fecha_vencimiento')::date, v_emi), v_emi);
      if coalesce(v_num, '') = '' then raise exception 'falta el número de comprobante'; end if;
      if v_monto is null or v_monto <= 0 then raise exception 'importe inválido'; end if;
      select * into f from public.facturas where tipo_comprobante = v_tipo and numero = v_num;
      if f.id is not null then
        if (f.vendedor, f.saldo_sintesys, f.fecha_vencimiento) is not distinct from (coalesce(nullif(r->>'vendedor', ''), f.vendedor), v_saldo, v_venc) then
          n_same := n_same + 1;
          update public.facturas set ult_lote = lote where id = f.id;
        else
          perform set_config('hist.motivo', 'Reimportación de Sintesys', true);
          update public.facturas
             set vendedor = coalesce(nullif(r->>'vendedor', ''), vendedor), saldo_sintesys = v_saldo,
                 fecha_vencimiento = greatest(v_venc, fecha_emision), ult_lote = lote
           where id = f.id;
          perform set_config('hist.motivo', '', true);
          n_upd := n_upd + 1;
        end if;
      else
        if v_saldo <= 0 then n_saldadas := n_saldadas + 1; continue; end if;
        cid := nullif(r->>'cliente_id', '')::uuid;
        if cid is null then
          select id into cid from public.clientes where cuit_dni = nullif(regexp_replace(coalesce(r->'cliente_nuevo'->>'cuit', ''), '[^0-9]', '', 'g'), '');
        end if;
        if cid is null then
          if coalesce(trim(r->'cliente_nuevo'->>'razon_social'), '') = '' then raise exception 'falta el cliente'; end if;
          insert into public.clientes (razon_social, cuit_dni, estado, observaciones)
          values (trim(r->'cliente_nuevo'->>'razon_social'), nullif(regexp_replace(coalesce(r->'cliente_nuevo'->>'cuit', ''), '[^0-9]', '', 'g'), ''),
                  'pendiente', 'Creado desde la importación de Sintesys')
          returning id into cid;
        end if;
        insert into public.facturas (cliente_id, tipo_comprobante, tipo, numero, fecha_emision, fecha_vencimiento, medio_pago_acordado, monto,
                                     origen, vendedor, ajuste_previo, saldo_sintesys, ult_lote, observaciones)
        values (cid, v_tipo, v_cod, v_num, v_emi, v_venc, coalesce(nullif(r->>'medio_pago', ''), 'Sin informar'), v_monto,
                'sintesys', nullif(r->>'vendedor', ''), v_monto - v_saldo, v_saldo, lote, nullif(r->>'observaciones', ''));
        n_new := n_new + 1;
      end if;
    exception when others then
      errs := errs || jsonb_build_object('fila', coalesce((r->>'fila')::int, i), 'comprobante', concat_ws(' ', v_tipo, v_num), 'error', sqlerrm);
    end;
  end loop;
  perform set_config('imp.sintesys', '', true);
  update public.imp_lotes set nuevas = n_new, actualizadas = n_upd, sin_cambios = n_same, errores = errs where id = lote;
  return jsonb_build_object('lote', lote, 'nuevas', n_new, 'actualizadas', n_upd, 'sin_cambios', n_same, 'saldadas', n_saldadas, 'errores', errs);
end $$;

-- ---------- 5. Editar un cheque emitido -------------------------------
-- Pendiente de débito (estado "emitido"): se corrigen todos los datos, con las validaciones del alta.
-- Ya debitado, rechazado o anulado: solo los datos descriptivos (número, banco, proveedor, CUIT, emisión, observaciones).
-- Cambiar el importe de un pago ya autorizado necesita a Gerencia (A08). El pago vinculado se actualiza solo.
create or replace function public.tes_cheque_editar(p_cheque uuid, p jsonb) returns void
language plpgsql set search_path = public as $$
declare
  c public.tes_cheques;
  m public.tes_movimientos;
  o public.pag_obligaciones;
  completo boolean;
  v_formato text; v_numero text; v_banco text; v_contra text; v_cuit text; v_obs text;
  v_imp numeric; v_emi date; v_pago date; v_cuenta uuid;
  auto_old text; auto_new text;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  select * into c from public.tes_cheques where id = p_cheque for update;
  if c.id is null then raise exception 'Cheque inexistente.'; end if;
  if c.sentido <> 'emitido' then raise exception 'Desde acá se corrigen solo los cheques emitidos.'; end if;
  completo := c.estado = 'emitido';

  v_formato := coalesce(nullif(p->>'formato', ''), c.formato);
  v_numero  := nullif(trim(coalesce(p->>'numero', c.numero)), '');
  v_banco   := case when p ? 'banco' then nullif(trim(p->>'banco'), '') else c.banco end;
  v_contra  := nullif(trim(coalesce(p->>'contraparte', c.contraparte)), '');
  v_cuit    := case when p ? 'cuit' then nullif(trim(p->>'cuit'), '') else c.cuit end;
  v_emi     := case when p ? 'fecha_emision' then nullif(p->>'fecha_emision', '')::date else c.fecha_emision end;
  v_obs     := case when p ? 'observaciones' then nullif(trim(p->>'observaciones'), '') else c.observaciones end;
  v_imp     := case when p ? 'importe' then nullif(p->>'importe', '')::numeric else c.importe end;
  v_pago    := case when p ? 'fecha_pago' then nullif(p->>'fecha_pago', '')::date else c.fecha_pago end;
  v_cuenta  := case when p ? 'cuenta_id' then nullif(p->>'cuenta_id', '')::uuid else c.cuenta_id end;

  if v_formato not in ('fisico','echeq') then raise exception 'Formato inválido (físico o e-cheq).'; end if;
  if v_numero is null then raise exception 'Cargá número y fecha de pago del cheque.'; end if;
  if v_contra is null then raise exception 'Indicá a quién se le emitió el cheque.'; end if;

  if completo then
    if v_pago is null then raise exception 'Cargá número y fecha de pago del cheque.'; end if;
    if v_imp is null or v_imp <= 0 then raise exception 'Importe inválido.'; end if;
    v_imp := round(v_imp, 2);
    if v_cuenta is null then raise exception 'Elegí la cuenta de débito.'; end if;
    if not exists (select 1 from public.tes_cuentas where id = v_cuenta and (activa or id = c.cuenta_id)) then
      raise exception 'La cuenta elegida no existe o está inactiva.';
    end if;
    if v_imp <> c.importe and not public.es_gerencia() then
      raise exception 'Cambiar el importe de un cheque emitido requiere autorización de Gerencia (A08).';
    end if;
  elsif (v_imp, v_pago, v_cuenta) is distinct from (c.importe, c.fecha_pago, c.cuenta_id) then
    raise exception 'El cheque ya está %: solo se pueden corregir número, banco, proveedor, CUIT, fecha de emisión y observaciones.', c.estado;
  end if;

  if c.estado <> 'anulado' and exists (
       select 1 from public.tes_cheques x
        where x.id <> c.id and x.sentido = 'emitido' and x.estado <> 'anulado'
          and x.numero = v_numero and coalesce(x.banco, '') = coalesce(v_banco, '')) then
    raise exception 'Ya hay otro cheque emitido con el número % (%).', v_numero, coalesce(v_banco, 'sin banco');
  end if;

  select * into m from public.tes_movimientos
   where cheque_id = c.id and sentido = 'salida' and estado <> 'anulado'
   order by created_at limit 1;

  if completo and m.id is not null and m.obligacion_id is not null and v_imp > c.importe then
    select * into o from public.pag_obligaciones where id = m.obligacion_id;
    if v_imp - c.importe > coalesce(o.saldo, 0) + 0.004 then
      raise exception 'El nuevo importe supera lo que queda por pagar de esa obligación (%).', o.saldo;
    end if;
  end if;

  update public.tes_cheques
     set formato = v_formato, numero = v_numero, banco = v_banco, contraparte = v_contra, cuit = v_cuit,
         importe = v_imp, fecha_emision = v_emi, fecha_pago = v_pago, cuenta_id = v_cuenta, observaciones = v_obs
   where id = c.id;

  if m.id is not null then
    auto_old := format('%s N° %s', case when c.formato = 'echeq' then 'E-cheq' else 'Cheque' end, c.numero);
    auto_new := format('%s N° %s', case when v_formato = 'echeq' then 'E-cheq' else 'Cheque' end, v_numero);
    perform set_config('tes.bypass_aut', '1', true);
    update public.tes_movimientos
       set comprobante    = case when comprobante is null or comprobante = auto_old then auto_new else comprobante end,
           contraparte    = case when contraparte is not distinct from c.contraparte then v_contra else contraparte end,
           importe        = case when completo then v_imp else importe end,
           cuenta_id      = case when completo then v_cuenta else cuenta_id end,
           fecha_prevista = case when completo then greatest(v_pago, fecha) else fecha_prevista end,
           medio          = case when completo and medio in ('cheque','echeq') then case when v_formato = 'echeq' then 'echeq' else 'cheque' end else medio end
     where id = m.id;
    perform set_config('tes.bypass_aut', '', true);
  end if;
end $$;

-- ---------- Permisos de las funciones nuevas --------------------------
revoke execute on function public.cob_imputar_credito(uuid, uuid, numeric) from public, anon;
grant  execute on function public.cob_imputar_credito(uuid, uuid, numeric) to authenticated;
revoke execute on function public.tes_cheque_editar(uuid, jsonb) from public, anon;
grant  execute on function public.tes_cheque_editar(uuid, jsonb) to authenticated;
revoke execute on function public.factura_tipo_de(text, boolean) from public, anon;
grant  execute on function public.factura_tipo_de(text, boolean) to authenticated;
