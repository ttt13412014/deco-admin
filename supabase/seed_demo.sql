-- =====================================================================
--  Datos de DEMO (inventados) para probar el panel en un Supabase propio.
--  Ningún dato de este archivo corresponde a clientes o productos reales.
--  Correr DESPUÉS de schema.sql y de las migraciones 02 a 19.
-- =====================================================================

insert into public.clientes (razon_social, cuit_dni, condicion_iva, tipo_factura, contacto_nombre, telefono, email, direccion, localidad, horarios, estado)
values
  ('Almacén Demo Uno SRL',      '30712345671', 'Responsable Inscripto', 'A', 'Ana Ejemplo',   '351-000-0001', 'compras@demo-uno.test',   'Calle Falsa 123',      'Córdoba',      'Lun a Vie 8 a 13', 'activo'),
  ('Ferretería Ficticia SA',    '30500010912', 'Responsable Inscripto', 'A', 'Bruno Prueba',  '351-000-0002', 'admin@ficticia.test',     'Av. Siempreviva 742',  'Villa Allende','Lun a Sab 9 a 12', 'activo'),
  ('Kiosco El Ejemplo',         '20123456786', 'Monotributista',        'B', 'Carla Muestra', '351-000-0003', 'kiosco@ejemplo.test',     'Pasaje Inventado 45',  'Córdoba',      'Todos los días',   'activo'),
  ('Gastronomía Test SAS',      null,          null,                    'Presupuesto', null,  null,           null,                      'Bv. Demo 900',         'Río Ceballos', null,               'pendiente');

insert into public.productos (codigo, nombre, descripcion, categoria, medida, precio)
values
  ('DEMO-001', 'Vaso térmico',        'Con tapa',          'DESCARTABLES', '240 cc', 95),
  ('DEMO-002', 'Bandeja de aluminio', 'Para horno',        'DESCARTABLES', 'N° 103', 180),
  ('DEMO-003', 'Botella PET',         'Cristal',           'ENVASES',      '500 cc', 210),
  ('DEMO-004', 'Gatillo pulverizador','Rojo/azul',         'ENVASES',      null,     150),
  ('DEMO-005', 'Lavandina',           'Uso doméstico',     'LIMPIEZA',     '1 L',    700);
