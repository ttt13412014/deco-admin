-- =====================================================================
--  MIGRACIÓN 07 · Tesorería (libro único: caja, bancos, cheques, flujo)
--  Correr en el SQL Editor si ya ejecutaste schema.sql antes de esta versión.
--  Las tablas viejas de Caja diaria y Flujo de fondos quedan como estaban (no se usan más).
-- =====================================================================
-- =====================================================================
--  TESORERÍA (libro único de movimientos)
--  Caja, Bancos, Cheques y Flujo de fondos leen los mismos registros:
--  cada cobro, pago o transferencia se carga una sola vez.
-- =====================================================================

-- ---------- Cuentas ----------
create table if not exists public.tes_cuentas (
  id      uuid primary key default gen_random_uuid(),
  codigo  text not null unique,                 -- efectivo, galicia, macro
  nombre  text not null,
  tipo    text not null check (tipo in ('efectivo','banco')),
  orden   int not null default 0,
  activa  boolean not null default true
);
insert into public.tes_cuentas (codigo, nombre, tipo, orden) values
  ('efectivo', 'Caja en efectivo', 'efectivo', 1),
  ('galicia',  'Banco Galicia',    'banco',    2),
  ('macro',    'Banco Macro',      'banco',    3)
on conflict (codigo) do nothing;

-- ---------- Categorías y rubros (configurables) ----------
create table if not exists public.tes_categorias (
  id                     uuid primary key default gen_random_uuid(),
  tipo                   text not null check (tipo in ('ingreso','egreso')),
  rubro                  text not null,
  nombre                 text not null,
  clave                  text unique,             -- categorías que usa el sistema (no borrar)
  requiere_autorizacion  boolean not null default true,  -- egresos: ¿necesita OK de Gerencia antes de pagar?
  orden                  int not null default 0,
  activa                 boolean not null default true,
  unique (tipo, rubro, nombre)
);

insert into public.tes_categorias (tipo, rubro, nombre, clave, requiere_autorizacion, orden) values
  ('ingreso','Ventas','Cobranza de clientes','cobranza',false,10),
  ('ingreso','Ventas','Ventas contado',null,false,11),
  ('ingreso','Ventas','Venta de máquinas',null,false,12),
  ('ingreso','Ventas','Alquiler de máquinas',null,false,13),
  ('ingreso','Ventas','Venta de repuestos',null,false,14),
  ('ingreso','Ventas','Servicio técnico / reparaciones',null,false,15),
  ('ingreso','Otros ingresos','Préstamos recibidos',null,false,20),
  ('ingreso','Otros ingresos','Aportes de socios',null,false,21),
  ('ingreso','Otros ingresos','Intereses ganados',null,false,22),
  ('ingreso','Otros ingresos','Reintegros y devoluciones',null,false,23),
  ('ingreso','Otros ingresos','Otros ingresos',null,false,29),
  ('ingreso','Ajustes','Sobrante de caja','sobrante',false,90),
  ('egreso','Proveedores','Mercadería y repuestos',null,true,10),
  ('egreso','Proveedores','Insumos',null,true,11),
  ('egreso','Proveedores','Máquinas y equipos',null,true,12),
  ('egreso','Personal','Sueldos',null,true,20),
  ('egreso','Personal','Cargas sociales',null,true,21),
  ('egreso','Personal','Adelantos de sueldo',null,true,22),
  ('egreso','Impuestos','IVA',null,true,30),
  ('egreso','Impuestos','Ingresos Brutos',null,true,31),
  ('egreso','Impuestos','Ganancias',null,true,32),
  ('egreso','Impuestos','Tasas municipales',null,true,33),
  ('egreso','Impuestos','Impuesto a los débitos y créditos','imp_debcred',false,34),
  ('egreso','Servicios','Energía',null,true,40),
  ('egreso','Servicios','Internet y telefonía',null,true,41),
  ('egreso','Servicios','Agua y gas',null,true,42),
  ('egreso','Servicios','Seguros',null,true,43),
  ('egreso','Estructura','Alquiler',null,true,50),
  ('egreso','Estructura','Mantenimiento edificio',null,true,51),
  ('egreso','Logística','Fletes y envíos',null,true,60),
  ('egreso','Logística','Combustible',null,false,61),
  ('egreso','Logística','Peajes y estacionamiento',null,false,62),
  ('egreso','Bancos y financiación','Comisiones y gastos bancarios','comisiones',false,70),
  ('egreso','Bancos y financiación','Cuotas de préstamos y leasing',null,true,71),
  ('egreso','Bancos y financiación','Intereses pagados',null,false,72),
  ('egreso','Bancos y financiación','Cheque rechazado','cheque_rechazado',false,73),
  ('egreso','Gastos generales','Librería y oficina',null,false,80),
  ('egreso','Gastos generales','Limpieza',null,false,81),
  ('egreso','Gastos generales','Viáticos',null,false,82),
  ('egreso','Gastos generales','Gastos menores',null,false,83),
  ('egreso','Socios','Retiros de socios',null,true,85),
  ('egreso','Ajustes','Faltante de caja','faltante',false,90)
on conflict do nothing;

-- ---------- Cheques (recibidos y emitidos, físicos y e-cheq) ----------
create table if not exists public.tes_cheques (
  id               uuid primary key default gen_random_uuid(),
  sentido          text not null check (sentido in ('recibido','emitido')),
  formato          text not null check (formato in ('fisico','echeq')),
  numero           text not null,
  banco            text,                         -- banco del cheque
  contraparte      text not null,                -- cliente (recibido) o proveedor (emitido)
  cuit             text,
  cliente_id       uuid references public.clientes(id),
  importe          numeric(14,2) not null check (importe > 0),
  fecha_emision    date,
  fecha_pago       date not null,                -- fecha de cobro / débito prevista (la del cheque)
  cuenta_id        uuid references public.tes_cuentas(id),  -- recibido: donde se deposita · emitido: de donde se debita
  estado           text not null check (estado in ('en_cartera','depositado','acreditado','endosado','rechazado','anulado','emitido','debitado')),
  fecha_deposito   date,
  fecha_efectiva   date,                         -- acreditación o débito real
  endosado_a       text,
  motivo           text,
  observaciones    text,
  cobro_id         uuid references public.cobros(id) on delete set null,
  created_at       timestamptz not null default now(),
  created_by       uuid default auth.uid() references public.perfiles(id),
  updated_at       timestamptz not null default now(),
  updated_by       uuid default auth.uid() references public.perfiles(id),
  check ((sentido = 'recibido' and estado in ('en_cartera','depositado','acreditado','endosado','rechazado','anulado'))
      or (sentido = 'emitido'  and estado in ('emitido','debitado','rechazado','anulado'))),
  check (sentido = 'recibido' or cuenta_id is not null)
);
create unique index if not exists tes_cheques_numero_uq on public.tes_cheques (sentido, coalesce(banco, ''), numero) where estado <> 'anulado';
create index if not exists tes_cheques_fecha_idx on public.tes_cheques (estado, fecha_pago);

