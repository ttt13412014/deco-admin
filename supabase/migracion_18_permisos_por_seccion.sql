-- =====================================================================
-- Migración 18 · Permisos por sección (Usuarios → "Permisos por sección")
-- Correr DESPUÉS de la migración 17. Se puede correr más de una vez.
-- Solo AGREGA una columna (perfiles.secciones), funciones nuevas y una
-- política nueva, y CAMBIA las condiciones de lectura de las políticas.
-- No borra ni modifica ningún dato.
--
--  · perfiles.secciones (text[], null por defecto): las secciones del menú
--    que ve la persona. null = las que trae su rol, o sea, exactamente lo
--    mismo que antes de esta migración:
--      Ventas         → clientes, rutas, catalogo
--      Administración → todo menos usuarios
--      Gerencia       → todo, SIEMPRE (se ignora la lista: no se puede
--                       quedar afuera)
--      Pendiente      → nada
--  · A Ventas solo se le pueden sumar: inicio, cobranzas, reporte (más sus
--    tres de siempre). El resto de las secciones son pantallas de trabajo de
--    Administración; aunque estén en la lista de alguien de Ventas, no cuentan.
--  · Usuarios es siempre y solo de Gerencia.
--  · La ESCRITURA sigue dependiendo del rol, como hasta ahora. Única
--    excepción: Ventas con "cobranzas" puede anotar gestiones de cobranza
--    (avisos por WhatsApp, notas). No cobra, no cambia vencimientos.
--  · Las claves tienen que coincidir con lib/permisos.ts (MENU).
-- =====================================================================

-- ---------- 1. Columna -------------------------------------------------
alter table public.perfiles add column if not exists secciones text[];
comment on column public.perfiles.secciones is
  'Secciones del menú que ve el usuario (lib/permisos.ts). null = las de su rol. Gerencia ve todo siempre.';

-- ---------- 2. Funciones ------------------------------------------------
create or replace function public.secciones_todas() returns text[]
language sql immutable set search_path = public as $$
  select array['inicio','clientes','cobranzas','reporte','rutas','catalogo','personal',
               'tesoreria','caja','movimientos','bancos','cheques','pagos','flujo','categorias',
               'respaldo','usuarios']::text[]
$$;

-- Lo que trae cada rol cuando no tiene lista propia
create or replace function public.secciones_del_rol(p_rol text) returns text[]
language sql immutable set search_path = public as $$
  select case p_rol
    when 'gerencia'       then public.secciones_todas()
    when 'administracion' then array_remove(public.secciones_todas(), 'usuarios')
    when 'ventas'         then array['clientes','rutas','catalogo']::text[]
    else '{}'::text[]
  end
$$;

-- Lo que se le puede habilitar a cada rol
create or replace function public.secciones_posibles(p_rol text) returns text[]
language sql immutable set search_path = public as $$
  select case p_rol
    when 'gerencia'       then public.secciones_todas()
    when 'administracion' then array_remove(public.secciones_todas(), 'usuarios')
    when 'ventas'         then array['inicio','clientes','cobranzas','reporte','rutas','catalogo']::text[]
    else '{}'::text[]
  end
$$;

-- Secciones que ve de verdad el usuario actual
create or replace function public.secciones_efectivas() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
      when p.rol = 'gerencia' then public.secciones_todas()
      else array(
        select s from unnest(coalesce(p.secciones, public.secciones_del_rol(p.rol))) s
         where s = any(public.secciones_posibles(p.rol))
      )
    end
    from public.perfiles p where p.id = auth.uid()
  ), '{}'::text[])
$$;

