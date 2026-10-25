-- =====================================================================
-- Migración 19 · Catálogo: sub rubro (sub categoría) de los productos
-- Correr DESPUÉS de la migración 18. Se puede correr más de una vez.
-- Solo AGREGA una columna opcional (subcategoria) y un índice.
-- No borra ni modifica ningún dato existente.
--
--  · Ej: categoría DESCARTABLES → sub rubro GASTRONÓMICOS.
--  · Se guarda en mayúsculas y sin espacios de más (como la categoría;
--    lo normaliza la app al guardar y al importar).
--  · Permisos: las políticas de productos (migraciones 17 y 18) son por
--    fila, así que ya cubren la columna nueva: ver con
--    puede_ver('catalogo'), cargar/editar con puede_editar_catalogo().
--  · El respaldo la incluye solo (exporta select *).
-- =====================================================================

alter table public.productos add column if not exists subcategoria text;

create index if not exists productos_cat_subcat_idx
  on public.productos (categoria, subcategoria, orden, nombre);