-- ---------- Movimientos (el libro único) ----------
create table if not exists public.tes_movimientos (
  id                uuid primary key default gen_random_uuid(),
  fecha             date not null default public.hoy(),           -- fecha de la operación
  tipo              text not null check (tipo in ('ingreso','egreso','transferencia')),
  sentido           text not null check (sentido in ('entrada','salida')),
  categoria_id      uuid references public.tes_categorias(id),
  concepto          text not null,
  contraparte       text,
  medio             text not null check (medio in ('efectivo','transferencia','deposito','cheque','echeq','debito_automatico','tarjeta','endoso','otro')),
  cuenta_id         uuid references public.tes_cuentas(id),
  transferencia_id  uuid,                                          -- une las dos patas de una transferencia propia
  importe           numeric(14,2) not null check (importe > 0),
  fecha_prevista    date not null,                                 -- cuándo se espera cobrar / pagar
  fecha_efectiva    date,                                          -- cuándo se cobró / pagó de verdad
  estado            text not null default 'pendiente' check (estado in ('pendiente','autorizado','realizado','anulado')),
  comprobante       text,
  observaciones     text,
  cheque_id         uuid references public.tes_cheques(id),
  cobro_id          uuid references public.cobros(id) on delete set null,
  factura_id        uuid references public.facturas(id),
  serie_id          uuid,
  conciliado        boolean not null default false,
  extracto_id       uuid,
  autorizado_por    uuid references public.perfiles(id),
  autorizado_at     timestamptz,
  realizado_por     uuid references public.perfiles(id),
  realizado_at      timestamptz,
  anulado_por       uuid references public.perfiles(id),
  anulado_at        timestamptz,
  motivo_anulacion  text,
  created_at        timestamptz not null default now(),
  created_by        uuid default auth.uid() references public.perfiles(id),
  updated_at        timestamptz not null default now(),
  updated_by        uuid default auth.uid() references public.perfiles(id),
  check ((tipo = 'ingreso' and sentido = 'entrada') or (tipo = 'egreso' and sentido = 'salida') or tipo = 'transferencia'),
  check (tipo = 'transferencia' or categoria_id is not null),
  check (cuenta_id is not null or medio = 'endoso'),
  check (estado <> 'realizado' or fecha_efectiva is not null)
);
create index if not exists tes_mov_cuenta_idx on public.tes_movimientos (cuenta_id, estado, fecha_efectiva);
create index if not exists tes_mov_prev_idx on public.tes_movimientos (estado, fecha_prevista);
create index if not exists tes_mov_cheque_idx on public.tes_movimientos (cheque_id);
create index if not exists tes_mov_transf_idx on public.tes_movimientos (transferencia_id);

-- ---------- Extractos bancarios (para conciliar) ----------
create table if not exists public.tes_extractos (
  id             uuid primary key default gen_random_uuid(),
  cuenta_id      uuid not null references public.tes_cuentas(id),
  fecha          date not null,
  descripcion    text not null,
  referencia     text,
  importe        numeric(14,2) not null check (importe <> 0),   -- + crédito · − débito
  saldo          numeric(14,2),
  huella         text not null,                                 -- evita importar dos veces la misma línea
  lote           text,
  estado         text not null default 'pendiente' check (estado in ('pendiente','conciliado','ignorado')),
  movimiento_id  uuid references public.tes_movimientos(id) on delete set null,
  nota           text,
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid() references public.perfiles(id),
  unique (cuenta_id, huella)
);
do $$ begin
  alter table public.tes_movimientos add constraint tes_mov_extracto_fk foreign key (extracto_id) references public.tes_extractos(id) on delete set null;
exception when duplicate_object then null; end $$;

-- ---------- Jornadas: apertura y cierre diario ----------
create table if not exists public.tes_jornadas (
  id             uuid primary key default gen_random_uuid(),
  fecha          date not null unique,
  estado         text not null default 'abierta' check (estado in ('abierta','cerrada')),
  checklist      jsonb not null default '{}'::jsonb,
  observaciones  text,
  abierta_por    uuid default auth.uid() references public.perfiles(id),
  abierta_at     timestamptz not null default now(),
  cerrada_por    uuid references public.perfiles(id),
  cerrada_at     timestamptz
);
create table if not exists public.tes_jornada_saldos (
  id              uuid primary key default gen_random_uuid(),
  jornada_id      uuid not null references public.tes_jornadas(id) on delete cascade,
  cuenta_id       uuid not null references public.tes_cuentas(id),
  saldo_sistema   numeric(14,2),            -- lo que decía el sistema al abrir
  saldo_inicial   numeric(14,2) not null,   -- lo que se contó / verificó al abrir
  saldo_esperado  numeric(14,2),
  saldo_real      numeric(14,2),
  diferencia      numeric(14,2),
  justificacion   text,
  unique (jornada_id, cuenta_id)
);
create table if not exists public.tes_jornada_eventos (
  id          bigserial primary key,
  jornada_id  uuid not null references public.tes_jornadas(id) on delete cascade,
  accion      text not null,                -- apertura, cierre, reapertura
  motivo      text,
  datos       jsonb,
  usuario     uuid default auth.uid() references public.perfiles(id),
  fecha       timestamptz not null default now()
);

-- =====================================================================
--  Reglas
-- =====================================================================

-- ¿Ese día está cerrado?
create or replace function public.tes_dia_cerrado(p_fecha date) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.tes_jornadas where fecha = p_fecha and estado = 'cerrada')
$$;

create or replace function public.tg_tes_mov_reglas() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cat public.tes_categorias;
  bypass boolean := coalesce(current_setting('tes.bypass_aut', true), '') = '1';
