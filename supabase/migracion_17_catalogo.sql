-- =====================================================================
-- Migración 17 · Catálogo de productos (lista, fotos, importación y PDF)
-- Correr DESPUÉS de la migración 16. Se puede correr más de una vez.
-- Solo AGREGA: una tabla nueva (productos), una función de rol, sus
-- políticas (RLS) y el bucket público "productos" para las fotos.
-- No borra ni modifica ningún dato existente.
--
--  · Ver el catálogo: cualquier usuario con acceso (tiene_acceso()).
--  · Cargar, editar, importar y borrar productos y fotos:
--    Ventas, Administración y Gerencia (puede_editar_catalogo()).
--  · Las fotos se leen por URL pública (el PDF del catálogo las usa).
-- =====================================================================

-- ---------- 1. Función de rol ------------------------------------------
create or replace function public.puede_editar_catalogo() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select rol in ('ventas','administracion','gerencia') from public.perfiles where id = auth.uid()), false)
$$;

-- ---------- 2. Tabla ---------------------------------------------------
create table if not exists public.productos (
  id           uuid primary key default gen_random_uuid(),
  codigo       text unique,                 -- clave para importar (upsert)
  nombre       text not null,
  descripcion  text,
  categoria    text,                        -- ej: LIMPIEZA, ENVASES PLÁSTICOS
  medida       text,                        -- medida / presentación (ej: 50x60, 500 cc, x 10 u.)
  precio       numeric(14,2),               -- opcional
  imagen_url   text,
  activo       boolean not null default true,
  orden        integer not null default 0,  -- orden dentro de la categoría en el catálogo
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  updated_at   timestamptz not null default now(),
  updated_by   uuid default auth.uid(),
  constraint productos_nombre_chk check (length(trim(nombre)) > 0),
  constraint productos_precio_chk check (precio is null or precio >= 0)
);
create index if not exists productos_categoria_idx on public.productos (categoria, orden, nombre);

drop trigger if exists productos_updated on public.productos;
create trigger productos_updated before update on public.productos
  for each row execute function public.tg_updated();
drop trigger if exists productos_audit on public.productos;
create trigger productos_audit after insert or update or delete on public.productos
  for each row execute function public.tg_auditoria();

-- ---------- 3. Permisos (RLS) ------------------------------------------
alter table public.productos enable row level security;
drop policy if exists productos_sel on public.productos;
create policy productos_sel on public.productos for select to authenticated using (public.tiene_acceso());
drop policy if exists productos_ins on public.productos;
create policy productos_ins on public.productos for insert to authenticated with check (public.puede_editar_catalogo());
drop policy if exists productos_upd on public.productos;
create policy productos_upd on public.productos for update to authenticated
  using (public.puede_editar_catalogo()) with check (public.puede_editar_catalogo());
drop policy if exists productos_del on public.productos;
create policy productos_del on public.productos for delete to authenticated using (public.puede_editar_catalogo());

grant select, insert, update, delete on public.productos to authenticated;
grant execute on function public.puede_editar_catalogo() to authenticated;

-- ---------- 4. Fotos: bucket público "productos" -----------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('productos', 'productos', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

drop policy if exists productos_img_sel on storage.objects;
create policy productos_img_sel on storage.objects for select to anon, authenticated
  using (bucket_id = 'productos');
drop policy if exists productos_img_ins on storage.objects;
create policy productos_img_ins on storage.objects for insert to authenticated
  with check (bucket_id = 'productos' and public.puede_editar_catalogo());
drop policy if exists productos_img_upd on storage.objects;
create policy productos_img_upd on storage.objects for update to authenticated
  using (bucket_id = 'productos' and public.puede_editar_catalogo())
  with check (bucket_id = 'productos' and public.puede_editar_catalogo());
drop policy if exists productos_img_del on storage.objects;
create policy productos_img_del on storage.objects for delete to authenticated
  using (bucket_id = 'productos' and public.puede_editar_catalogo());
