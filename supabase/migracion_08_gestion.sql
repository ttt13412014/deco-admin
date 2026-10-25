-- =====================================================================
--  DE&CO · Migración 08 · Cuentas a Cobrar (Sintesys), Cuentas a Pagar,
--  transferencias con fecha diferida, reservas mínimas y simulaciones.
--  Requiere la migración 07 (Tesorería). Se puede correr más de una vez.
-- =====================================================================

-- ---------- Historial de cambios de fechas (cobros y pagos) ----------
create table if not exists public.hist_fechas (
  id          bigserial primary key,
  entidad     text not null check (entidad in ('factura','obligacion')),
  entidad_id  uuid not null,
  campo       text not null,
  antes       date,
  despues     date,
  motivo      text,
  usuario     uuid default auth.uid() references public.perfiles(id),
  fecha       timestamptz not null default now()
);
create index if not exists hist_fechas_ent_idx on public.hist_fechas (entidad, entidad_id);

-- ---------- Lotes de importación (Excel de Sintesys) ----------
create table if not exists public.imp_lotes (
  id           uuid primary key default gen_random_uuid(),
  tipo         text not null check (tipo in ('cobrar','pagar')),
  archivo      text,
  filas        int not null default 0,
  nuevas       int not null default 0,
  actualizadas int not null default 0,
  sin_cambios  int not null default 0,
  errores      jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid() references public.perfiles(id)
);

-- =====================================================================
--  CUENTAS A COBRAR
-- =====================================================================
alter table public.facturas add column if not exists origen               text not null default 'manual';
alter table public.facturas add column if not exists vendedor             text;
alter table public.facturas add column if not exists vencimiento_original date;
alter table public.facturas add column if not exists fecha_estimada_cobro date;
alter table public.facturas add column if not exists ajuste_previo        numeric(14,2) not null default 0;  -- cobrado antes de pasar a la app (según Sintesys)
alter table public.facturas add column if not exists saldo_sintesys       numeric(14,2);
alter table public.facturas add column if not exists ult_lote             uuid references public.imp_lotes(id);
update public.facturas set vencimiento_original = fecha_vencimiento where vencimiento_original is null;
do $$ begin
  alter table public.facturas add constraint facturas_origen_chk check (origen in ('manual','sintesys'));
exception when duplicate_object then null; end $$;

create or replace function public.tg_facturas_reglas() returns trigger
language plpgsql security definer set search_path = public as $$
declare est text;
  imp boolean := coalesce(current_setting('imp.sintesys', true), '') = '1';
begin
  if tg_op = 'INSERT' then
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
  if tg_op = 'INSERT' then
    update public.cob_promesas p set estado = 'cumplida', cumplida_at = now()
     where p.estado = 'pendiente'
       and (p.factura_id = fid or (p.factura_id is null and p.cliente_id = (select cliente_id from public.facturas where id = fid)));
  end if;
  return null;
end $$;

-- Registro de cambios de fechas (lee el motivo de la sesión, si lo hay)
create or replace function public.tg_hist_fechas() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  ent text := case when tg_table_name = 'facturas' then 'factura' else 'obligacion' end;
  mot text := nullif(current_setting('hist.motivo', true), '');
begin
  if tg_table_name = 'facturas' then
    if new.fecha_vencimiento is distinct from old.fecha_vencimiento then
      insert into public.hist_fechas (entidad, entidad_id, campo, antes, despues, motivo) values (ent, new.id, 'vencimiento', old.fecha_vencimiento, new.fecha_vencimiento, mot);
    end if;
    if new.fecha_estimada_cobro is distinct from old.fecha_estimada_cobro then
      insert into public.hist_fechas (entidad, entidad_id, campo, antes, despues, motivo) values (ent, new.id, 'fecha_estimada', old.fecha_estimada_cobro, new.fecha_estimada_cobro, mot);
    end if;
  else
    if new.vencimiento is distinct from old.vencimiento then
      insert into public.hist_fechas (entidad, entidad_id, campo, antes, despues, motivo) values (ent, new.id, 'vencimiento', old.vencimiento, new.vencimiento, mot);
    end if;
    if new.fecha_estimada_pago is distinct from old.fecha_estimada_pago then
      insert into public.hist_fechas (entidad, entidad_id, campo, antes, despues, motivo) values (ent, new.id, 'fecha_estimada', old.fecha_estimada_pago, new.fecha_estimada_pago, mot);
    end if;
  end if;
  return null;
end $$;
drop trigger if exists facturas_hist on public.facturas;
create trigger facturas_hist after update on public.facturas
  for each row execute function public.tg_hist_fechas();