begin
  if tg_op = 'UPDATE' and not public.puede_editar() then
    raise exception 'No tenés permiso para modificar movimientos.';
  end if;

  -- Fechas por defecto
  new.fecha_prevista := coalesce(new.fecha_prevista, new.fecha);
  if new.estado = 'realizado' then new.fecha_efectiva := coalesce(new.fecha_efectiva, new.fecha_prevista); end if;
  if new.tipo = 'ingreso' then new.sentido := 'entrada'; elsif new.tipo = 'egreso' then new.sentido := 'salida'; end if;

  if new.categoria_id is not null then
    select * into cat from public.tes_categorias where id = new.categoria_id;
    if new.tipo <> 'transferencia' and cat.tipo <> new.tipo then
      raise exception 'La categoría "%" es de %, no de %.', cat.nombre, cat.tipo, new.tipo;
    end if;
  end if;

  if tg_op = 'UPDATE' then
    -- Días cerrados: no se tocan (Gerencia tiene que reabrir la jornada)
    if old.estado = 'realizado' and old.fecha_efectiva is not null and public.tes_dia_cerrado(old.fecha_efectiva)
       and (new.estado, new.importe, new.cuenta_id, new.fecha_efectiva, new.medio)
           is distinct from (old.estado, old.importe, old.cuenta_id, old.fecha_efectiva, old.medio) then
      raise exception 'La jornada del % está cerrada. Para corregir, Gerencia tiene que reabrirla.', to_char(old.fecha_efectiva, 'DD/MM/YYYY');
    end if;
    -- Conciliados con el extracto
    if old.conciliado and new.conciliado
       and (new.importe, new.cuenta_id, new.estado) is distinct from (old.importe, old.cuenta_id, old.estado) then
      raise exception 'Este movimiento está conciliado con el extracto del banco. Desconcilialo primero.';
    end if;
    -- Anulados no vuelven (salvo Gerencia)
    if old.estado = 'anulado' and new.estado <> 'anulado' and not public.es_gerencia() then
      raise exception 'Un movimiento anulado no se puede reactivar. Cargalo de nuevo.';
    end if;
    -- Transferencias: solo se anulan (las dos patas juntas)
    if old.tipo = 'transferencia' and pg_trigger_depth() = 1
       and (new.importe, new.cuenta_id, new.fecha_efectiva, new.fecha_prevista) is distinct from (old.importe, old.cuenta_id, old.fecha_efectiva, old.fecha_prevista)
       and not bypass then
      raise exception 'Para cambiar una transferencia, anulala y cargala de nuevo.';
    end if;
    -- Pago ya autorizado: si cambia monto, fecha, cuenta o medio vuelve a pedir autorización (A08)
    if old.tipo = 'egreso' and old.estado = 'autorizado' and new.estado = 'autorizado' and not public.es_gerencia() and not bypass
       and (new.importe, new.fecha_prevista, new.medio, new.cuenta_id) is distinct from (old.importe, old.fecha_prevista, old.medio, old.cuenta_id)
       and new.cheque_id is not distinct from old.cheque_id then
      new.estado := 'pendiente'; new.autorizado_por := null; new.autorizado_at := null;
    end if;
  end if;

  -- Cambios de estado
  if tg_op = 'INSERT' or new.estado is distinct from old.estado then
    if new.estado = 'autorizado' then
      if new.tipo <> 'egreso' then raise exception 'Solo los pagos se autorizan.'; end if;
      if not public.es_gerencia() and not bypass then raise exception 'Solo Gerencia/Finanzas puede autorizar pagos (A08).'; end if;
      new.autorizado_por := auth.uid(); new.autorizado_at := now();
    end if;
    if new.estado = 'realizado' then
      if new.tipo = 'egreso' and not bypass and not public.es_gerencia()
         and coalesce(cat.requiere_autorizacion, true)
         and (tg_op = 'INSERT' or old.estado <> 'autorizado') then
        raise exception 'Sin autorización explícita no se paga (A08). Pedí la autorización a Gerencia o usá una categoría de gasto menor.';
      end if;
      new.realizado_por := auth.uid(); new.realizado_at := now();
    end if;
    if new.estado = 'anulado' then
      if coalesce(trim(new.motivo_anulacion), '') = '' then raise exception 'Indicá el motivo de la anulación.'; end if;
      if new.conciliado then raise exception 'Está conciliado con el banco: desconcilialo antes de anular.'; end if;
      new.anulado_por := auth.uid(); new.anulado_at := now();
    end if;
    if new.estado = 'pendiente' and tg_op = 'UPDATE' then
      new.autorizado_por := null; new.autorizado_at := null;
    end if;
  end if;

  -- No se puede cargar un movimiento realizado en un día cerrado
  if new.estado = 'realizado' and public.tes_dia_cerrado(new.fecha_efectiva)
     and (tg_op = 'INSERT' or old.estado <> 'realizado' or old.fecha_efectiva is distinct from new.fecha_efectiva
          or old.importe is distinct from new.importe or old.cuenta_id is distinct from new.cuenta_id) then
    raise exception 'La jornada del % está cerrada. Cargalo con otra fecha o pedí a Gerencia que la reabra.', to_char(new.fecha_efectiva, 'DD/MM/YYYY');
  end if;
  return new;
end $$;

drop trigger if exists tes_mov_reglas on public.tes_movimientos;
create trigger tes_mov_reglas before insert or update on public.tes_movimientos
  for each row execute function public.tg_tes_mov_reglas();
drop trigger if exists tes_mov_updated on public.tes_movimientos;
create trigger tes_mov_updated before update on public.tes_movimientos
  for each row execute function public.tg_updated();
drop trigger if exists tes_mov_audit on public.tes_movimientos;
create trigger tes_mov_audit after insert or update or delete on public.tes_movimientos
  for each row execute function public.tg_auditoria();

-- Solo Gerencia decide qué egresos se pagan sin autorización (A08)
create or replace function public.tg_tes_cat_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;   -- SQL Editor / carga inicial
  if not public.es_gerencia() and new.tipo = 'egreso' then
    if tg_op = 'INSERT' and not new.requiere_autorizacion then
      raise exception 'Solo Gerencia puede crear categorías de pago directo (sin autorización).';
    end if;
    if tg_op = 'UPDATE' and new.requiere_autorizacion is distinct from old.requiere_autorizacion then
      raise exception 'Solo Gerencia puede cambiar qué categorías piden autorización.';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.clave is not null and (new.clave is distinct from old.clave or new.tipo <> old.tipo or not new.activa) then
    raise exception 'Esta categoría la usa el sistema: se puede renombrar pero no desactivar.';
  end if;
  return new;
end $$;
drop trigger if exists tes_cat_guard on public.tes_categorias;
create trigger tes_cat_guard before insert or update on public.tes_categorias
  for each row execute function public.tg_tes_cat_guard();

-- Anular una pata de transferencia anula la otra
create or replace function public.tg_tes_transf_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.transferencia_id is not null and new.estado = 'anulado' and old.estado <> 'anulado' then
    update public.tes_movimientos
       set estado = 'anulado', motivo_anulacion = new.motivo_anulacion
     where transferencia_id = new.transferencia_id and id <> new.id and estado <> 'anulado';
  end if;
  return null;
end $$;
drop trigger if exists tes_transf_sync on public.tes_movimientos;
create trigger tes_transf_sync after update of estado on public.tes_movimientos
  for each row execute function public.tg_tes_transf_sync();

drop trigger if exists tes_cheques_updated on public.tes_cheques;
create trigger tes_cheques_updated before update on public.tes_cheques
  for each row execute function public.tg_updated();
drop trigger if exists tes_cheques_audit on public.tes_cheques;
create trigger tes_cheques_audit after insert or update or delete on public.tes_cheques
  for each row execute function public.tg_auditoria();
drop trigger if exists tes_jornadas_audit on public.tes_jornadas;
create trigger tes_jornadas_audit after insert or update or delete on public.tes_jornadas
  for each row execute function public.tg_auditoria();
drop trigger if exists tes_categorias_audit on public.tes_categorias;
create trigger tes_categorias_audit after insert or update or delete on public.tes_categorias
  for each row execute function public.tg_auditoria();

-- Jornadas: lo cerrado no se toca sin reabrir
create or replace function public.tg_tes_jornada_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'Las jornadas no se eliminan.'; end if;
  if old.estado = 'cerrada' and coalesce(current_setting('tes.reabriendo', true), '') <> '1' then
    raise exception 'La jornada del % está cerrada. Solo Gerencia puede reabrirla.', to_char(old.fecha, 'DD/MM/YYYY');
  end if;
  return new;
