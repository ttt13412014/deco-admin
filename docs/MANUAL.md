# DE&CO · Panel Administrativo (MVP)

App web interna para el Área de Administración de DE&CO, armada sobre los procedimientos A01, A04, A05, A06 y A08.

| Módulo | Procedimiento | Qué hace |
|---|---|---|
| **Inicio** | — | Tareas del día, cuánto hay por cobrar, cuánto vencido, plata disponible, jornada del día y control para Gerencia |
| **Clientes** | A01 | Alta y edición con validación de CUIT. Estados activo / pendiente / inhabilitado. Importación desde Excel |
| **Cobranzas** | A05 | Comprobantes y vencimientos, estados automáticos, aviso por WhatsApp, gestiones, cobros (totales o parciales) |
| **Reporte de los lunes** | A05 §3 | Estado de cuenta de los clientes con deuda, con texto listo para copiar a Ventas o Gerencia, o imprimir |
| **Hoja de ruta** | — | Elegís clientes y qué lleva cada uno (pegando una lista), arma el recorrido en Google Maps, lo manda al chofer por WhatsApp, imprime la hoja con firma y marca entregas. Monto de factura por parada (a mano o leyendo el PDF de la factura; las notas de crédito restan) y total de la hoja para la caja del chofer |
| **Personal** | — | Legajos, vacaciones por LCT con saldo, licencias, permisos, reuniones y feriados con aprobación de Gerencia, y calendario anual que se exporta a PDF, imagen, iCal y Excel |
| **Cuentas a cobrar** | A05 | Importación del Excel de Sintesys sin duplicar, vendedor, vencimiento original, fecha estimada de cobro con historial, promesas de pago y pagos informados a validar |
| **Cuentas a pagar** | A08 | Obligaciones de Sintesys y manuales (sueldos, alquiler, impuestos, servicios, cuotas), decisión de los dueños, pagos parciales y prioridades |
| **Tesorería** | A04 + A06 + A08 | Un solo libro para Caja en efectivo, Banco Galicia y Banco Macro, cheques y e-cheq, apertura y cierre diario por cuenta, conciliación bancaria y flujo de fondos |

## Reglas que aplica sola (validadas en la base de datos)

- No se puede **facturar a un cliente** que no esté activo (A01/A03).
- No se puede **habilitar un cliente** si le faltan datos obligatorios (A01).
- Solo **Gerencia** puede cambiar el vencimiento, el monto o el medio de pago de una factura, o anularla (A05).
- No se puede cobrar **más que el saldo**. Un pago parcial o con otro medio de pago se **escala a Gerencia** automáticamente (A05 §5).
- La jornada **no cierra** sin el checklist completo y el saldo real de cada cuenta. Si hay diferencia, la **justificación es obligatoria** (A06).
- Un día cerrado **no se toca**. Solo Gerencia puede reabrirlo, con motivo, y queda en el historial. No se abre un día nuevo con el anterior abierto.
- **Sin autorización no se paga** (A08), salvo las categorías de gasto menor que Gerencia marque como pago directo.
- **Todo queda auditado** con fecha y responsable en la tabla `auditoria`.

## Roles

| Rol | Puede |
|---|---|
| `administracion` | Cargar y editar clientes, comprobantes, cobros, movimientos, cheques y cierres |
| `ventas` | Solo **Clientes** (consultar, dar de alta, editar e importar; quedan pendientes y no ve saldos) y **Hoja de ruta** (armar, editar y marcar entregas). No ve facturas, cobranzas, Tesorería, pagos, personal, reportes ni el tablero de inicio, ni por la app ni por la API (migración 11) |
| `gerencia` | Todo lo anterior, más autorizar pagos, reabrir jornadas, decidir qué categorías se pagan sin autorización, cambiar vencimientos, anular comprobantes y ver auditoría |

---

## Puesta en marcha (unos 15 minutos)