create or replace function public.puede_ver(p_seccion text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_seccion = any(public.secciones_efectivas())
$$;

create or replace function public.puede_ver_alguna(p_secciones text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select public.secciones_efectivas() && p_secciones
$$;

revoke execute on function public.secciones_efectivas() from anon;
revoke execute on function public.puede_ver(text) from anon;
revoke execute on function public.puede_ver_alguna(text[]) from anon;

-- ---------- 3. Políticas de lectura ------------------------------------
-- Grupos de tablas → secciones que las necesitan.
--   Tesorería (TES) = tesoreria, caja, movimientos, bancos, cheques, categorias, pagos, flujo
--   (las pantallas de Tesorería, Cuentas a pagar y Flujo comparten tablas).
-- Las tablas que hasta ahora eran solo de Administración/Gerencia y que
-- Ventas no puede recibir mantienen además puede_editar().

-- Clientes: los usan Clientes, Hoja de ruta (paradas), Cobranzas, Reporte y Flujo
alter policy clientes_sel on public.clientes
  using ((select public.puede_ver_alguna(array['clientes','rutas','cobranzas','reporte','flujo'])));

-- Cobranzas
alter policy facturas_sel on public.facturas
  using ((select public.puede_ver_alguna(array['cobranzas','reporte','flujo'])));
alter policy cobros_sel on public.cobros
  using ((select public.puede_ver('cobranzas')));
alter policy gestiones_sel on public.gestiones_cobranza
  using ((select public.puede_ver('cobranzas')));
alter policy prom_sel on public.cob_promesas
  using ((select public.puede_ver('cobranzas')));
alter policy pi_sel on public.cob_pagos_informados
  using ((select public.puede_ver('cobranzas')));
alter policy hist_sel on public.hist_fechas
  using ((select public.puede_ver_alguna(array['cobranzas','pagos'])));
alter policy lotes_sel on public.imp_lotes
  using ((select public.puede_ver_alguna(array['cobranzas','pagos'])));

-- Ventas con "cobranzas" puede anotar gestiones (avisos por WhatsApp, notas)
drop policy if exists gestiones_ins_ventas on public.gestiones_cobranza;
create policy gestiones_ins_ventas on public.gestiones_cobranza for insert to authenticated
  with check (public.es_ventas() and (select public.puede_ver('cobranzas')));

-- Hoja de ruta (las RPC del chofer son SECURITY DEFINER: no cambian)
alter policy hojas_sel on public.hojas_ruta
  using ((select public.puede_ver('rutas')));
alter policy paradas_sel on public.hoja_ruta_paradas
  using ((select public.puede_ver('rutas')));

-- Catálogo (las fotos siguen siendo públicas por URL, para el PDF)
alter policy productos_sel on public.productos
  using ((select public.puede_ver('catalogo')));

-- Personal (políticas ALL: lectura y escritura)
alter policy empleados_all on public.empleados
  using (public.puede_editar() and (select public.puede_ver('personal')))
  with check (public.puede_editar() and (select public.puede_ver('personal')));
alter policy novedades_all on public.novedades
  using (public.puede_editar() and (select public.puede_ver('personal')))
  with check (public.puede_editar() and (select public.puede_ver('personal')));

-- Flujo de fondos
alter policy flujo_all on public.flujo_movimientos
  using (public.puede_editar() and (select public.puede_ver('flujo')))
  with check (public.puede_editar() and (select public.puede_ver('flujo')));
alter policy flujo_saldos_sel on public.flujo_saldos
  using (public.puede_editar() and (select public.puede_ver('flujo')));
alter policy sim_all on public.tes_simulaciones
  using (public.puede_editar() and (select public.puede_ver('flujo')))
  with check (public.puede_editar() and (select public.puede_ver('flujo')));

-- Tesorería, Cuentas a pagar y caja anterior
alter policy pag_sel on public.pag_obligaciones
  using (public.puede_editar() and (select public.puede_ver_alguna(array['tesoreria','caja','movimientos','bancos','cheques','categorias','pagos','flujo'])));
alter policy tes_ext_sel on public.tes_extractos
  using (public.puede_editar() and (select public.puede_ver_alguna(array['tesoreria','caja','movimientos','bancos','cheques','categorias','pagos','flujo'])));
alter policy tes_jor_sel on public.tes_jornadas
  using (public.puede_editar() and (select public.puede_ver_alguna(array['tesoreria','caja','movimientos','bancos','cheques','categorias','pagos','flujo'])));
alter policy tes_js_sel on public.tes_jornada_saldos
  using (public.puede_editar() and (select public.puede_ver_alguna(array['tesoreria','caja','movimientos','bancos','cheques','categorias','pagos','flujo'])));
alter policy tes_je_sel on public.tes_jornada_eventos
  using (public.puede_editar() and (select public.puede_ver_alguna(array['tesoreria','caja','movimientos','bancos','cheques','categorias','pagos','flujo'])));
alter policy cajas_all on public.cajas
  using (public.puede_editar() and (select public.puede_ver_alguna(array['tesoreria','caja','movimientos','bancos','cheques','categorias','pagos','flujo'])))
  with check (public.puede_editar() and (select public.puede_ver_alguna(array['tesoreria','caja','movimientos','bancos','cheques','categorias','pagos','flujo'])));
alter policy mov_all on public.movimientos_caja
  using (public.puede_editar() and (select public.puede_ver_alguna(array['tesoreria','caja','movimientos','bancos','cheques','categorias','pagos','flujo'])))
  with check (public.puede_editar() and (select public.puede_ver_alguna(array['tesoreria','caja','movimientos','bancos','cheques','categorias','pagos','flujo'])));

-- Cuentas y categorías: también las necesita "Registrar cobro" en Cobranzas
alter policy tes_cuentas_sel on public.tes_cuentas
  using (public.puede_editar() and (select public.puede_ver_alguna(array['tesoreria','caja','movimientos','bancos','cheques','categorias','pagos','flujo','cobranzas'])));
alter policy tes_cat_sel on public.tes_categorias
  using (public.puede_editar() and (select public.puede_ver_alguna(array['tesoreria','caja','movimientos','bancos','cheques','categorias','pagos','flujo','cobranzas'])));

-- Movimientos y cheques: Tesorería ve todo; quien solo ve Cobranzas (Administración)
-- ve los que salen de un cobro (los crea "Registrar cobro")
alter policy tes_mov_sel on public.tes_movimientos
  using (public.puede_editar() and (
    (select public.puede_ver_alguna(array['tesoreria','caja','movimientos','bancos','cheques','categorias','pagos','flujo']))
    or ((select public.puede_ver('cobranzas')) and (cobro_id is not null or factura_id is not null))
  ));
alter policy tes_chq_sel on public.tes_cheques
  using (public.puede_editar() and (
    (select public.puede_ver_alguna(array['tesoreria','caja','movimientos','bancos','cheques','categorias','pagos','flujo']))
    or ((select public.puede_ver('cobranzas')) and cobro_id is not null)
  ));

-- Sin cambios: perfiles (cada uno se ve a sí mismo; solo Gerencia edita, y
-- por eso solo Gerencia puede tocar perfiles.secciones), auditoria (Gerencia),
-- fotos del catálogo (públicas) y todas las políticas de escritura.