end $$;
drop trigger if exists tes_jornada_guard on public.tes_jornadas;
create trigger tes_jornada_guard before update or delete on public.tes_jornadas
  for each row execute function public.tg_tes_jornada_guard();

create or replace function public.tg_tes_jsaldos_guard() returns trigger
language plpgsql as $$
declare est text;
begin
  select estado into est from public.tes_jornadas where id = coalesce(new.jornada_id, old.jornada_id);
  if est = 'cerrada' and coalesce(current_setting('tes.reabriendo', true), '') <> '1' then
    raise exception 'La jornada está cerrada.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists tes_jsaldos_guard on public.tes_jornada_saldos;
create trigger tes_jsaldos_guard before update or delete on public.tes_jornada_saldos
  for each row execute function public.tg_tes_jsaldos_guard();

-- =====================================================================
--  Saldos
-- =====================================================================

-- Saldo de una cuenta al final del día p_al.
-- Parte del último cierre (saldo real verificado) o de la apertura del día, y suma lo realizado después.
create or replace function public.tes_saldo_cuenta(p_cuenta uuid, p_al date) returns numeric
language plpgsql stable as $$
declare
  j record;
  base numeric := 0;
  desde date := '-infinity';
begin
  select jo.fecha, jo.estado, s.saldo_inicial, s.saldo_real, s.saldo_esperado into j
    from public.tes_jornadas jo join public.tes_jornada_saldos s on s.jornada_id = jo.id and s.cuenta_id = p_cuenta
   where jo.fecha <= p_al
   order by jo.fecha desc limit 1;
  if found then
    if j.estado = 'cerrada' then
      base := coalesce(j.saldo_real, j.saldo_esperado, j.saldo_inicial);
      desde := j.fecha + 1;
    else
      base := j.saldo_inicial;
      desde := j.fecha;
    end if;
  end if;
  return base + coalesce((
    select sum(case when sentido = 'entrada' then importe else -importe end)
      from public.tes_movimientos
     where cuenta_id = p_cuenta and estado = 'realizado' and fecha_efectiva between desde and p_al
  ), 0);
end $$;

-- Disponibilidad por cuenta a una fecha
create or replace function public.tes_disponibilidad(p_al date default public.hoy())
returns table (cuenta_id uuid, codigo text, nombre text, tipo text, saldo numeric)
language sql stable as $$
  select c.id, c.codigo, c.nombre, c.tipo, public.tes_saldo_cuenta(c.id, p_al)
    from public.tes_cuentas c where c.activa order by c.orden
$$;

-- =====================================================================
--  Operaciones (todo lo que toca más de una tabla, en un solo paso)
-- =====================================================================

-- Transferencia entre cuentas propias: dos movimientos vinculados, no es ingreso ni gasto
create or replace function public.tes_transferir(p jsonb) returns uuid
language plpgsql as $$
declare
  tid uuid := gen_random_uuid();
  o uuid := (p->>'origen')::uuid;
  d uuid := (p->>'destino')::uuid;
  imp numeric := (p->>'importe')::numeric;
  f date := coalesce((p->>'fecha')::date, public.hoy());
  fe date := coalesce((p->>'fecha_efectiva')::date, f);
  est text := coalesce(p->>'estado', 'realizado');
  concepto text := coalesce(nullif(trim(p->>'concepto'), ''), 'Transferencia entre cuentas');
  medio text := coalesce(p->>'medio', 'transferencia');
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  if o is null or d is null or o = d then raise exception 'Elegí cuenta de origen y de destino distintas.'; end if;
  if imp is null or imp <= 0 then raise exception 'Importe inválido.'; end if;
  insert into public.tes_movimientos (fecha, tipo, sentido, concepto, medio, cuenta_id, transferencia_id, importe, fecha_prevista, fecha_efectiva, estado, comprobante, observaciones)
  values (f, 'transferencia', 'salida', concepto, medio, o, tid, imp, fe, case when est = 'realizado' then fe end, est, p->>'comprobante', p->>'observaciones'),
         (f, 'transferencia', 'entrada', concepto, medio, d, tid, imp, fe, case when est = 'realizado' then fe end, est, p->>'comprobante', p->>'observaciones');
  return tid;
end $$;

-- Cobro de una factura (desde Cobranzas): cobro + cheque (si corresponde) + movimiento de tesorería
create or replace function public.tes_registrar_cobro(p jsonb) returns jsonb
language plpgsql as $$
declare
  fac public.facturas;
  cli public.clientes;
  cat uuid;
  medio text := p->>'medio';
  cuenta uuid := nullif(p->>'cuenta_id', '')::uuid;
  f date := coalesce((p->>'fecha')::date, public.hoy());
  imp numeric := (p->>'monto')::numeric;
  cob uuid; chq uuid; mov uuid;
  ch jsonb := p->'cheque';
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  select * into fac from public.facturas where id = (p->>'factura_id')::uuid;
  if fac.id is null then raise exception 'Factura inexistente.'; end if;
  select * into cli from public.clientes where id = fac.cliente_id;
  select id into cat from public.tes_categorias where clave = 'cobranza';
  if cuenta is null and medio <> 'endoso' then raise exception 'Elegí la cuenta donde entra el cobro.'; end if;

  insert into public.cobros (factura_id, fecha, monto, medio_pago, referencia, observaciones)
  values (fac.id, f, imp, case medio when 'efectivo' then 'Efectivo' when 'cheque' then 'Cheque' when 'echeq' then 'E-cheq' when 'tarjeta' then 'Tarjeta' else 'Transferencia' end,
          nullif(p->>'referencia', ''), nullif(p->>'observaciones', ''))
  returning id into cob;

  if medio in ('cheque','echeq') then
    if ch is null or coalesce(ch->>'numero', '') = '' or coalesce(ch->>'fecha_pago', '') = '' then
      raise exception 'Cargá número y fecha de pago del cheque.';
    end if;
    insert into public.tes_cheques (sentido, formato, numero, banco, contraparte, cuit, cliente_id, importe, fecha_emision, fecha_pago, cuenta_id, estado, cobro_id)
    values ('recibido', case when medio = 'echeq' then 'echeq' else 'fisico' end, ch->>'numero', nullif(ch->>'banco', ''), cli.razon_social,
            coalesce(nullif(ch->>'cuit', ''), cli.cuit_dni), cli.id, imp, nullif(ch->>'fecha_emision', '')::date, (ch->>'fecha_pago')::date, cuenta, 'en_cartera', cob)
    returning id into chq;
    -- Queda pendiente: no es plata disponible hasta que se acredita
    insert into public.tes_movimientos (fecha, tipo, sentido, categoria_id, concepto, contraparte, medio, cuenta_id, importe, fecha_prevista, estado, comprobante, cheque_id, cobro_id, factura_id)
    values (f, 'ingreso', 'entrada', cat, format('Cobro %s %s', fac.tipo_comprobante, fac.numero), cli.razon_social, medio, cuenta, imp,
            greatest((ch->>'fecha_pago')::date, f), 'pendiente', format('%s N° %s', case when medio = 'echeq' then 'E-cheq' else 'Cheque' end, ch->>'numero'), chq, cob, fac.id)
    returning id into mov;
  else
    insert into public.tes_movimientos (fecha, tipo, sentido, categoria_id, concepto, contraparte, medio, cuenta_id, importe, fecha_prevista, fecha_efectiva, estado, comprobante, cobro_id, factura_id)
    values (f, 'ingreso', 'entrada', cat, format('Cobro %s %s', fac.tipo_comprobante, fac.numero), cli.razon_social, medio, cuenta, imp,
            f, f, 'realizado', nullif(p->>'referencia', ''), cob, fac.id)
    returning id into mov;
  end if;
  return jsonb_build_object('cobro_id', cob, 'cheque_id', chq, 'movimiento_id', mov);