### 1. Supabase
1. Creá un proyecto nuevo en [supabase.com](https://supabase.com). La región más cercana es São Paulo.
2. Andá a **SQL Editor → New query**, pegá **todo** el contenido de `supabase/schema.sql` y dale a **Run**.
3. En **Project Settings → API** copiá la **Project URL** y la **anon public key**, que van en Vercel.
4. **Usuarios**: cada persona se registra sola desde la pantalla de ingreso de la app, en **Crear cuenta**.
   - La **primera cuenta** queda como **Gerencia**.
   - Las siguientes quedan **pendientes, sin acceso a ningún dato**, hasta que Gerencia les asigne un rol en el menú **Usuarios**.
   - Si querés evitar el mail de confirmación, desactivá **Authentication → Sign In / Providers → Email → Confirm email**.
   - **No desactives "Allow new users to sign up"**, porque si no nadie puede registrarse.

### 2. Local (opcional)
```bash
npm install
cp .env.example .env.local   # completá URL y anon key (Supabase → Project Settings → API)
npm run dev
```

### 3. Vercel
1. Subí la carpeta a un repo de GitHub.
2. En Vercel, **Add New → Project**, elegí el repo.
3. En **Environment Variables**, cargá:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. Deploy.

---

## Respaldo

En el menú **Respaldo** (Administración y Gerencia):
- **Excel**: una hoja por sección (clientes, facturas, cobros, tesorería, hojas de ruta, personal, usuarios y, para Gerencia, auditoría), más una hoja de resumen con la cantidad de registros.
- **JSON**: copia exacta de todos los registros. Es el archivo que sirve para restaurar o migrar.

La app avisa en Inicio cuando pasó una semana sin respaldo desde esa computadora. Guardá los archivos en un lugar privado, porque tienen datos personales.

## Configuración rápida

En `lib/utils.ts`:

- `DIAS_AVISO_PREVIO = 3`: anticipación del aviso preventivo (72 hs).
- `DIAS_ATRASO_PROLONGADO = 30`: desde cuántos días de atraso es "atraso prolongado".
- `PLAZO_CC_DEFAULT = 30`: plazo por defecto de cuenta corriente.
- `mensajeCobranza()`: los textos de WhatsApp.
- `MEDIOS_PAGO`, `TIPOS_COMPROBANTE`: listas editables.
- Checklist de cierre: `CHECKLIST_CIERRE` en `lib/tesoreria.ts`. Si cambiás las claves, actualizá también el array `requeridos` de `tes_cerrar_jornada` en `schema.sql`.
- Categorías y rubros: se editan desde la app, en **Tesorería → Categorías**.

## Personal

- **Resumen**: empleados activos, vacaciones y licencias por aprobar, cumpleaños del mes, permisos pendientes, quién no está hoy y los eventos de los próximos 30 días.
- **Personal**: legajo con CUIL (valida el dígito verificador), puesto, área, ingreso, nacimiento y contacto de emergencia.
  - Los **días de vacaciones** salen solos por LCT (art. 150): 14, 21, 28 o 35 días corridos según la antigüedad al 31/12, y proporcional si entró en el año. Se pueden cargar a mano en el legajo.
  - Muestra días asignados, usados y saldo, más los pedidos sin aprobar.
- **Novedades**: vacaciones, licencias, permisos, reuniones, feriados propios y otros.
  - Quedan **pendientes** hasta que Gerencia las aprueba o las rechaza con motivo. Si se cambian las fechas de algo aprobado, vuelve a aprobación.
  - Al cargar avisa si no alcanza el saldo, si las vacaciones no arrancan un lunes (LCT art. 151) o si se superponen con otra novedad.
  - Los **cumpleaños** salen de la fecha de nacimiento y los **feriados nacionales 2026** ya están cargados (en `lib/personal.ts`, `FERIADOS`, se agregan los de cada año).
  - Las **licencias no guardan ni muestran diagnósticos**: en el calendario dicen solo "Licencia".
- **Calendario anual**: los 12 meses con un color por tipo de evento. Se filtra por empleado y por tipo, y se pueden mostrar u ocultar los pendientes. Tocando un día ves el detalle, con un link para agregar cada evento a Google Calendar.

### Exportar
- **Período**: año completo, un trimestre, un mes o **una semana**. La semana se elige con cualquier día de esa semana y se mueve con ‹ ›. También se puede descargar directo desde el día tocado en el calendario ("Descargar PDF" de esa semana).
- **PDF e imagen PNG**: A4 apaisado listo para imprimir, con los filtros aplicados. La semana sale en 7 columnas (lunes a domingo) con cada novedad, su horario y el rango de días.
- El iCal, el Excel (hoja de eventos) y el CSV de eventos se recortan al período elegido. El saldo de vacaciones siempre es del año.
- **iCal (.ics)**: en Google Calendar se importa desde Configuración → Importar y exportar. También sirve para Outlook y el celular.
- **Excel**: cuatro hojas (vacaciones por empleado, eventos del año, legajos y feriados). También hay CSV de vacaciones y de eventos.
- **Suscripción automática** (para que Google Calendar se actualice solo):
  1. En Vercel cargá `ICAL_TOKEN` (una clave larga que inventes) y `SUPABASE_SERVICE_ROLE_KEY`.
  2. En Google Calendar andá a "Otros calendarios" → "+" → "Desde URL" y pegá `https://TU-APP.vercel.app/api/ical?token=TU_ICAL_TOKEN`.
  3. Solo entran los eventos aprobados. Google lo refresca cada algunas horas.

## Tesorería

Todo sale de **un solo registro de movimientos**. Lo que se carga una vez aparece en Caja, Bancos, Cheques, Flujo de fondos y los reportes. No hay que pasarlo a mano de un lado a otro.

**Cuentas**: Caja en efectivo, Banco Galicia y Banco Macro, siempre por separado. No hay billeteras virtuales.

**Cada movimiento** tiene: fecha de operación, tipo (ingreso, egreso o transferencia propia), rubro y categoría, concepto, cliente o proveedor, medio, cuenta, importe, fecha prevista y efectiva, estado (pendiente, autorizado, realizado, anulado), comprobante, observaciones y responsable. Nada se borra: se anula con motivo y queda en el historial.

- **Transferencias propias** (depósito de efectivo, pase de Galicia a Macro): se cargan una vez y crean dos movimientos vinculados. No cuentan como ingreso ni gasto, y si se anula una pata se anula la otra.
- **Disponible y proyectado**: disponible es lo realizado en cada cuenta. Proyectado suma los cheques en cartera y los cobros de los próximos 7 días, y resta los cheques emitidos sin debitar y los pagos autorizados de los próximos 7 días.

### Apertura y cierre (A06)
1. **Abrir**: se propone el saldo que dejó el cierre anterior para cada cuenta. Si contás otro número, explicás por qué.
2. Durante el día se cargan los movimientos.
3. **Cerrar**: por cuenta se ve saldo inicial, ingresos, egresos, transferencias y esperado. Cargás el **real** (efectivo contado y saldo del homebanking) y la diferencia se calcula sola. Si hay diferencia, la justificación es obligatoria. Checklist obligatorio.
4. El saldo real del cierre es el punto de partida del día siguiente.
5. Cada apertura, cierre, reapertura (solo Gerencia, con motivo) y corrección del saldo inicial queda en el **historial**, con fecha y responsable.

### Bancos y conciliación
- Bajá el extracto de Galicia o Macro del homebanking (Excel o CSV) y subilo en **Importar extracto**. Las columnas se reconocen solas (fecha, descripción, débito, crédito o importe, saldo) y se pueden corregir. Si importás dos veces el mismo período, no se duplica.
- La app cruza cada línea con lo cargado (mismo importe y sentido, fecha cercana) y sugiere la conciliación. **Conciliar los sugeridos** las une todas de una vez.
- Lo que queda a la vista: **extracto sin identificar** (débitos o créditos que no cargaste: comisiones, impuesto al cheque, transferencias recibidas) y **cargado sin ver en el banco**.
- **Cargar**: crea el movimiento desde la línea del extracto y lo concilia. Detecta comisiones e impuesto a los débitos y créditos.
- Un movimiento conciliado no se puede cambiar ni anular sin desconciliarlo antes.

### Cheques y e-cheq
- **Recibidos**: entran desde Cobranzas (al registrar el cobro con cheque o e-cheq) o con **+ Cheque recibido**. Quedan **en cartera** y **no suman a la plata disponible** hasta que se acreditan.
  - Acciones: depositar, acreditado, endosar a un proveedor (paga un pago autorizado o uno nuevo, sin pasar por ninguna cuenta), rechazado o anular.
  - Si se rechaza o se anula, el cobro se deshace y la **factura del cliente vuelve a quedar con deuda**. Si ya estaba acreditado, se registra el débito del rechazo.
- **Emitidos**: se emiten desde un pago autorizado (**Pagar → Cheque o E-cheq**). Quedan como **compromiso** y se descuentan del banco recién cuando se **debitan**. Nunca se descuentan dos veces. Si el cheque se rechaza o se anula, el pago vuelve a quedar pendiente.
- Al conciliar con el extracto, el cheque se marca solo como acreditado o debitado.

### Flujo de fondos (A08)
1. Arranca de la **plata real de hoy** en cada cuenta (Caja y Bancos, sin cheques en cartera).
2. Suma lo que se espera cobrar (**Cuentas a cobrar**, en su fecha estimada o su vencimiento) y los cheques a acreditar. Resta lo que hay que pagar (**Cuentas a pagar**, en su fecha estimada o su vencimiento) y los cheques emitidos en su fecha de débito. Cuando algo se cobra o se paga, sale de la proyección y aparece en el saldo real: nunca se cuenta dos veces. Un pago parcial deja proyectado solo lo que falta.
3. **Período**: 7, 15, 30 o 60 días, o un rango. Vistas: calendario, día por día, diario por cuenta, por semana, por mes y lista de movimientos.
4. **Con fecha / Con los sin fecha**: lo que no tiene fecha (por ejemplo una factura vencida sin fecha estimada) no se ubica en ningún día; en la vista alternativa se lista aparte con su total.
5. **Alertas**: faltante total, faltante por cuenta (aunque el total dé positivo) y caída por debajo de la **reserva mínima** de cada cuenta. Cada una dice la fecha, la cuenta, cuánto falta, el motivo y qué pagos revisar por vencimiento y prioridad. No reprograma nada solo.
6. **Reservas mínimas**: Administración carga el monto para Efectivo, Galicia y Macro y en qué cuenta se proyectan los cobros y pagos que no tienen cuenta.
7. **Simular transferencia**: origen, destino, importe y fechas de envío y acreditación. Se ve el efecto en la proyección sin tocar los saldos reales. Si Gerencia la confirma, se registra en Caja y Bancos.

### Cuentas a cobrar y Sintesys
- **Importar Sintesys**: subís el Excel de comprobantes pendientes. Las columnas se reconocen solas y se pueden corregir. Antes de confirmar ves cuáles son nuevas, cuáles se actualizan y qué clientes se parecen a uno existente ("Metalúrgica Norte S.A." = "METALURGICA NORTE SA"). Reimportar no duplica: se actualizan saldo y vencimiento, se conserva el vencimiento original y todas las gestiones.
- Sintesys sigue siendo la fuente oficial: si el saldo de Sintesys es distinto al de la app, se marca **Distinto a Sintesys** y vos decidís si registrar el cobro (entra a Caja) o ajustarlo con motivo. Nada se cambia en silencio. También se marcan los comprobantes que **no figuran en el último Excel**.
- **Fecha estimada de cobro** y **promesas de pago** (con alerta si se incumplen). Todo cambio de fecha queda en el historial y mueve el cobro en el flujo de fondos.
- **Pagos informados**: si el cliente avisa que pagó, queda **pendiente de validación**: no baja la deuda ni entra a Caja ni al flujo real. Al confirmarlo se imputa a las facturas y entra a Caja y Bancos.

### Cuentas a pagar
- **Importar Sintesys** (entran como *Pendiente de revisión*) o carga manual: sueldos, alquiler, servicios, impuestos, gastos, cheques diferidos, préstamos. Se pueden cargar **en cuotas**: cada cuota con su vencimiento, saldo y estado.
- Estados: pendiente de revisión, pendiente de decisión, autorizado, programado, reprogramado, pagado, cancelado; y además se marca vencido y parcialmente pagado.
- **Los dueños (Gerencia) deciden** qué se paga (de a una o seleccionando varias). Administración revisa, cambia fechas estimadas con motivo y registra los pagos con su comprobante. El sistema no autoriza ni paga nada solo.
- **Registrar pago**: total o parcial, en efectivo, transferencia o cheque. Crea el egreso en Caja y Bancos (un solo movimiento, sin duplicar). Si se anula el pago o se rechaza el cheque, la deuda vuelve.
- Los pagos previstos que se cargan desde Tesorería o el Flujo también van a Cuentas a pagar.

### Categorías
En **Tesorería → Categorías** están los rubros y categorías de ingresos y egresos. Se pueden crear, renombrar y desactivar. Con **Pegar lista del Excel** se copian las dos columnas (Rubro y Categoría) de la planilla actual y se agregan todas de una vez. Solo Gerencia decide cuáles se pagan sin autorización.

### Reportes y Excel
- **Resumen**: disponible por cuenta y total, proyectado, ingresos y egresos del día por cuenta, cheques próximos, pendientes de conciliación, pagos por autorizar y diferencias de cierre. El botón **Excel** baja todo en un archivo con una hoja por tema.
- **Movimientos**: filtros por fecha (efectiva u operación), cuenta, tipo, estado, categoría, conciliado y texto. Se exporta a Excel tal cual se ve.
- **Cierre del día**, **conciliación** y **cheques**: cada pantalla tiene su Excel.

> La caja diaria y el flujo de fondos anteriores quedan en la base como histórico (aparecen en el respaldo), pero ya no se usan. Lo nuevo arranca con la primera apertura de jornada.

## Hoja de ruta

1. Importá los clientes con dirección (ver abajo). Si una dirección rural no la encuentra Maps, cargá la **Ubicación** con coordenadas (en Google Maps mantené apretado el punto y copiá los números).
2. En **Hoja de ruta → Nueva**, pegá una línea por cliente: `Cliente - qué lleva (2 bultos)`. Reconoce el cliente aunque escribas el nombre a medias.
3. **Ruta automática**: con "Ordenar solo" activado, cada vez que agregás clientes la app los ubica en el mapa y arma el orden más corto saliendo del depósito (el más cercano primero, sin cruces, y volviendo al final). También está el botón **⚡ Ordenar ruta automática**. Muestra km y tiempo estimados. Con hasta 8 paradas el orden es exacto. Después podés ajustar a mano con las flechas.
   - Las direcciones se ubican con OpenStreetMap (gratis, ~1 por segundo) y quedan guardadas en el cliente, así la próxima vez es instantáneo.
   - Si una dirección no aparece (rutas, zonas rurales), cargá la **Ubicación** con coordenadas en la ficha del cliente.
   - Guardá la hoja.
4. **Abrir en Google Maps** te arma el recorrido. Si hay más de 9 paradas, se divide en tramos.
5. Con **Mandar al chofer por WhatsApp** le llega el listado con el link. Desde la app, el chofer (con cualquier usuario) marca cada entrega y quién recibió.
6. Con **Duplicar** reutilizás un reparto que se repite.

> Si ya tenías la base creada con una versión anterior, corré en el SQL Editor las migraciones que te falten, en orden: `migracion_02_hoja_de_ruta.sql`, `migracion_03_ruta_automatica.sql` `migracion_04_flujo_de_fondos.sql` `migracion_05_personal.sql`, `migracion_06_registro.sql`, `migracion_07_tesoreria.sql`, `migracion_08_gestion.sql` y `migracion_09_montos_hoja_de_ruta.sql`.

## Importar clientes desde Excel

En **Clientes → Importar Excel**:

- Hay una **plantilla para descargar**.
- Los encabezados se reconocen solos: Razón social, CUIT, Condición IVA, Contacto, Teléfono, Email, Dirección, Localidad, Horarios, Medio de pago.
- El CUIT/DNI es opcional, también para habilitar el cliente (migración 12). Si se carga, se valida el formato.
- Formato de facturación: Factura A, B, E o Presupuesto (migración 12). Con "Presupuesto", al cargar un comprobante para ese cliente se sugiere el tipo Presupuesto.
- Si el cliente ya existe (mismo CUIT o mismo nombre), se **completan** su dirección, teléfono y contacto con los datos del Excel. No se tocan CUIT, IVA ni estado.
- Por defecto todos entran como *pendientes*. Opcionalmente se habilitan los que tienen todos los datos completos.

## Próximas fases

- **Fase 2**: Proveedores (A02) vinculados a los pagos de Tesorería, y Facturación con control de pedido (A03).
- **Fase 3**: Listas de precios con aprobación (A10), Contador (A09), Archivo (A07) y tablero de Gerencia.

## Stack

Next.js 14 (App Router), React 18, Tailwind CSS, Supabase (Postgres + Auth + RLS) y SheetJS para importar Excel.

## Hoja de ruta: montos de factura y lectura de PDF

- Cada parada tiene un campo **Monto factura $**. Para una nota de crédito se pone con signo menos.
- **📎 Factura PDF** (en cada parada) o la pestaña **Facturas PDF** (varios PDF juntos) leen el PDF en el navegador
  (no se sube a ningún servidor) y sacan tipo de comprobante, número, fecha, cliente (receptor, no emisor), CUIT/DNI e
  **Importe Total**. Las notas de crédito restan, los presupuestos se ignoran. Todo se puede revisar y corregir antes de guardar.
- El total de la hoja (facturas, notas de crédito, total y lo ya entregado) aparece en el panel **Recorrido**, al pie de las paradas,
  en la hoja impresa, en el mensaje de WhatsApp al chofer y en el listado de hojas.
- Requiere `supabase/migracion_09_montos_hoja_de_ruta.sql`. Sin esa migración la app sigue andando y avisa que los montos no se guardan.
- PDFs escaneados (foto, sin texto) no se pueden leer: se carga el monto a mano.
- Pruebas del lector: `npm run test:facturas` (usa los PDF de `scripts/facturas-prueba/`, generados con `scripts/generar-facturas-prueba.py`).
- El worker de pdf.js se copia a `public/` en cada `npm run build` (`scripts/copiar-worker-pdf.mjs`).