-- Cambiar la fecha estimada de cobro (queda en el historial con motivo)
create or replace function public.cob_cambiar_fecha(p_factura uuid, p_fecha date, p_motivo text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.tiene_acceso() or public.mi_rol() = 'pendiente' then raise exception 'No tenés permiso.'; end if;
  perform set_config('hist.motivo', coalesce(p_motivo, ''), true);
  update public.facturas set fecha_estimada_cobro = p_fecha where id = p_factura;
  perform set_config('hist.motivo', '', true);
end $$;

-- Ajustar el saldo con lo que dice Sintesys (cobros hechos fuera de la app). No genera movimiento de caja.
create or replace function public.cob_ajustar_sintesys(p_factura uuid, p_saldo numeric, p_motivo text) returns void
language plpgsql as $$
declare f public.facturas; cobrado numeric;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Indicá el motivo del ajuste.'; end if;
  select * into f from public.facturas where id = p_factura for update;
  select coalesce(sum(monto), 0) into cobrado from public.cobros where factura_id = f.id;
  if p_saldo < 0 or p_saldo > f.monto - cobrado then raise exception 'Saldo inválido (entre 0 y %).', f.monto - cobrado; end if;
  perform set_config('cob.ajuste', '1', true);
  update public.facturas set ajuste_previo = f.monto - cobrado - p_saldo where id = f.id;
  perform set_config('cob.ajuste', '', true);
  insert into public.gestiones_cobranza (factura_id, cliente_id, tipo, nota)
  values (f.id, f.cliente_id, 'otro', format('Saldo ajustado con Sintesys: de %s a %s. Motivo: %s', f.saldo, p_saldo, p_motivo));
end $$;

-- Importación del Excel de Sintesys (cuentas a cobrar). No duplica: busca por tipo + número.
create or replace function public.cob_importar_sintesys(p_filas jsonb, p_archivo text default null) returns jsonb
language plpgsql as $$
declare
  lote uuid; r jsonb; f public.facturas; cid uuid; n_new int := 0; n_upd int := 0; n_same int := 0; n_saldadas int := 0;
  errs jsonb := '[]'::jsonb; v_tipo text; v_num text; v_monto numeric; v_saldo numeric; v_venc date; v_emi date; i int := 0;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso para importar.'; end if;
  insert into public.imp_lotes (tipo, archivo, filas) values ('cobrar', p_archivo, jsonb_array_length(p_filas)) returning id into lote;
  perform set_config('imp.sintesys', '1', true);
  for r in select * from jsonb_array_elements(p_filas) loop
    i := i + 1;
    begin
      v_tipo := coalesce(nullif(trim(r->>'tipo_comprobante'), ''), 'Comprobante');
      v_num := trim(r->>'numero');
      v_monto := (r->>'monto')::numeric;
      v_saldo := coalesce((r->>'saldo')::numeric, v_monto);
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
        insert into public.facturas (cliente_id, tipo_comprobante, numero, fecha_emision, fecha_vencimiento, medio_pago_acordado, monto,
                                     origen, vendedor, ajuste_previo, saldo_sintesys, ult_lote, observaciones)
        values (cid, v_tipo, v_num, v_emi, v_venc, coalesce(nullif(r->>'medio_pago', ''), 'Sin informar'), v_monto,
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

-- ---------- Promesas de pago ----------
create table if not exists public.cob_promesas (
  id           uuid primary key default gen_random_uuid(),
  cliente_id   uuid not null references public.clientes(id),
  factura_id   uuid references public.facturas(id) on delete cascade,
  fecha_promesa date not null,
  monto        numeric(14,2),
  nota         text,
  estado       text not null default 'pendiente' check (estado in ('pendiente','cumplida','cancelada')),
  cumplida_at  timestamptz,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid() references public.perfiles(id)
);
create index if not exists cob_promesas_idx on public.cob_promesas (estado, fecha_promesa);

-- Registrar una promesa: también mueve la fecha estimada de cobro (con historial)
create or replace function public.cob_registrar_promesa(p jsonb) returns uuid
language plpgsql as $$
declare pid uuid; fid uuid := nullif(p->>'factura_id', '')::uuid; cid uuid;
begin
  if not public.tiene_acceso() or public.mi_rol() = 'pendiente' then raise exception 'No tenés permiso.'; end if;
  if (p->>'fecha_promesa') is null then raise exception 'Indicá la fecha que prometió pagar.'; end if;
  cid := coalesce(nullif(p->>'cliente_id', '')::uuid, (select cliente_id from public.facturas where id = fid));
  insert into public.cob_promesas (cliente_id, factura_id, fecha_promesa, monto, nota)
  values (cid, fid, (p->>'fecha_promesa')::date, nullif(p->>'monto', '')::numeric, nullif(p->>'nota', ''))
  returning id into pid;
  if fid is not null then
    perform public.cob_cambiar_fecha(fid, (p->>'fecha_promesa')::date, 'Promesa de pago' || coalesce(': ' || nullif(p->>'nota', ''), ''));
  end if;
  insert into public.gestiones_cobranza (factura_id, cliente_id, tipo, nota)
  values (fid, cid, 'respuesta_cliente', format('Promesa de pago para el %s%s%s', to_char((p->>'fecha_promesa')::date, 'DD/MM/YYYY'),
          coalesce(' por $ ' || (p->>'monto'), ''), coalesce('. ' || nullif(p->>'nota', ''), '')));
  return pid;
end $$;

-- ---------- Pagos informados por el cliente (no tocan saldos hasta confirmarse) ----------
create table if not exists public.cob_pagos_informados (
  id            uuid primary key default gen_random_uuid(),
  cliente_id    uuid not null references public.clientes(id),
  factura_id    uuid references public.facturas(id),   -- factura sugerida (la imputación final se elige al confirmar)
  fecha         date not null default public.hoy(),
  monto         numeric(14,2) not null check (monto > 0),
  medio         text not null default 'transferencia',
  referencia    text,
  nota          text,
  estado        text not null default 'pendiente_validacion' check (estado in ('pendiente_validacion','confirmado','rechazado')),
  motivo        text,
  imputaciones  jsonb,
  validado_por  uuid references public.perfiles(id),
  validado_at   timestamptz,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid() references public.perfiles(id)
);
create index if not exists cob_pi_idx on public.cob_pagos_informados (estado);

-- Confirmar: imputa a las facturas y entra a Caja y Bancos (un movimiento por factura)
create or replace function public.cob_confirmar_pago(p_id uuid, p jsonb) returns void
language plpgsql as $$
declare pi public.cob_pagos_informados; x jsonb; total numeric := 0; n int;
begin
  if not public.puede_editar() then raise exception 'Solo Administración o Gerencia confirman pagos.'; end if;
  select * into pi from public.cob_pagos_informados where id = p_id for update;
  if pi.estado <> 'pendiente_validacion' then raise exception 'Ese pago ya está %.', pi.estado; end if;
  n := jsonb_array_length(coalesce(p->'imputaciones', '[]'::jsonb));
  if n = 0 then raise exception 'Elegí a qué factura(s) se imputa.'; end if;
  if coalesce(p->>'medio', pi.medio) in ('cheque','echeq') and n > 1 then raise exception 'Un cheque se imputa a una sola factura.'; end if;
  for x in select * from jsonb_array_elements(p->'imputaciones') loop
    total := total + (x->>'monto')::numeric;
    if (select cliente_id from public.facturas where id = (x->>'factura_id')::uuid) is distinct from pi.cliente_id then
      raise exception 'Hay una factura que no es de este cliente.';
    end if;
    perform public.tes_registrar_cobro(jsonb_build_object(
      'factura_id', x->>'factura_id', 'monto', x->>'monto', 'fecha', coalesce(p->>'fecha', pi.fecha::text),
      'medio', coalesce(p->>'medio', pi.medio), 'cuenta_id', p->>'cuenta_id', 'referencia', coalesce(pi.referencia, 'Pago informado'),
      'observaciones', 'Pago informado por el cliente y validado', 'cheque', p->'cheque'));
  end loop;
  if total > pi.monto + 0.004 then raise exception 'Lo imputado (%) supera lo informado (%).', total, pi.monto; end if;
  update public.cob_pagos_informados
     set estado = 'confirmado', imputaciones = p->'imputaciones', validado_por = auth.uid(), validado_at = now(),
         motivo = case when total < pi.monto then format('Se imputaron %s de %s', total, pi.monto) end
   where id = pi.id;
end $$;

-- =====================================================================
--  CUENTAS A PAGAR
-- =====================================================================
create table if not exists public.pag_obligaciones (
  id                  uuid primary key default gen_random_uuid(),
  origen              text not null default 'manual' check (origen in ('manual','sintesys')),
  clave               text unique,                          -- evita duplicar al reimportar (proveedor|comprobante|cuota)
  tipo                text not null default 'proveedor' check (tipo in ('proveedor','sueldos','alquiler','servicios','impuestos','gastos','cheque','prestamo','otro')),
  proveedor           text not null,
  cuit                text,
  categoria_id        uuid references public.tes_categorias(id),
  comprobante         text,
  concepto            text,
  fecha_emision       date,
  vencimiento         date,
  vencimiento_original date,
  fecha_estimada_pago date,
  importe             numeric(14,2) not null check (importe > 0),
  ajuste_previo       numeric(14,2) not null default 0,     -- pagado antes de pasar a la app (según Sintesys)
  pagado              numeric(14,2) not null default 0,
  saldo               numeric(14,2) not null default 0,
  saldo_sintesys      numeric(14,2),
  prioridad           text not null default 'media' check (prioridad in ('alta','media','baja')),
  estado              text not null default 'pendiente_decision' check (estado in
                        ('pendiente_revision','pendiente_decision','autorizado','programado','reprogramado','pagado','cancelado')),
  cuenta_id           uuid references public.tes_cuentas(id),  -- de dónde se piensa pagar
  medio_previsto      text,
  plan_id             uuid,
  cuota               int,
  cuotas              int,
  observaciones       text,
  motivo              text,
  decidido_por        uuid references public.perfiles(id),
  decidido_at         timestamptz,
  ult_lote            uuid references public.imp_lotes(id),
  created_at          timestamptz not null default now(),
  created_by          uuid default auth.uid() references public.perfiles(id),
  updated_at          timestamptz not null default now(),
  updated_by          uuid default auth.uid() references public.perfiles(id)
);
create index if not exists pag_obl_estado_idx on public.pag_obligaciones (estado, fecha_estimada_pago, vencimiento);
create index if not exists pag_obl_plan_idx on public.pag_obligaciones (plan_id);

alter table public.tes_movimientos add column if not exists obligacion_id uuid references public.pag_obligaciones(id);
create index if not exists tes_mov_obl_idx on public.tes_movimientos (obligacion_id);

create or replace function public.tg_pag_reglas() returns trigger
language plpgsql security definer set search_path = public as $$
declare imp boolean := coalesce(current_setting('imp.sintesys', true), '') = '1';
  sis boolean := coalesce(current_setting('pag.recalc', true), '') = '1';
begin
  if tg_op = 'INSERT' then
    new.vencimiento_original := new.vencimiento;
    new.pagado := 0;
    new.ajuste_previo := greatest(0, least(coalesce(new.ajuste_previo, 0), new.importe));
    new.saldo := new.importe - new.ajuste_previo;
    if new.estado in ('autorizado','programado','reprogramado') and not public.es_gerencia() then
      raise exception 'Solo los dueños (Gerencia) deciden qué se paga.';
    end if;
    if new.estado = 'pagado' or new.saldo <= 0 then new.estado := 'pagado'; end if;
    if new.estado in ('autorizado','programado','reprogramado') then new.decidido_por := auth.uid(); new.decidido_at := now(); end if;
    return new;
  end if;
  new.vencimiento_original := old.vencimiento_original;
  if sis then return new; end if;   -- recálculo automático de pagos
  if new.estado is distinct from old.estado then
    if new.estado = 'pagado' then raise exception 'El estado "Pagado" lo pone el sistema cuando se registran los pagos.'; end if;
    if old.estado = 'pagado' and not public.es_gerencia() then raise exception 'Ya está pagada.'; end if;
    if new.estado in ('autorizado','programado','cancelado') and old.estado not in ('autorizado','programado','reprogramado')
       and not public.es_gerencia() then
      raise exception 'Solo los dueños (Gerencia) deciden qué se paga, se programa o se cancela.';
    end if;
    if new.estado = 'cancelado' and not public.es_gerencia() then raise exception 'Solo Gerencia cancela obligaciones.'; end if;
    if new.estado = 'cancelado' and coalesce(trim(new.motivo), '') = '' then raise exception 'Indicá el motivo de la cancelación.'; end if;
    if new.estado = 'cancelado' and new.pagado > 0 then raise exception 'Tiene pagos registrados: no se puede cancelar.'; end if;
    if new.estado in ('autorizado','programado') then new.decidido_por := auth.uid(); new.decidido_at := now(); end if;
  end if;
  -- Si Administración cambia el importe de algo ya decidido, vuelve a decisión
  if new.importe is distinct from old.importe then
    if new.importe < old.pagado + old.ajuste_previo then raise exception 'El importe no puede ser menor a lo ya pagado.'; end if;
    new.saldo := new.importe - new.ajuste_previo - new.pagado;
    if old.estado in ('autorizado','programado','reprogramado') and not public.es_gerencia() and not imp then
      new.estado := 'pendiente_decision'; new.decidido_por := null; new.decidido_at := null;
    end if;
  end if;
  -- Cambio de fecha estimada sobre algo decidido: queda "Reprogramado" (sigue autorizado)
  if new.fecha_estimada_pago is distinct from old.fecha_estimada_pago and old.estado in ('autorizado','programado')
     and new.estado = old.estado and old.fecha_estimada_pago is not null then
    new.estado := 'reprogramado';
  end if;
  if new.vencimiento is distinct from old.vencimiento and not public.es_gerencia() and not imp then
    raise exception 'El vencimiento lo cambia Gerencia o la reimportación de Sintesys. Para mover el pago, cambiá la fecha estimada.';
  end if;
  return new;
end $$;
drop trigger if exists pag_reglas on public.pag_obligaciones;
create trigger pag_reglas before insert or update on public.pag_obligaciones for each row execute function public.tg_pag_reglas();
drop trigger if exists pag_updated on public.pag_obligaciones;
create trigger pag_updated before update on public.pag_obligaciones for each row execute function public.tg_updated();
drop trigger if exists pag_audit on public.pag_obligaciones;
create trigger pag_audit after insert or update or delete on public.pag_obligaciones for each row execute function public.tg_auditoria();
drop trigger if exists pag_hist on public.pag_obligaciones;
create trigger pag_hist after update on public.pag_obligaciones for each row execute function public.tg_hist_fechas();

-- Recalcula lo pagado: cuenta lo realizado y los cheques entregados (la deuda con el proveedor queda saldada)
create or replace function public.pag_recalcular(p_obl uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o public.pag_obligaciones; pag numeric;
begin
  select * into o from public.pag_obligaciones where id = p_obl for update;
  if o.id is null then return; end if;
  select coalesce(sum(importe), 0) into pag from public.tes_movimientos
   where obligacion_id = p_obl and estado <> 'anulado' and (estado = 'realizado' or cheque_id is not null);
  perform set_config('pag.recalc', '1', true);
  update public.pag_obligaciones
     set pagado = pag, saldo = importe - ajuste_previo - pag,
         estado = case when importe - ajuste_previo - pag <= 0 then 'pagado'
                       when estado = 'pagado' then 'autorizado' else estado end
   where id = p_obl;
  perform set_config('pag.recalc', '', true);
end $$;

create or replace function public.tg_tes_mov_obl() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE','DELETE') and old.obligacion_id is not null then perform public.pag_recalcular(old.obligacion_id); end if;
  if tg_op in ('INSERT','UPDATE') and new.obligacion_id is not null then
    perform public.pag_recalcular(new.obligacion_id);
  end if;
  return null;
end $$;
drop trigger if exists tes_mov_obl on public.tes_movimientos;
create trigger tes_mov_obl after insert or update or delete on public.tes_movimientos for each row execute function public.tg_tes_mov_obl();

-- Un cheque emitido para una obligación que se rechaza o anula: el pago se anula y la deuda vuelve
create or replace function public.tg_tes_mov_a_obl() returns trigger
language plpgsql as $$
begin
  if new.obligacion_id is not null and old.cheque_id is not null and new.cheque_id is null and new.estado <> 'anulado' then
    new.estado := 'anulado';
    new.motivo_anulacion := coalesce(nullif(new.observaciones, ''), 'Cheque rechazado o anulado');
  end if;
  return new;
end $$;
drop trigger if exists tes_mov_a_obl on public.tes_movimientos;
create trigger tes_mov_a_obl before update on public.tes_movimientos for each row execute function public.tg_tes_mov_a_obl();

-- Registrar un pago (total o parcial) de una obligación decidida. Crea el egreso en Caja y Bancos.
create or replace function public.pag_registrar_pago(p_obl uuid, p jsonb) returns uuid
language plpgsql as $$
declare
  o public.pag_obligaciones; imp numeric := (p->>'importe')::numeric; v_medio text := coalesce(p->>'medio', 'transferencia');
  v_cuenta uuid := nullif(p->>'cuenta_id', '')::uuid; f date := coalesce((p->>'fecha')::date, public.hoy());
  ch jsonb := p->'cheque'; chq uuid; mid uuid; cat uuid;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  select * into o from public.pag_obligaciones where id = p_obl for update;
  if o.id is null then raise exception 'Obligación inexistente.'; end if;
  if o.estado not in ('autorizado','programado','reprogramado') then
    raise exception 'Todavía no está autorizada por los dueños (estado: %). El sistema no paga nada sin decisión.', o.estado;
  end if;
  if imp is null or imp <= 0 then raise exception 'Importe inválido.'; end if;
  if imp > o.saldo + 0.004 then raise exception 'El pago (%) supera el saldo pendiente (%).', imp, o.saldo; end if;
  if v_cuenta is null and v_medio <> 'endoso' then raise exception 'Elegí la cuenta de donde sale.'; end if;
  cat := coalesce(o.categoria_id, (select id from public.tes_categorias where tipo = 'egreso' and rubro = 'Proveedores' order by orden limit 1));
  perform set_config('tes.bypass_aut', '1', true);
  if v_medio in ('cheque','echeq') then
    if coalesce(ch->>'numero', '') = '' or coalesce(ch->>'fecha_pago', '') = '' then raise exception 'Cargá número y fecha de pago del cheque.'; end if;
    insert into public.tes_cheques (sentido, formato, numero, banco, contraparte, cuit, importe, fecha_emision, fecha_pago, cuenta_id, estado)
    values ('emitido', case when v_medio = 'echeq' then 'echeq' else 'fisico' end, ch->>'numero', nullif(ch->>'banco', ''), o.proveedor, o.cuit, imp,
            coalesce(nullif(ch->>'fecha_emision', '')::date, f), (ch->>'fecha_pago')::date, v_cuenta, 'emitido')
    returning id into chq;
    insert into public.tes_movimientos (fecha, tipo, sentido, categoria_id, concepto, contraparte, medio, cuenta_id, importe, fecha_prevista, estado, comprobante, cheque_id, obligacion_id)
    values (f, 'egreso', 'salida', cat, coalesce(o.concepto, o.comprobante, 'Pago') , o.proveedor, v_medio, v_cuenta, imp, greatest((ch->>'fecha_pago')::date, f), 'autorizado',
            coalesce(nullif(p->>'comprobante', ''), format('%s N° %s', case when v_medio = 'echeq' then 'E-cheq' else 'Cheque' end, ch->>'numero')), chq, o.id)
    returning id into mid;
  else
    if coalesce(trim(p->>'comprobante'), '') = '' then raise exception 'Cargá el comprobante u orden de pago.'; end if;
    insert into public.tes_movimientos (fecha, tipo, sentido, categoria_id, concepto, contraparte, medio, cuenta_id, importe, fecha_prevista, fecha_efectiva, estado, comprobante, observaciones, obligacion_id)
    values (f, 'egreso', 'salida', cat, coalesce(o.concepto, o.comprobante, 'Pago'), o.proveedor, v_medio, v_cuenta, imp, f, f, 'realizado',
            p->>'comprobante', nullif(p->>'observaciones', ''), o.id)
    returning id into mid;
  end if;
  perform set_config('tes.bypass_aut', '', true);
  return mid;
end $$;

-- Cambiar la fecha estimada de pago (con motivo, queda en el historial)
create or replace function public.pag_cambiar_fecha(p_obl uuid, p_fecha date, p_motivo text) returns void
language plpgsql as $$
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  perform set_config('hist.motivo', coalesce(p_motivo, ''), true);
  update public.pag_obligaciones set fecha_estimada_pago = p_fecha where id = p_obl;
  perform set_config('hist.motivo', '', true);
end $$;

-- Importación de cuentas a pagar de Sintesys. No duplica: usa la clave proveedor|comprobante.
create or replace function public.pag_importar_sintesys(p_filas jsonb, p_archivo text default null) returns jsonb
language plpgsql as $$
declare
  lote uuid; r jsonb; o public.pag_obligaciones; n_new int := 0; n_upd int := 0; n_same int := 0; n_saldadas int := 0;
  errs jsonb := '[]'::jsonb; v_imp numeric; v_saldo numeric; v_venc date; i int := 0;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso para importar.'; end if;
  insert into public.imp_lotes (tipo, archivo, filas) values ('pagar', p_archivo, jsonb_array_length(p_filas)) returning id into lote;
  perform set_config('imp.sintesys', '1', true);
  for r in select * from jsonb_array_elements(p_filas) loop
    i := i + 1;
    begin
      if coalesce(r->>'clave', '') = '' then raise exception 'falta proveedor o comprobante'; end if;
      v_imp := (r->>'importe')::numeric;
      v_saldo := coalesce((r->>'saldo')::numeric, v_imp);
      v_venc := (r->>'vencimiento')::date;
      if v_imp is null or v_imp <= 0 then raise exception 'importe inválido'; end if;
      select * into o from public.pag_obligaciones where clave = r->>'clave';
      if o.id is not null then
        if (o.saldo_sintesys, o.vencimiento) is not distinct from (v_saldo, coalesce(v_venc, o.vencimiento)) then
          n_same := n_same + 1;
          update public.pag_obligaciones set ult_lote = lote where id = o.id;
        else
          perform set_config('hist.motivo', 'Reimportación de Sintesys', true);
          update public.pag_obligaciones set saldo_sintesys = v_saldo, vencimiento = coalesce(v_venc, vencimiento), ult_lote = lote where id = o.id;
          perform set_config('hist.motivo', '', true);
          n_upd := n_upd + 1;
        end if;
      else
        if v_saldo <= 0 then n_saldadas := n_saldadas + 1; continue; end if;
        insert into public.pag_obligaciones (origen, clave, tipo, proveedor, cuit, categoria_id, comprobante, concepto, fecha_emision, vencimiento,
                                            importe, ajuste_previo, saldo_sintesys, estado, ult_lote)
        values ('sintesys', r->>'clave', coalesce(nullif(r->>'tipo', ''), 'proveedor'), trim(r->>'proveedor'),
                nullif(regexp_replace(coalesce(r->>'cuit', ''), '[^0-9]', '', 'g'), ''), nullif(r->>'categoria_id', '')::uuid,
                nullif(r->>'comprobante', ''), nullif(r->>'concepto', ''), (r->>'fecha_emision')::date, v_venc,
                v_imp, v_imp - v_saldo, v_saldo, 'pendiente_revision', lote);
        n_new := n_new + 1;
      end if;
    exception when others then
      errs := errs || jsonb_build_object('fila', coalesce((r->>'fila')::int, i), 'comprobante', concat_ws(' ', r->>'proveedor', r->>'comprobante'), 'error', sqlerrm);
    end;
  end loop;
  perform set_config('imp.sintesys', '', true);
  update public.imp_lotes set nuevas = n_new, actualizadas = n_upd, sin_cambios = n_same, errores = errs where id = lote;
  return jsonb_build_object('lote', lote, 'nuevas', n_new, 'actualizadas', n_upd, 'sin_cambios', n_same, 'saldadas', n_saldadas, 'errores', errs);
end $$;

-- =====================================================================
--  CAJA Y BANCOS · ajustes
-- =====================================================================
alter table public.tes_cuentas add column if not exists reserva_minima numeric(14,2) not null default 0;
alter table public.tes_cuentas add column if not exists cobro_default  boolean not null default false;
alter table public.tes_cuentas add column if not exists pago_default   boolean not null default false;
update public.tes_cuentas set cobro_default = true, pago_default = true
 where codigo = 'galicia' and not exists (select 1 from public.tes_cuentas where cobro_default or pago_default);
drop trigger if exists tes_cuentas_audit on public.tes_cuentas;
create trigger tes_cuentas_audit after insert or update on public.tes_cuentas for each row execute function public.tg_auditoria();

-- Reserva mínima y cuentas por defecto (las configura Administración)
create or replace function public.tes_config_cuenta(p_cuenta uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  if p ? 'reserva_minima' then
    if (p->>'reserva_minima')::numeric < 0 then raise exception 'La reserva no puede ser negativa.'; end if;
    update public.tes_cuentas set reserva_minima = (p->>'reserva_minima')::numeric where id = p_cuenta;
  end if;
  if coalesce((p->>'cobro_default')::boolean, false) then
    update public.tes_cuentas set cobro_default = (id = p_cuenta);
  end if;
  if coalesce((p->>'pago_default')::boolean, false) then
    update public.tes_cuentas set pago_default = (id = p_cuenta);
  end if;
end $$;

-- Transferencia propia con fecha de salida y de acreditación (pueden ser distintas o futuras)
create or replace function public.tes_transferir(p jsonb) returns uuid
language plpgsql as $$
declare
  tid uuid := gen_random_uuid();
  o uuid := (p->>'origen')::uuid;
  d uuid := (p->>'destino')::uuid;
  imp numeric := (p->>'importe')::numeric;
  f date := coalesce((p->>'fecha')::date, public.hoy());
  fs date := coalesce((p->>'fecha_salida')::date, (p->>'fecha_efectiva')::date, f);
  fa date := coalesce((p->>'fecha_acreditacion')::date, fs);
  v_concepto text := coalesce(nullif(trim(p->>'concepto'), ''), 'Transferencia entre cuentas');
  v_medio text := coalesce(p->>'medio', 'transferencia');
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  if o is null or d is null or o = d then raise exception 'Elegí cuenta de origen y de destino distintas.'; end if;
  if imp is null or imp <= 0 then raise exception 'Importe inválido.'; end if;
  if fa < fs then raise exception 'La acreditación no puede ser antes de la salida.'; end if;
  insert into public.tes_movimientos (fecha, tipo, sentido, concepto, medio, cuenta_id, transferencia_id, importe, fecha_prevista, fecha_efectiva, estado, comprobante, observaciones)
  values (f, 'transferencia', 'salida', v_concepto, v_medio, o, tid, imp, fs, case when fs <= public.hoy() then fs end,
          case when fs <= public.hoy() then 'realizado' else 'pendiente' end, p->>'comprobante', p->>'observaciones'),
         (f, 'transferencia', 'entrada', v_concepto, v_medio, d, tid, imp, fa, case when fa <= public.hoy() then fa end,
          case when fa <= public.hoy() then 'realizado' else 'pendiente' end, p->>'comprobante', p->>'observaciones');
  return tid;
end $$;

-- Confirmar la salida o la acreditación de una transferencia que estaba pendiente
create or replace function public.tes_confirmar_transferencia(p_mov uuid, p_fecha date default null) returns void
language plpgsql as $$
declare m public.tes_movimientos;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  select * into m from public.tes_movimientos where id = p_mov for update;
  if m.tipo <> 'transferencia' or m.estado <> 'pendiente' then raise exception 'Solo se confirman patas de transferencia pendientes.'; end if;
  perform set_config('tes.bypass_aut', '1', true);
  update public.tes_movimientos set estado = 'realizado', fecha_efectiva = coalesce(p_fecha, public.hoy()) where id = m.id;
  perform set_config('tes.bypass_aut', '', true);
end $$;

-- Simulaciones de transferencias (no tocan saldos ni crean movimientos)
create table if not exists public.tes_simulaciones (
  id                  uuid primary key default gen_random_uuid(),
  origen              uuid not null references public.tes_cuentas(id),
  destino             uuid not null references public.tes_cuentas(id),
  importe             numeric(14,2) not null check (importe > 0),
  fecha_salida        date not null,
  fecha_acreditacion  date not null,
  nota                text,
  estado              text not null default 'activa' check (estado in ('activa','descartada','confirmada')),
  transferencia_id    uuid,
  created_at          timestamptz not null default now(),
  created_by          uuid default auth.uid() references public.perfiles(id),
  check (origen <> destino),
  check (fecha_acreditacion >= fecha_salida)
);

create or replace function public.tes_confirmar_simulacion(p_sim uuid) returns uuid
language plpgsql as $$
declare s public.tes_simulaciones; tid uuid;
begin
  if not public.es_gerencia() then raise exception 'Solo la persona autorizada (Gerencia) confirma una transferencia simulada. Administración puede cargar la transferencia real en Tesorería.'; end if;
  select * into s from public.tes_simulaciones where id = p_sim for update;
  if s.estado <> 'activa' then raise exception 'Esa simulación ya está %.', s.estado; end if;
  tid := public.tes_transferir(jsonb_build_object('origen', s.origen, 'destino', s.destino, 'importe', s.importe, 'fecha', public.hoy(),
         'fecha_salida', s.fecha_salida, 'fecha_acreditacion', s.fecha_acreditacion, 'concepto', coalesce(s.nota, 'Transferencia preventiva (simulada y confirmada)')));
  update public.tes_simulaciones set estado = 'confirmada', transferencia_id = tid where id = s.id;
  return tid;
end $$;

-- =====================================================================
--  Permisos
-- =====================================================================
alter table public.hist_fechas          enable row level security;
alter table public.imp_lotes            enable row level security;
alter table public.cob_promesas         enable row level security;
alter table public.cob_pagos_informados enable row level security;
alter table public.pag_obligaciones     enable row level security;
alter table public.tes_simulaciones     enable row level security;

drop policy if exists hist_sel on public.hist_fechas;
create policy hist_sel on public.hist_fechas for select to authenticated using (public.tiene_acceso());
drop policy if exists hist_ins on public.hist_fechas;
create policy hist_ins on public.hist_fechas for insert to authenticated with check (public.tiene_acceso());

drop policy if exists lotes_sel on public.imp_lotes;
create policy lotes_sel on public.imp_lotes for select to authenticated using (public.tiene_acceso());
drop policy if exists lotes_ins on public.imp_lotes;
create policy lotes_ins on public.imp_lotes for insert to authenticated with check (public.puede_editar());
drop policy if exists lotes_upd on public.imp_lotes;
create policy lotes_upd on public.imp_lotes for update to authenticated using (public.puede_editar());

-- Promesas y pagos informados: Ventas también los carga (gestión comercial)
drop policy if exists prom_sel on public.cob_promesas;
create policy prom_sel on public.cob_promesas for select to authenticated using (public.tiene_acceso());
drop policy if exists prom_ins on public.cob_promesas;
create policy prom_ins on public.cob_promesas for insert to authenticated with check (public.tiene_acceso());
drop policy if exists prom_upd on public.cob_promesas;
create policy prom_upd on public.cob_promesas for update to authenticated using (public.tiene_acceso()) with check (public.tiene_acceso());

drop policy if exists pi_sel on public.cob_pagos_informados;
create policy pi_sel on public.cob_pagos_informados for select to authenticated using (public.tiene_acceso());
drop policy if exists pi_ins on public.cob_pagos_informados;
create policy pi_ins on public.cob_pagos_informados for insert to authenticated with check (public.tiene_acceso() and estado = 'pendiente_validacion');
drop policy if exists pi_upd on public.cob_pagos_informados;
create policy pi_upd on public.cob_pagos_informados for update to authenticated using (public.puede_editar()) with check (public.puede_editar());

drop policy if exists pag_sel on public.pag_obligaciones;
create policy pag_sel on public.pag_obligaciones for select to authenticated using (public.puede_editar());
drop policy if exists pag_ins on public.pag_obligaciones;
create policy pag_ins on public.pag_obligaciones for insert to authenticated with check (public.puede_editar());
drop policy if exists pag_upd on public.pag_obligaciones;
create policy pag_upd on public.pag_obligaciones for update to authenticated using (public.puede_editar()) with check (public.puede_editar());

drop policy if exists sim_all on public.tes_simulaciones;
create policy sim_all on public.tes_simulaciones for all to authenticated using (public.puede_editar()) with check (public.puede_editar());

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