end $$;

-- Ejecutar un movimiento pendiente: pagar / cobrar (con transferencia, efectivo o cheque)
create or replace function public.tes_ejecutar(p_mov uuid, p jsonb) returns uuid
language plpgsql as $$
declare
  m public.tes_movimientos;
  v_medio text := coalesce(p->>'medio', 'transferencia');
  v_cuenta uuid := nullif(p->>'cuenta_id', '')::uuid;
  f date := coalesce((p->>'fecha')::date, public.hoy());
  ch jsonb := p->'cheque';
  chq uuid;
  cat public.tes_categorias;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  select * into m from public.tes_movimientos where id = p_mov for update;
  if m.id is null then raise exception 'Movimiento inexistente.'; end if;
  if m.estado not in ('pendiente','autorizado') then raise exception 'Este movimiento ya está %.', m.estado; end if;
  if m.tipo = 'transferencia' then raise exception 'Las transferencias se cargan ya realizadas.'; end if;
  if v_cuenta is null then raise exception 'Elegí la cuenta.'; end if;
  select * into cat from public.tes_categorias where id = m.categoria_id;

  if v_medio in ('cheque','echeq') then
    if coalesce(ch->>'numero', '') = '' or coalesce(ch->>'fecha_pago', '') = '' then raise exception 'Cargá número y fecha de pago del cheque.'; end if;
    if m.tipo = 'egreso' and m.estado <> 'autorizado' and coalesce(cat.requiere_autorizacion, true) and not public.es_gerencia() then
      raise exception 'Sin autorización explícita no se paga (A08). Pedí la autorización a Gerencia.';
    end if;
    insert into public.tes_cheques (sentido, formato, numero, banco, contraparte, cuit, importe, fecha_emision, fecha_pago, cuenta_id, estado)
    values (case when m.tipo = 'egreso' then 'emitido' else 'recibido' end, case when v_medio = 'echeq' then 'echeq' else 'fisico' end,
            ch->>'numero', nullif(ch->>'banco', ''), coalesce(m.contraparte, m.concepto), nullif(ch->>'cuit', ''), m.importe,
            coalesce(nullif(ch->>'fecha_emision', '')::date, f), (ch->>'fecha_pago')::date, v_cuenta,
            case when m.tipo = 'egreso' then 'emitido' else 'en_cartera' end)
    returning id into chq;
    perform set_config('tes.bypass_aut', '1', true);
    update public.tes_movimientos
       set cheque_id = chq, medio = v_medio, cuenta_id = v_cuenta, fecha_prevista = greatest((ch->>'fecha_pago')::date, f),
           comprobante = coalesce(nullif(p->>'comprobante', ''), format('%s N° %s', case when v_medio = 'echeq' then 'E-cheq' else 'Cheque' end, ch->>'numero')),
           estado = case when m.tipo = 'egreso' then 'autorizado' else 'pendiente' end
     where id = p_mov;
    perform set_config('tes.bypass_aut', '', true);
  else
    if m.tipo = 'egreso' and coalesce(trim(p->>'comprobante'), '') = '' then
      raise exception 'Cargá el comprobante u orden de pago (A08: registrar con su respaldo).';
    end if;
    update public.tes_movimientos
       set estado = 'realizado', medio = v_medio, cuenta_id = v_cuenta, fecha_efectiva = f,
           comprobante = coalesce(nullif(p->>'comprobante', ''), comprobante)
     where id = p_mov;
  end if;
  return p_mov;
end $$;

-- Acciones sobre cheques: depositar, acreditar, debitar, endosar, rechazar, anular
create or replace function public.tes_cheque_accion(p_cheque uuid, p_accion text, p jsonb default '{}'::jsonb) returns void
language plpgsql as $$
declare
  c public.tes_cheques;
  m public.tes_movimientos;
  f date := coalesce((p->>'fecha')::date, public.hoy());
  v_cuenta uuid := nullif(p->>'cuenta_id', '')::uuid;
  v_motivo text := nullif(trim(p->>'motivo'), '');
  cat_rech uuid;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  select * into c from public.tes_cheques where id = p_cheque for update;
  if c.id is null then raise exception 'Cheque inexistente.'; end if;
  select * into m from public.tes_movimientos where cheque_id = c.id and estado <> 'anulado' and sentido = case when c.sentido = 'recibido' then 'entrada' else 'salida' end
   order by created_at limit 1;

  if p_accion = 'depositar' then
    if c.sentido <> 'recibido' or c.estado <> 'en_cartera' then raise exception 'Solo se depositan cheques en cartera.'; end if;
    if v_cuenta is null then v_cuenta := c.cuenta_id; end if;
    if v_cuenta is null then raise exception 'Elegí la cuenta donde se deposita.'; end if;
    update public.tes_cheques set estado = 'depositado', fecha_deposito = f, cuenta_id = v_cuenta where id = c.id;
    if m.id is not null then
      update public.tes_movimientos set cuenta_id = v_cuenta, fecha_prevista = greatest(c.fecha_pago, f) where id = m.id;
    end if;

  elsif p_accion in ('acreditar','debitar') then
    if p_accion = 'acreditar' and (c.sentido <> 'recibido' or c.estado not in ('en_cartera','depositado')) then raise exception 'Solo se acreditan cheques recibidos en cartera o depositados.'; end if;
    if p_accion = 'debitar' and (c.sentido <> 'emitido' or c.estado <> 'emitido') then raise exception 'Solo se debitan cheques emitidos pendientes.'; end if;
    update public.tes_cheques set estado = case when p_accion = 'acreditar' then 'acreditado' else 'debitado' end, fecha_efectiva = f,
           cuenta_id = coalesce(v_cuenta, cuenta_id) where id = c.id;
    if m.id is not null then
      perform set_config('tes.bypass_aut', '1', true);
      update public.tes_movimientos set estado = 'realizado', fecha_efectiva = f, cuenta_id = coalesce(v_cuenta, c.cuenta_id, m.cuenta_id) where id = m.id;
      perform set_config('tes.bypass_aut', '', true);
    end if;

  elsif p_accion = 'endosar' then
    if c.sentido <> 'recibido' or c.estado <> 'en_cartera' then raise exception 'Solo se endosan cheques en cartera.'; end if;
    if coalesce(trim(p->>'destinatario'), '') = '' then raise exception 'Indicá a quién se endosa.'; end if;
    update public.tes_cheques set estado = 'endosado', endosado_a = p->>'destinatario', fecha_efectiva = f where id = c.id;
    perform set_config('tes.bypass_aut', '1', true);
    -- El cobro queda hecho, pero no pasa por ninguna cuenta
    if m.id is not null then
      update public.tes_movimientos set estado = 'realizado', medio = 'endoso', cuenta_id = null, fecha_efectiva = f where id = m.id;
    end if;
    -- El pago al proveedor: uno ya cargado y autorizado, o uno nuevo
    if nullif(p->>'mov_pago', '') is not null then
      update public.tes_movimientos set estado = 'realizado', medio = 'endoso', cuenta_id = null, fecha_efectiva = f, cheque_id = c.id,
             comprobante = coalesce(comprobante, format('Endoso cheque N° %s', c.numero))
       where id = (p->>'mov_pago')::uuid and tipo = 'egreso' and estado = 'autorizado';
      if not found then raise exception 'El pago elegido tiene que estar autorizado.'; end if;
    else
      if nullif(p->>'categoria_id', '') is null then raise exception 'Elegí la categoría del pago.'; end if;
      perform set_config('tes.bypass_aut', '', true);
      insert into public.tes_movimientos (fecha, tipo, sentido, categoria_id, concepto, contraparte, medio, cuenta_id, importe, fecha_prevista, fecha_efectiva, estado, comprobante, cheque_id)
      values (f, 'egreso', 'salida', (p->>'categoria_id')::uuid, coalesce(nullif(p->>'concepto', ''), format('Pago con cheque endosado N° %s', c.numero)),
              p->>'destinatario', 'endoso', null, c.importe, f, f, 'realizado', format('Endoso cheque N° %s', c.numero), c.id);
    end if;
    perform set_config('tes.bypass_aut', '', true);

  elsif p_accion = 'rechazar' then
    if c.estado in ('rechazado','anulado','debitado','endosado') then raise exception 'Ese cheque no se puede rechazar (estado: %).', c.estado; end if;
    if v_motivo is null then raise exception 'Indicá el motivo del rechazo.'; end if;
    update public.tes_cheques set estado = 'rechazado', motivo = v_motivo, fecha_efectiva = f where id = c.id;
    if c.sentido = 'recibido' then
      if m.id is not null and m.estado <> 'realizado' then
        update public.tes_movimientos set estado = 'anulado', motivo_anulacion = 'Cheque rechazado: ' || v_motivo where id = m.id;
      elsif m.id is not null then
        -- Ya se había acreditado: el banco lo debita de vuelta
        select id into cat_rech from public.tes_categorias where clave = 'cheque_rechazado';
        perform set_config('tes.bypass_aut', '1', true);
        insert into public.tes_movimientos (fecha, tipo, sentido, categoria_id, concepto, contraparte, medio, cuenta_id, importe, fecha_prevista, fecha_efectiva, estado, comprobante, cheque_id)
        values (f, 'egreso', 'salida', cat_rech, format('Cheque N° %s rechazado: %s', c.numero, v_motivo), c.contraparte, 'debito_automatico',
                coalesce(c.cuenta_id, m.cuenta_id), c.importe, f, f, 'realizado', format('Rechazo cheque N° %s', c.numero), c.id);
        perform set_config('tes.bypass_aut', '', true);
      end if;
      -- La factura del cliente vuelve a quedar con deuda
      if c.cobro_id is not null then perform public.tes_revertir_cobro(c.cobro_id); end if;
    else
      -- Cheque propio rechazado: la deuda con el proveedor sigue pendiente
      if m.id is not null then
        perform set_config('tes.bypass_aut', '1', true);
        update public.tes_movimientos set cheque_id = null, estado = 'autorizado',
               observaciones = concat_ws(' · ', observaciones, format('Cheque N° %s rechazado (%s)', c.numero, v_motivo))
         where id = m.id;
        perform set_config('tes.bypass_aut', '', true);
      end if;
    end if;

  elsif p_accion = 'anular' then
    if c.estado not in ('en_cartera','emitido') then raise exception 'Solo se anulan cheques en cartera o emitidos sin debitar.'; end if;
    if v_motivo is null then raise exception 'Indicá el motivo.'; end if;
    update public.tes_cheques set estado = 'anulado', motivo = v_motivo where id = c.id;
    if m.id is not null then
      if c.sentido = 'emitido' then
        perform set_config('tes.bypass_aut', '1', true);
        update public.tes_movimientos set cheque_id = null, observaciones = concat_ws(' · ', observaciones, format('Cheque N° %s anulado (%s)', c.numero, v_motivo)) where id = m.id;
        perform set_config('tes.bypass_aut', '', true);
      else
        update public.tes_movimientos set estado = 'anulado', motivo_anulacion = 'Cheque anulado: ' || v_motivo where id = m.id;
        if c.cobro_id is not null then perform public.tes_revertir_cobro(c.cobro_id); end if;
      end if;
    end if;
  else
    raise exception 'Acción desconocida: %', p_accion;
  end if;
end $$;

-- Borra el cobro de una factura (cheque rechazado o anulado): la deuda vuelve
create or replace function public.tes_revertir_cobro(p_cobro uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  update public.tes_movimientos set cobro_id = null where cobro_id = p_cobro;
  update public.tes_cheques set cobro_id = null where cobro_id = p_cobro;
  delete from public.cobros where id = p_cobro;
end $$;

-- ---------- Conciliación bancaria ----------
create or replace function public.tes_conciliar(p_extracto uuid, p_mov uuid) returns void
language plpgsql as $$
declare
  e public.tes_extractos;
  m public.tes_movimientos;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  select * into e from public.tes_extractos where id = p_extracto for update;
  select * into m from public.tes_movimientos where id = p_mov for update;
  if e.id is null or m.id is null then raise exception 'No encontré el movimiento o la línea del extracto.'; end if;
  if e.estado <> 'pendiente' then raise exception 'Esa línea del extracto ya está %.', e.estado; end if;
  if m.conciliado then raise exception 'Ese movimiento ya está conciliado.'; end if;
  if m.estado = 'anulado' then raise exception 'Ese movimiento está anulado.'; end if;
  if m.cuenta_id is distinct from e.cuenta_id then raise exception 'El movimiento es de otra cuenta.'; end if;
  if (e.importe > 0) <> (m.sentido = 'entrada') then raise exception 'Uno es crédito y el otro débito.'; end if;
  if abs(e.importe) <> m.importe then raise exception 'Los importes no coinciden (% contra %).', abs(e.importe), m.importe; end if;

  perform set_config('tes.bypass_aut', '1', true);
  -- Si estaba pendiente, el banco confirma que se hizo
  if m.estado <> 'realizado' then
    update public.tes_movimientos set estado = 'realizado', fecha_efectiva = e.fecha where id = m.id;
    if m.cheque_id is not null then
      update public.tes_cheques set estado = case when sentido = 'recibido' then 'acreditado' else 'debitado' end, fecha_efectiva = e.fecha
       where id = m.cheque_id and estado in ('en_cartera','depositado','emitido');
    end if;
  end if;
  update public.tes_movimientos set conciliado = true, extracto_id = e.id where id = m.id;
  perform set_config('tes.bypass_aut', '', true);
  update public.tes_extractos set estado = 'conciliado', movimiento_id = m.id where id = e.id;
end $$;

create or replace function public.tes_desconciliar(p_extracto uuid) returns void
language plpgsql as $$
declare e public.tes_extractos;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  select * into e from public.tes_extractos where id = p_extracto for update;
  if e.movimiento_id is not null then
    update public.tes_movimientos set conciliado = false, extracto_id = null where id = e.movimiento_id;
  end if;
  update public.tes_extractos set estado = 'pendiente', movimiento_id = null, nota = null where id = e.id;
end $$;

-- Línea del extracto que no estaba cargada (débito automático, comisión, transferencia recibida…)
create or replace function public.tes_crear_desde_extracto(p_extracto uuid, p jsonb) returns uuid
language plpgsql as $$
declare
  e public.tes_extractos;
  mid uuid;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  select * into e from public.tes_extractos where id = p_extracto for update;
  if e.estado <> 'pendiente' then raise exception 'Esa línea ya está %.', e.estado; end if;
  if nullif(p->>'categoria_id', '') is null then raise exception 'Elegí la categoría.'; end if;
  if public.tes_dia_cerrado(e.fecha) then
    raise exception 'Esa línea es del % y la jornada ya está cerrada. Si la diferencia ya se justificó en el cierre, usá "Ignorar" con esa nota; si no, Gerencia tiene que reabrir la jornada para cargarla.', to_char(e.fecha, 'DD/MM/YYYY');
  end if;
  perform set_config('tes.bypass_aut', '1', true);
  insert into public.tes_movimientos (fecha, tipo, sentido, categoria_id, concepto, contraparte, medio, cuenta_id, importe, fecha_prevista, fecha_efectiva, estado, comprobante, observaciones)
  values (e.fecha, case when e.importe > 0 then 'ingreso' else 'egreso' end, case when e.importe > 0 then 'entrada' else 'salida' end,
          (p->>'categoria_id')::uuid, coalesce(nullif(trim(p->>'concepto'), ''), e.descripcion), nullif(p->>'contraparte', ''),
          coalesce(nullif(p->>'medio', ''), case when e.importe > 0 then 'transferencia' else 'debito_automatico' end),
          e.cuenta_id, abs(e.importe), e.fecha, e.fecha, 'realizado', coalesce(e.referencia, 'Extracto bancario'), 'Cargado desde el extracto: ' || e.descripcion)
  returning id into mid;
  perform set_config('tes.bypass_aut', '', true);
  perform public.tes_conciliar(e.id, mid);
  return mid;
end $$;

-- ---------- Apertura y cierre ----------
create or replace function public.tes_abrir_jornada(p_fecha date, p_saldos jsonb, p_obs text default null) returns uuid
language plpgsql as $$
declare
  jid uuid;
  c record;
  previa record;
  ingresado numeric;
  datos jsonb := '[]'::jsonb;
  sist numeric;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso para abrir la jornada.'; end if;
  if exists (select 1 from public.tes_jornadas where fecha = p_fecha) then raise exception 'Ya existe la jornada del %.', to_char(p_fecha, 'DD/MM/YYYY'); end if;
  select fecha into previa from public.tes_jornadas where fecha < p_fecha and estado = 'abierta' order by fecha limit 1;
  if found then raise exception 'La jornada del % sigue abierta. Cerrala antes de abrir otra (A06: no se postergan cierres).', to_char(previa.fecha, 'DD/MM/YYYY'); end if;

  insert into public.tes_jornadas (fecha, observaciones) values (p_fecha, nullif(trim(coalesce(p_obs, '')), '')) returning id into jid;
  for c in select * from public.tes_cuentas where activa order by orden loop
    sist := public.tes_saldo_cuenta(c.id, p_fecha - 1);
    select (x->>'saldo_inicial')::numeric into ingresado from jsonb_array_elements(coalesce(p_saldos, '[]'::jsonb)) x where (x->>'cuenta_id')::uuid = c.id;
    insert into public.tes_jornada_saldos (jornada_id, cuenta_id, saldo_sistema, saldo_inicial)
    values (jid, c.id, sist, coalesce(ingresado, sist));
    datos := datos || jsonb_build_object('cuenta', c.nombre, 'sistema', sist, 'inicial', coalesce(ingresado, sist));
  end loop;
  insert into public.tes_jornada_eventos (jornada_id, accion, datos) values (jid, 'apertura', datos);
  return jid;
end $$;

create or replace function public.tes_cerrar_jornada(p_jornada uuid, p_reales jsonb, p_checklist jsonb, p_obs text default null) returns void
language plpgsql as $$
declare
  j public.tes_jornadas;
  s record;
  v_esp numeric;
  v_real numeric;
  v_just text;
  item text;
  requeridos text[] := array['ingresos','egresos','comprobantes','bancos','cheques','cobros','pagos'];
  datos jsonb := '[]'::jsonb;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso para cerrar la jornada.'; end if;
  select * into j from public.tes_jornadas where id = p_jornada for update;
  if j.id is null then raise exception 'Jornada inexistente.'; end if;
  if j.estado = 'cerrada' then raise exception 'La jornada ya está cerrada.'; end if;
  foreach item in array requeridos loop
    if coalesce((p_checklist->>item)::boolean, false) = false then
      raise exception 'Checklist de cierre incompleto: falta "%".', item;
    end if;
  end loop;

  for s in select js.*, c.nombre from public.tes_jornada_saldos js join public.tes_cuentas c on c.id = js.cuenta_id where js.jornada_id = j.id loop
    v_esp := s.saldo_inicial + coalesce((
      select sum(case when sentido = 'entrada' then importe else -importe end)
        from public.tes_movimientos where cuenta_id = s.cuenta_id and estado = 'realizado' and fecha_efectiva = j.fecha), 0);
    select (x->>'saldo_real')::numeric, nullif(trim(x->>'justificacion'), '') into v_real, v_just
      from jsonb_array_elements(coalesce(p_reales, '[]'::jsonb)) x where (x->>'cuenta_id')::uuid = s.cuenta_id;
    if v_real is null then raise exception 'Falta el saldo real de %.', s.nombre; end if;
    if v_real <> v_esp and v_just is null then
      raise exception 'En % hay una diferencia de $ % (esperado %, real %). Tenés que justificarla.', s.nombre, v_real - v_esp, v_esp, v_real;
    end if;
    update public.tes_jornada_saldos set saldo_esperado = v_esp, saldo_real = v_real, diferencia = v_real - v_esp, justificacion = v_just where id = s.id;
    datos := datos || jsonb_build_object('cuenta', s.nombre, 'inicial', s.saldo_inicial, 'esperado', v_esp, 'real', v_real, 'diferencia', v_real - v_esp, 'justificacion', v_just);
    v_real := null; v_just := null;
  end loop;

  update public.tes_jornadas
     set estado = 'cerrada', checklist = checklist || p_checklist, cerrada_por = auth.uid(), cerrada_at = now(),
         observaciones = coalesce(nullif(trim(coalesce(p_obs, '')), ''), observaciones)
   where id = j.id;
  insert into public.tes_jornada_eventos (jornada_id, accion, datos, motivo) values (j.id, 'cierre', datos, nullif(trim(coalesce(p_obs, '')), ''));
end $$;

create or replace function public.tes_reabrir_jornada(p_jornada uuid, p_motivo text) returns void
language plpgsql as $$
declare
  j public.tes_jornadas;
  previo jsonb;
begin
  if not public.es_gerencia() then raise exception 'Solo Gerencia puede reabrir una jornada.'; end if;
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Indicá el motivo de la reapertura.'; end if;
  select * into j from public.tes_jornadas where id = p_jornada for update;
  if j.estado <> 'cerrada' then raise exception 'La jornada no está cerrada.'; end if;
  select jsonb_agg(jsonb_build_object('cuenta_id', cuenta_id, 'inicial', saldo_inicial, 'esperado', saldo_esperado, 'real', saldo_real, 'diferencia', diferencia, 'justificacion', justificacion))
    into previo from public.tes_jornada_saldos where jornada_id = j.id;
  perform set_config('tes.reabriendo', '1', true);
  update public.tes_jornadas set estado = 'abierta', cerrada_por = null, cerrada_at = null where id = j.id;
  perform set_config('tes.reabriendo', '', true);
  insert into public.tes_jornada_eventos (jornada_id, accion, motivo, datos) values (j.id, 'reapertura', p_motivo, previo);
end $$;

-- Cambiar el saldo inicial de una jornada abierta (queda en el historial)
create or replace function public.tes_corregir_inicial(p_jornada uuid, p_cuenta uuid, p_monto numeric, p_motivo text) returns void
language plpgsql as $$
declare anterior numeric;
begin
  if not public.puede_editar() then raise exception 'No tenés permiso.'; end if;
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Indicá el motivo de la corrección.'; end if;
  select saldo_inicial into anterior from public.tes_jornada_saldos where jornada_id = p_jornada and cuenta_id = p_cuenta;
  update public.tes_jornada_saldos set saldo_inicial = p_monto where jornada_id = p_jornada and cuenta_id = p_cuenta;
  insert into public.tes_jornada_eventos (jornada_id, accion, motivo, datos)
  values (p_jornada, 'correccion', p_motivo, jsonb_build_object('cuenta_id', p_cuenta, 'antes', anterior, 'despues', p_monto));
end $$;

-- =====================================================================
--  Permisos: Tesorería es de Administración y Gerencia
-- =====================================================================
alter table public.tes_cuentas          enable row level security;
alter table public.tes_categorias       enable row level security;
alter table public.tes_cheques          enable row level security;
alter table public.tes_movimientos      enable row level security;
alter table public.tes_extractos        enable row level security;
alter table public.tes_jornadas         enable row level security;
alter table public.tes_jornada_saldos   enable row level security;
alter table public.tes_jornada_eventos  enable row level security;

drop policy if exists tes_cuentas_sel on public.tes_cuentas;
create policy tes_cuentas_sel on public.tes_cuentas for select to authenticated using (public.puede_editar());
drop policy if exists tes_cuentas_upd on public.tes_cuentas;
create policy tes_cuentas_upd on public.tes_cuentas for update to authenticated using (public.es_gerencia()) with check (public.es_gerencia());

drop policy if exists tes_cat_sel on public.tes_categorias;
create policy tes_cat_sel on public.tes_categorias for select to authenticated using (public.puede_editar());
drop policy if exists tes_cat_ins on public.tes_categorias;
create policy tes_cat_ins on public.tes_categorias for insert to authenticated with check (public.puede_editar());
drop policy if exists tes_cat_upd on public.tes_categorias;
create policy tes_cat_upd on public.tes_categorias for update to authenticated using (public.puede_editar()) with check (public.puede_editar());

drop policy if exists tes_mov_sel on public.tes_movimientos;
create policy tes_mov_sel on public.tes_movimientos for select to authenticated using (public.puede_editar());
drop policy if exists tes_mov_ins on public.tes_movimientos;
create policy tes_mov_ins on public.tes_movimientos for insert to authenticated with check (public.puede_editar());
drop policy if exists tes_mov_upd on public.tes_movimientos;
create policy tes_mov_upd on public.tes_movimientos for update to authenticated using (public.puede_editar()) with check (public.puede_editar());

drop policy if exists tes_chq_sel on public.tes_cheques;
create policy tes_chq_sel on public.tes_cheques for select to authenticated using (public.puede_editar());
drop policy if exists tes_chq_ins on public.tes_cheques;
create policy tes_chq_ins on public.tes_cheques for insert to authenticated with check (public.puede_editar());
drop policy if exists tes_chq_upd on public.tes_cheques;
create policy tes_chq_upd on public.tes_cheques for update to authenticated using (public.puede_editar()) with check (public.puede_editar());

drop policy if exists tes_ext_sel on public.tes_extractos;
create policy tes_ext_sel on public.tes_extractos for select to authenticated using (public.puede_editar());
drop policy if exists tes_ext_ins on public.tes_extractos;
create policy tes_ext_ins on public.tes_extractos for insert to authenticated with check (public.puede_editar());
drop policy if exists tes_ext_upd on public.tes_extractos;
create policy tes_ext_upd on public.tes_extractos for update to authenticated using (public.puede_editar()) with check (public.puede_editar());
drop policy if exists tes_ext_del on public.tes_extractos;
create policy tes_ext_del on public.tes_extractos for delete to authenticated using (public.puede_editar() and estado = 'pendiente');

drop policy if exists tes_jor_sel on public.tes_jornadas;
create policy tes_jor_sel on public.tes_jornadas for select to authenticated using (public.puede_editar());
drop policy if exists tes_jor_ins on public.tes_jornadas;
create policy tes_jor_ins on public.tes_jornadas for insert to authenticated with check (public.puede_editar());
drop policy if exists tes_jor_upd on public.tes_jornadas;
create policy tes_jor_upd on public.tes_jornadas for update to authenticated using (public.puede_editar()) with check (public.puede_editar());

drop policy if exists tes_js_sel on public.tes_jornada_saldos;
create policy tes_js_sel on public.tes_jornada_saldos for select to authenticated using (public.puede_editar());
drop policy if exists tes_js_ins on public.tes_jornada_saldos;
create policy tes_js_ins on public.tes_jornada_saldos for insert to authenticated with check (public.puede_editar());
drop policy if exists tes_js_upd on public.tes_jornada_saldos;
create policy tes_js_upd on public.tes_jornada_saldos for update to authenticated using (public.puede_editar()) with check (public.puede_editar());

drop policy if exists tes_je_sel on public.tes_jornada_eventos;
create policy tes_je_sel on public.tes_jornada_eventos for select to authenticated using (public.puede_editar());
drop policy if exists tes_je_ins on public.tes_jornada_eventos;
create policy tes_je_ins on public.tes_jornada_eventos for insert to authenticated with check (public.puede_editar());

-- ---------- Permisos (por si el proyecto no los trae por defecto) -----
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
