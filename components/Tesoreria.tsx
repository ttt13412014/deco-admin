'use client'

import { FormEvent, ReactNode, useState } from 'react'
import { sb, errMsg } from '@/lib/supabase'
import { fmtFecha, fmtMoney, hoy, parseMonto, sumarDias } from '@/lib/utils'
import { fechasRepetidas } from '@/lib/flujo'
import {
  Categoria, Cheque, Cuenta, ESTADO_CHEQUE, ESTADO_MOV, MEDIOS, MEDIOS_CARGA, Medio, Movimiento, TIPO_MOV, TipoMov, etiquetaMov, firmado, porRubro,
} from '@/lib/tesoreria'
import { generarXLSX, type Celda } from '@/lib/xlsx-lite'
import { descargar } from '@/lib/calendario-export'
import { useAuth } from './AuthProvider'
import { Alert, Badge, Button, Field, cx, inputCls } from './ui'

// ---------------------------------------------------------------------
// Selectores
// ---------------------------------------------------------------------
export function CategoriaSelect({
  categorias,
  tipo,
  value,
  onChange,
  id,
}: {
  categorias: Categoria[]
  tipo: 'ingreso' | 'egreso'
  value: string
  onChange: (v: string) => void
  id?: string
}) {
  return (
    <select id={id} className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— Elegir —</option>
      {porRubro(categorias, tipo).map(([rubro, cs]) => (
        <optgroup key={rubro} label={rubro}>
          {cs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nombre}
              {tipo === 'egreso' && !c.requiere_autorizacion ? ' · sin autorización' : ''}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

export function CuentaSelect({ cuentas, value, onChange, id, excluir, vacio }: { cuentas: Cuenta[]; value: string; onChange: (v: string) => void; id?: string; excluir?: string; vacio?: string }) {
  return (
    <select id={id} className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
      {vacio !== undefined && <option value="">{vacio}</option>}
      {cuentas
        .filter((c) => c.activa && c.id !== excluir)
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.nombre}
          </option>
        ))}
    </select>
  )
}

/** Cuenta que corresponde por defecto a cada medio. */
export function cuentaPorMedio(cuentas: Cuenta[], medio: Medio, actual: string): string {
  const efectivo = cuentas.find((c) => c.tipo === 'efectivo')?.id ?? ''
  const banco = cuentas.find((c) => c.tipo === 'banco')?.id ?? ''
  if (medio === 'efectivo') return efectivo
  if (actual && actual !== efectivo) return actual
  return banco
}

export interface DatosCheque {
  numero: string
  banco: string
  fecha_emision: string
  fecha_pago: string
  cuit: string
}
export const chequeVacio = (): DatosCheque => ({ numero: '', banco: '', fecha_emision: hoy(), fecha_pago: hoy(), cuit: '' })

export function CamposCheque({ value, onChange, emitido }: { value: DatosCheque; onChange: (v: DatosCheque) => void; emitido?: boolean }) {
  const set = (k: keyof DatosCheque, v: string) => onChange({ ...value, [k]: v })
  return (
    <fieldset className="grid gap-3 rounded-lg border border-amber-200 bg-amber-50/50 p-3 sm:grid-cols-2">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-amber-800">{emitido ? 'Cheque que emitimos' : 'Cheque que recibimos'}</legend>
      <Field label="Número" required>
        <input id="chq-numero" className={inputCls} value={value.numero} onChange={(e) => set('numero', e.target.value)} />
      </Field>
      <Field label="Banco del cheque">
        <input id="chq-banco" className={inputCls} value={value.banco} onChange={(e) => set('banco', e.target.value)} placeholder={emitido ? 'Galicia / Macro' : 'Nación, Santander…'} />
      </Field>
      <Field label="Fecha de emisión">
        <input id="chq-emision" className={inputCls} type="date" value={value.fecha_emision} onChange={(e) => set('fecha_emision', e.target.value)} />
      </Field>
      <Field label={emitido ? 'Fecha de pago (cuándo se debita)' : 'Fecha de pago (desde cuándo se cobra)'} required>
        <input id="chq-pago" className={inputCls} type="date" value={value.fecha_pago} onChange={(e) => set('fecha_pago', e.target.value)} />
      </Field>
      {!emitido && (
        <Field label="CUIT del librador" className="sm:col-span-2">
          <input id="chq-cuit" className={inputCls} value={value.cuit} onChange={(e) => set('cuit', e.target.value)} inputMode="numeric" />
        </Field>
      )}
      <p className="text-xs text-amber-900 sm:col-span-2">
        {emitido
          ? 'Queda como compromiso: se descuenta del banco recién cuando se debita.'
          : 'Queda en cartera: no suma al banco hasta que se acredita.'}
      </p>
    </fieldset>
  )
}

const chequeJSON = (c: DatosCheque) => ({ numero: c.numero.trim(), banco: c.banco.trim(), fecha_emision: c.fecha_emision, fecha_pago: c.fecha_pago, cuit: c.cuit.trim() })

// ---------------------------------------------------------------------
// Alta / edición de movimientos
// ---------------------------------------------------------------------
export function MovimientoForm({
  cuentas,
  categorias,
  inicial,
  preset,
  onSaved,
  onCancel,
}: {
  cuentas: Cuenta[]
  categorias: Categoria[]
  inicial?: Movimiento
  preset?: { tipo?: TipoMov; medio?: Medio; previsto?: boolean; cuenta_id?: string; fecha?: string }
  onSaved: (msg: string) => void
  onCancel: () => void
}) {
  const { esGerencia } = useAuth()
  const editando = !!inicial
  const [tipo, setTipo] = useState<TipoMov>(inicial?.tipo ?? preset?.tipo ?? 'egreso')
  const [previsto, setPrevisto] = useState(inicial ? inicial.estado !== 'realizado' : preset?.previsto ?? false)
  const [fecha, setFecha] = useState(inicial?.fecha ?? preset?.fecha ?? hoy())
  const [fechaMov, setFechaMov] = useState(inicial ? inicial.fecha_efectiva ?? inicial.fecha_prevista : preset?.fecha ?? hoy())
  const [categoria, setCategoria] = useState(inicial?.categoria_id ?? '')
  const [concepto, setConcepto] = useState(inicial?.concepto ?? '')
  const [contraparte, setContraparte] = useState(inicial?.contraparte ?? '')
  const [medio, setMedio] = useState<Medio>(inicial?.medio ?? preset?.medio ?? 'transferencia')
  const [cuenta, setCuenta] = useState(inicial?.cuenta_id ?? preset?.cuenta_id ?? cuentaPorMedio(cuentas, preset?.medio ?? 'transferencia', ''))
  const [destino, setDestino] = useState(cuentas.find((c) => c.activa && c.id !== cuenta)?.id ?? '')
  const [importe, setImporte] = useState(inicial ? String(inicial.importe).replace('.', ',') : '')
  const [comprobante, setComprobante] = useState(inicial?.comprobante ?? '')
  const [obs, setObs] = useState(inicial?.observaciones ?? '')
  const [cheque, setCheque] = useState<DatosCheque>(chequeVacio())
  const [repetir, setRepetir] = useState<'no' | 'semanal' | 'quincenal' | 'mensual'>('no')
  const [fechaAcred, setFechaAcred] = useState('')
  const [veces, setVeces] = useState(6)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const esCheque = medio === 'cheque' || medio === 'echeq'
  const destinoEf = destino && destino !== cuenta ? destino : cuentas.find((c) => c.activa && c.id !== cuenta)?.id ?? ''
  const cat = categorias.find((c) => c.id === categoria)
  const necesitaAut = tipo === 'egreso' && !previsto && !esGerencia && (cat?.requiere_autorizacion ?? true)
  const chequeEgresoBloqueado = !editando && tipo === 'egreso' && esCheque && !esGerencia
  const soloTexto = editando && (inicial!.estado === 'realizado' || inicial!.conciliado || !!inicial!.cheque_id || inicial!.tipo === 'transferencia')

  function cambiarTipo(t: TipoMov) {
    setTipo(t)
    setCategoria('')
    if (t === 'transferencia') {
      setPrevisto(false)
      if (medio === 'cheque' || medio === 'echeq') setMedio('transferencia')
    }
  }
  function cambiarMedio(m: Medio) {
    setMedio(m)
    setCuenta(cuentaPorMedio(cuentas, m, cuenta))
    if (m === 'cheque' || m === 'echeq') setPrevisto(true)
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const imp = parseMonto(importe)
    if (!(imp > 0)) return setError('Importe inválido.')
    if (!concepto.trim()) return setError('Escribí el concepto.')
    if (tipo !== 'transferencia' && !categoria) return setError('Elegí la categoría.')
    if (!cuenta) return setError('Elegí la cuenta.')
    if (necesitaAut) return setError('Este gasto necesita autorización de Gerencia: cargalo como "Previsto" y se paga cuando esté autorizado. O elegí una categoría de gasto menor.')
    if (chequeEgresoBloqueado) return setError('Los pagos con cheque se cargan como previstos y, cuando Gerencia los autoriza, se registra el cheque desde "Pagar".')
    if (esCheque && !editando && (!cheque.numero.trim() || !cheque.fecha_pago)) return setError('Cargá número y fecha de pago del cheque.')
    if (tipo === 'egreso' && !previsto && !comprobante.trim() && !editando) return setError('Cargá el comprobante (ticket, factura u orden de pago).')
    setBusy(true)
    const s = sb()
    try {
      if (editando) {
        const cambios: Record<string, unknown> = { concepto: concepto.trim(), contraparte: contraparte.trim() || null, comprobante: comprobante.trim() || null, observaciones: obs.trim() || null, fecha }
        if (tipo !== 'transferencia') cambios.categoria_id = categoria
        if (!soloTexto) Object.assign(cambios, { importe: imp, cuenta_id: cuenta, medio, fecha_prevista: fechaMov })
        const { error } = await s.from('tes_movimientos').update(cambios).eq('id', inicial!.id)
        if (error) throw error
        onSaved('Movimiento actualizado. El cambio queda registrado en la auditoría.')
      } else if (tipo === 'transferencia') {
        if (!destinoEf || destinoEf === cuenta) throw new Error('Elegí una cuenta de destino distinta.')
        const { error } = await s.rpc('tes_transferir', {
          p: {
            fecha,
            fecha_salida: fechaMov,
            fecha_acreditacion: fechaAcred && fechaAcred > fechaMov ? fechaAcred : fechaMov,
            origen: cuenta,
            destino: destinoEf,
            importe: imp,
            concepto: concepto.trim(),
            medio,
            comprobante: comprobante.trim() || null,
            observaciones: obs.trim() || null,
          },
        })
        if (error) throw error
        onSaved(
          fechaMov > hoy() || (fechaAcred && fechaAcred > hoy())
            ? 'Transferencia registrada. La parte con fecha futura queda pendiente hasta que confirmes que salió o se acreditó.'
            : 'Transferencia registrada. No cuenta como ingreso ni gasto.',
        )
      } else if (tipo === 'egreso' && previsto && !esCheque) {
        // Los pagos a futuro se cargan en Cuentas a pagar: los decide Gerencia y alimentan el flujo de fondos
        const fechas = repetir !== 'no' ? fechasRepetidas(fechaMov, repetir, veces) : [fechaMov]
        const plan = fechas.length > 1 ? crypto.randomUUID() : null
        const { error } = await s.from('pag_obligaciones').insert(
          fechas.map((f, i) => ({
            tipo: 'otro',
            proveedor: contraparte.trim() || concepto.trim(),
            categoria_id: categoria,
            concepto: concepto.trim(),
            comprobante: comprobante.trim() || null,
            vencimiento: f,
            importe: imp,
            cuenta_id: cuenta || null,
            medio_previsto: medio,
            observaciones: obs.trim() || null,
            plan_id: plan,
            cuota: plan ? i + 1 : null,
            cuotas: plan ? fechas.length : null,
            estado: 'pendiente_decision',
          })),
        )
        if (error) throw error
        onSaved(
          fechas.length > 1
            ? `Se cargaron ${fechas.length} pagos en Cuentas a pagar, pendientes de decisión.`
            : 'Pago cargado en Cuentas a pagar, pendiente de decisión de los dueños. Ya aparece en el flujo de fondos.',
        )
      } else {
        const fechas = previsto && repetir !== 'no' ? fechasRepetidas(fechaMov, repetir, veces) : [fechaMov]
        const serie = fechas.length > 1 ? crypto.randomUUID() : null
        const filas = fechas.map((f) => ({
          fecha,
          tipo,
          sentido: tipo === 'ingreso' ? 'entrada' : 'salida',
          categoria_id: categoria,
          concepto: concepto.trim(),
          contraparte: contraparte.trim() || null,
          medio: esCheque ? 'transferencia' : medio,
          cuenta_id: cuenta,
          importe: imp,
          fecha_prevista: f,
          fecha_efectiva: previsto ? null : f,
          estado: previsto ? 'pendiente' : 'realizado',
          comprobante: comprobante.trim() || null,
          observaciones: obs.trim() || null,
          serie_id: serie,
        }))
        const { data, error } = await s.from('tes_movimientos').insert(filas).select('id')
        if (error) throw error
        if (esCheque) {
          const id = (data as { id: string }[])[0].id
          const { error: e2 } = await s.rpc('tes_ejecutar', {
            p_mov: id,
            p: { cuenta_id: cuenta, medio, fecha: fecha, comprobante: comprobante.trim() || null, cheque: chequeJSON(cheque) },
          })
          if (e2) throw e2
        }
        onSaved(
          esCheque
            ? tipo === 'ingreso'
              ? 'Cheque registrado en cartera. Suma al banco cuando se acredite.'
              : 'Pago con cheque registrado: se descuenta del banco cuando se debite.'
            : fechas.length > 1
              ? `Se cargaron ${fechas.length} movimientos previstos (${repetir}).`
              : previsto
                ? tipo === 'egreso'
                  ? 'Pago previsto cargado. Queda pendiente de autorización de Gerencia.'
                  : 'Cobro previsto cargado.'
                : 'Movimiento registrado.',
        )
      }
    } catch (e) {
      setError(errMsg(e))
    }
    setBusy(false)
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {!editando && (
        <div className="inline-flex rounded-lg border border-slate-300 p-0.5">
          {(['ingreso', 'egreso', 'transferencia'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => cambiarTipo(t)}
              className={cx(
                'rounded-md px-3 py-1.5 text-sm font-medium',
                tipo === t ? (t === 'ingreso' ? 'bg-emerald-600 text-white' : t === 'egreso' ? 'bg-red-600 text-white' : 'bg-sky-600 text-white') : 'text-slate-600',
              )}
            >
              {t === 'ingreso' ? 'Ingreso' : t === 'egreso' ? 'Egreso' : 'Transferencia propia'}
            </button>
          ))}
        </div>
      )}
      {editando && (
        <div className="text-sm text-slate-600">
          {TIPO_MOV[inicial!.tipo]} · <Badge tone={ESTADO_MOV[inicial!.estado].tone}>{etiquetaMov(inicial!)}</Badge>
          {soloTexto && <span className="ml-2 text-xs text-slate-500">Solo se pueden corregir textos y categoría. Para cambiar importe o cuenta, anulalo y cargalo de nuevo.</span>}
        </div>
      )}

      {tipo !== 'transferencia' && !editando && (
        <div className="flex flex-wrap gap-2 text-sm">
          {[false, true].map((p) => (
            <label key={String(p)} className={cx('flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2', previsto === p ? 'border-brand-600 bg-brand-50' : 'border-slate-300')}>
              <input type="radio" name="previsto" className="accent-brand-700" checked={previsto === p} onChange={() => setPrevisto(p)} disabled={esCheque && !p} />
              {p ? (tipo === 'ingreso' ? 'Previsto (a cobrar)' : 'Previsto (a pagar)') : 'Ya se hizo'}
            </label>
          ))}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Concepto" required className="sm:col-span-2">
          <input id="mov-concepto" className={inputCls} value={concepto} onChange={(e) => setConcepto(e.target.value)} placeholder={tipo === 'transferencia' ? 'Depósito de efectivo, extracción…' : 'Ej: FC 0005-1234 rodamientos'} />
        </Field>
        {tipo !== 'transferencia' && (
          <>
            <Field label="Categoría" required>
              <CategoriaSelect id="mov-categoria" categorias={categorias} tipo={tipo} value={categoria} onChange={setCategoria} />
            </Field>
            <Field label={tipo === 'ingreso' ? 'Cliente / de quién' : 'Proveedor / a quién'}>
              <input id="mov-contraparte" className={inputCls} value={contraparte} onChange={(e) => setContraparte(e.target.value)} />
            </Field>
          </>
        )}
        <Field label="Medio" required>
          <select id="mov-medio" className={inputCls} value={medio} onChange={(e) => cambiarMedio(e.target.value as Medio)} disabled={soloTexto}>
            {MEDIOS_CARGA.filter((m) => tipo !== 'transferencia' || !['cheque', 'echeq', 'tarjeta'].includes(m)).map((m) => (
              <option key={m} value={m}>
                {MEDIOS[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Importe" required>
          <input id="mov-importe" className={inputCls} value={importe} onChange={(e) => setImporte(e.target.value)} inputMode="decimal" placeholder="0,00" disabled={soloTexto} />
        </Field>
        <Field label={tipo === 'transferencia' ? 'Sale de' : tipo === 'ingreso' ? (esCheque ? 'Se deposita en' : 'Entra en') : 'Sale de'} required>
          <CuentaSelect id="mov-cuenta" cuentas={cuentas} value={cuenta} onChange={setCuenta} />
        </Field>
        {tipo === 'transferencia' && (
          <Field label="Entra en" required>
            <CuentaSelect id="mov-destino" cuentas={cuentas} value={destinoEf} onChange={setDestino} excluir={cuenta} />
          </Field>
        )}
        <Field label="Fecha de la operación">
          <input id="mov-fecha" className={inputCls} type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
        </Field>
        {!esCheque && (
          <Field
            label={
              tipo === 'transferencia'
                ? 'Fecha de salida'
                : previsto
                  ? tipo === 'ingreso'
                    ? 'Fecha prevista de cobro'
                    : 'Fecha prevista de pago'
                  : 'Fecha efectiva (cuándo se movió la plata)'
            }
          >
            <input id="mov-fecha-mov" className={inputCls} type="date" value={fechaMov} onChange={(e) => setFechaMov(e.target.value)} disabled={soloTexto} />
          </Field>
        )}
        {tipo === 'transferencia' && !editando && (
          <Field label="Fecha de acreditación" hint="Si se acredita otro día (vacío = el mismo)">
            <input id="mov-fecha-acred" className={inputCls} type="date" value={fechaAcred} min={fechaMov} onChange={(e) => setFechaAcred(e.target.value)} />
          </Field>
        )}
        <Field label="Comprobante" required={tipo === 'egreso' && !previsto} hint={tipo === 'egreso' ? 'Factura, ticket u orden de pago' : undefined}>
          <input id="mov-comprobante" className={inputCls} value={comprobante} onChange={(e) => setComprobante(e.target.value)} />
        </Field>
        <Field label="Observaciones">
          <input id="mov-obs" className={inputCls} value={obs} onChange={(e) => setObs(e.target.value)} />
        </Field>
        {previsto && !esCheque && !editando && (
          <div className="grid grid-cols-2 gap-3 sm:col-span-2">
            <Field label="Se repite" hint="Sueldos, alquiler, servicios, cuotas…">
              <select id="mov-repetir" className={inputCls} value={repetir} onChange={(e) => setRepetir(e.target.value as typeof repetir)}>
                <option value="no">No</option>
                <option value="semanal">Cada semana</option>
                <option value="quincenal">Cada 2 semanas</option>
                <option value="mensual">Cada mes</option>
              </select>
            </Field>
            {repetir !== 'no' && (
              <Field label="Cantidad de veces">
                <input id="mov-veces" className={inputCls} type="number" min={2} max={36} value={veces} onChange={(e) => setVeces(Math.min(36, Math.max(2, Number(e.target.value) || 2)))} />
              </Field>
            )}
          </div>
        )}
      </div>

      {esCheque && !editando && !chequeEgresoBloqueado && <CamposCheque value={cheque} onChange={setCheque} emitido={tipo === 'egreso'} />}
      {chequeEgresoBloqueado && (
        <Alert tone="amber">Los pagos con cheque se cargan primero como previstos. Cuando Gerencia los autoriza, desde &quot;Pagar&quot; elegís cheque o e-cheq y se registra el número.</Alert>
      )}
      {tipo === 'egreso' && previsto && !editando && !esCheque && (
        <Alert tone="blue">Se carga en Cuentas a pagar como pendiente de decisión. Los dueños deciden; sin autorización no se paga (A08).</Alert>
      )}
      {necesitaAut && (
        <Alert tone="amber">
          &quot;{cat?.nombre ?? 'Esta categoría'}&quot; necesita autorización: cargalo como <b>Previsto</b> o elegí una categoría de gasto menor.
        </Alert>
      )}
      {tipo === 'transferencia' && <Alert tone="blue">Las dos cuentas quedan vinculadas: no cuenta como ingreso ni como gasto de la empresa.</Alert>}
      {error && <Alert tone="red">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? 'Guardando…' : editando ? 'Guardar cambios' : 'Registrar'}
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------
// Pagar / cobrar un movimiento previsto
// ---------------------------------------------------------------------
export function EjecutarForm({ mov, cuentas, onDone, onCancel }: { mov: Movimiento; cuentas: Cuenta[]; onDone: (msg: string) => void; onCancel: () => void }) {
  const egreso = mov.tipo === 'egreso'
  const [medio, setMedio] = useState<Medio>(mov.medio === 'cheque' || mov.medio === 'echeq' ? 'transferencia' : mov.medio)
  const [cuenta, setCuenta] = useState(mov.cuenta_id ?? cuentaPorMedio(cuentas, mov.medio, ''))
  const [fecha, setFecha] = useState(hoy())
  const [comprobante, setComprobante] = useState('')
  const [cheque, setCheque] = useState<DatosCheque>({ ...chequeVacio(), fecha_pago: mov.fecha_prevista > hoy() ? mov.fecha_prevista : hoy() })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const esCheque = medio === 'cheque' || medio === 'echeq'

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    const { error } = await sb().rpc('tes_ejecutar', {
      p_mov: mov.id,
      p: { cuenta_id: cuenta, medio, fecha, comprobante: comprobante.trim() || null, cheque: esCheque ? chequeJSON(cheque) : null },
    })
    setBusy(false)
    if (error) return setError(errMsg(error))
    onDone(
      esCheque
        ? egreso
          ? 'Cheque emitido. El pago queda como compromiso hasta que se debite.'
          : 'Cheque en cartera. Suma al banco cuando se acredite.'
        : egreso
          ? 'Pago registrado.'
          : 'Cobro registrado.',
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="rounded-lg bg-slate-50 p-3 text-sm">
        <div className="font-medium">{mov.concepto}</div>
        <div className="text-slate-500">
          {mov.contraparte ? `${mov.contraparte} · ` : ''}previsto {fmtFecha(mov.fecha_prevista)}
        </div>
        <div className={cx('mt-1 text-lg font-semibold tabular-nums', egreso ? 'text-red-700' : 'text-emerald-700')}>{fmtMoney(mov.importe)}</div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Medio">
          <select
            id="ej-medio"
            className={inputCls}
            value={medio}
            onChange={(e) => {
              const m = e.target.value as Medio
              setMedio(m)
              setCuenta(cuentaPorMedio(cuentas, m, cuenta))
            }}
          >
            {MEDIOS_CARGA.map((m) => (
              <option key={m} value={m}>
                {MEDIOS[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={egreso ? (esCheque ? 'Cuenta de débito' : 'Sale de') : esCheque ? 'Se deposita en' : 'Entra en'}>
          <CuentaSelect id="ej-cuenta" cuentas={cuentas} value={cuenta} onChange={setCuenta} />
        </Field>
        {!esCheque && (
          <Field label={egreso ? 'Fecha de pago' : 'Fecha de cobro'}>
            <input id="ej-fecha" className={inputCls} type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
          </Field>
        )}
        <Field label={egreso ? 'Orden de pago / comprobante' : 'Recibo / comprobante'} required={egreso && !esCheque} className={esCheque ? 'sm:col-span-2' : ''}>
          <input id="ej-comprobante" className={inputCls} value={comprobante} onChange={(e) => setComprobante(e.target.value)} placeholder="OP 0151, TRF 9921…" />
        </Field>
      </div>
      {esCheque && <CamposCheque value={cheque} onChange={setCheque} emitido={egreso} />}
      {error && <Alert tone="red">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" variant={egreso ? 'danger' : 'success'} disabled={busy}>
          {busy ? 'Guardando…' : egreso ? 'Confirmar pago' : 'Confirmar cobro'}
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------
// Acciones sobre un cheque
// ---------------------------------------------------------------------
export type AccionCheque = 'depositar' | 'acreditar' | 'debitar' | 'endosar' | 'rechazar' | 'anular'

export const ACCIONES_CHEQUE: Record<AccionCheque, { label: string; hecho: string; tone: 'primary' | 'secondary' | 'danger' | 'success' }> = {
  depositar: { label: 'Depositar', hecho: 'depositado', tone: 'secondary' },
  acreditar: { label: 'Acreditar', hecho: 'acreditado en el banco', tone: 'success' },
  debitar: { label: 'Debitar', hecho: 'debitado del banco', tone: 'success' },
  endosar: { label: 'Endosar', hecho: 'endosado', tone: 'secondary' },
  rechazar: { label: 'Rechazar', hecho: 'rechazado', tone: 'danger' },
  anular: { label: 'Anular', hecho: 'anulado', tone: 'secondary' },
}

export function accionesPosibles(c: Cheque): AccionCheque[] {
  if (c.sentido === 'recibido') {
    if (c.estado === 'en_cartera') return ['depositar', 'acreditar', 'endosar', 'rechazar', 'anular']
    if (c.estado === 'depositado') return ['acreditar', 'rechazar']
    if (c.estado === 'acreditado') return ['rechazar']
    return []
  }
  if (c.estado === 'emitido') return ['debitar', 'rechazar', 'anular']
  return []
}

export function ChequeAccionForm({
  cheque,
  accion,
  cuentas,
  categorias,
  pagosAutorizados,
  onDone,
  onCancel,
}: {
  cheque: Cheque
  accion: AccionCheque
  cuentas: Cuenta[]
  categorias: Categoria[]
  pagosAutorizados: Movimiento[]
  onDone: (msg: string) => void
  onCancel: () => void
}) {
  const bancos = cuentas.filter((c) => c.tipo === 'banco')
  const [fecha, setFecha] = useState(accion === 'acreditar' || accion === 'debitar' ? (cheque.fecha_pago > hoy() ? hoy() : cheque.fecha_pago) : hoy())
  const [cuenta, setCuenta] = useState(cheque.cuenta_id ?? bancos[0]?.id ?? '')
  const [motivo, setMotivo] = useState('')
  const [destinatario, setDestinatario] = useState('')
  const [movPago, setMovPago] = useState('')
  const [categoria, setCategoria] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const textos: Record<AccionCheque, string> = {
    depositar: 'Lo llevás al banco. Sigue sin sumar al saldo hasta que se acredite.',
    acreditar: 'El banco ya lo acreditó: pasa a ser plata disponible en la cuenta.',
    debitar: 'El banco ya lo debitó: se descuenta del saldo de la cuenta.',
    endosar: 'Lo entregás a un proveedor. No pasa por ninguna cuenta: queda registrado el cobro y el pago.',
    rechazar:
      cheque.sentido === 'recibido'
        ? 'El cobro se anula y la factura del cliente vuelve a quedar con deuda. Si ya estaba acreditado, se registra el débito del rechazo.'
        : 'La deuda con el proveedor vuelve a quedar pendiente de pago.',
    anular: cheque.sentido === 'recibido' ? 'Se anula el cobro previsto y la factura vuelve a quedar con deuda.' : 'El pago vuelve a quedar autorizado sin cheque.',
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    const { error } = await sb().rpc('tes_cheque_accion', {
      p_cheque: cheque.id,
      p_accion: accion,
      p: { fecha, cuenta_id: cuenta || null, motivo: motivo.trim() || null, destinatario: destinatario.trim() || null, mov_pago: movPago || null, categoria_id: categoria || null },
    })
    setBusy(false)
    if (error) return setError(errMsg(error))
    onDone(`Cheque N° ${cheque.numero}: ${ACCIONES_CHEQUE[accion].hecho}.`)
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="rounded-lg bg-slate-50 p-3 text-sm">
        <div className="font-medium">
          {cheque.formato === 'echeq' ? 'E-cheq' : 'Cheque'} N° {cheque.numero} {cheque.banco ? `· ${cheque.banco}` : ''}
        </div>
        <div className="text-slate-500">
          {cheque.contraparte} · fecha de pago {fmtFecha(cheque.fecha_pago)}
        </div>
        <div className="mt-1 text-lg font-semibold tabular-nums">{fmtMoney(cheque.importe)}</div>
      </div>
      <p className="text-sm text-slate-600">{textos[accion]}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={accion === 'acreditar' ? 'Fecha de acreditación' : accion === 'debitar' ? 'Fecha de débito' : 'Fecha'}>
          <input id="cha-fecha" className={inputCls} type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
        </Field>
        {(accion === 'depositar' || accion === 'acreditar') && (
          <Field label="Cuenta">
            <CuentaSelect id="cha-cuenta" cuentas={bancos} value={cuenta} onChange={setCuenta} />
          </Field>
        )}
        {(accion === 'rechazar' || accion === 'anular') && (
          <Field label="Motivo" required className="sm:col-span-2">
            <input id="cha-motivo" className={inputCls} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder={accion === 'rechazar' ? 'Sin fondos, firma no conforme…' : ''} />
          </Field>
        )}
        {accion === 'endosar' && (
          <>
            <Field label="Se endosa a" required className="sm:col-span-2">
              <input id="cha-dest" className={inputCls} value={destinatario} onChange={(e) => setDestinatario(e.target.value)} placeholder="Proveedor" />
            </Field>
            <Field label="¿Paga un pago ya autorizado?" className="sm:col-span-2">
              <select id="cha-movpago" className={inputCls} value={movPago} onChange={(e) => setMovPago(e.target.value)}>
                <option value="">No, es un pago nuevo</option>
                {pagosAutorizados
                  .filter((m) => !m.cheque_id)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.concepto} · {m.contraparte ?? ''} · {fmtMoney(m.importe)}
                    </option>
                  ))}
              </select>
            </Field>
            {!movPago && (
              <Field label="Categoría del pago" required className="sm:col-span-2">
                <CategoriaSelect id="cha-cat" categorias={categorias} tipo="egreso" value={categoria} onChange={setCategoria} />
              </Field>
            )}
          </>
        )}
      </div>
      {error && <Alert tone="red">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" variant={ACCIONES_CHEQUE[accion].tone} disabled={busy}>
          {busy ? 'Guardando…' : 'Confirmar'}
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------
// Corregir un cheque emitido (RPC tes_cheque_editar, migración 10)
// ---------------------------------------------------------------------
/** Se pueden corregir los emitidos. Importe, fecha de pago y cuenta solo mientras no se debitó / rechazó / anuló. */
export const chequeEditable = (c: Cheque) => c.sentido === 'emitido'

export function ChequeEditarForm({ cheque, cuentas, onDone, onCancel }: { cheque: Cheque; cuentas: Cuenta[]; onDone: (msg: string) => void; onCancel: () => void }) {
  const { esGerencia } = useAuth()
  const completo = cheque.estado === 'emitido'
  const fmt2 = (n: number) => Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const [formato, setFormato] = useState<Cheque['formato']>(cheque.formato)
  const [datos, setDatos] = useState<DatosCheque>({
    numero: cheque.numero ?? '',
    banco: cheque.banco ?? '',
    fecha_emision: cheque.fecha_emision ?? '',
    fecha_pago: cheque.fecha_pago ?? '',
    cuit: cheque.cuit ?? '',
  })
  const [contraparte, setContraparte] = useState(cheque.contraparte ?? '')
  const [importe, setImporte] = useState(fmt2(cheque.importe))
  const [cuenta, setCuenta] = useState(cheque.cuenta_id ?? '')
  const [obs, setObs] = useState(cheque.observaciones ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof DatosCheque, v: string) => setDatos((d) => ({ ...d, [k]: v }))
  const bancos = cuentas.filter((c) => c.tipo === 'banco' && (c.activa || c.id === cheque.cuenta_id))
  const puedeImporte = completo && esGerencia

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const imp = parseMonto(importe)
    // Mismas validaciones que el alta (tes_cheque_emitir)
    if (!datos.numero.trim() || !datos.fecha_pago) return setError('Cargá número y fecha de pago del cheque.')
    if (!contraparte.trim()) return setError('Indicá a quién se le emitió el cheque.')
    if (completo && !(imp > 0)) return setError('Importe inválido.')
    if (completo && !cuenta) return setError('Elegí la cuenta de débito.')
    const p: Record<string, unknown> = {
      formato,
      numero: datos.numero.trim(),
      banco: datos.banco.trim(),
      contraparte: contraparte.trim(),
      cuit: datos.cuit.trim(),
      fecha_emision: datos.fecha_emision || '',
      observaciones: obs.trim(),
    }
    if (completo) Object.assign(p, { fecha_pago: datos.fecha_pago, cuenta_id: cuenta, importe: puedeImporte ? imp : Number(cheque.importe) })
    setBusy(true)
    const { error } = await sb().rpc('tes_cheque_editar', { p_cheque: cheque.id, p })
    setBusy(false)
    if (error) return setError(errMsg(error))
    onDone(`Cheque N° ${datos.numero.trim()} actualizado. El pago vinculado se corrigió y el cambio queda en la auditoría.`)
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {!completo && (
        <Alert tone="amber">
          El cheque ya está <b>{ESTADO_CHEQUE[cheque.estado].label.toLowerCase()}</b>: podés corregir número, banco, proveedor, CUIT, fecha de emisión y observaciones. El importe, la fecha de pago y la cuenta ya no se tocan.
        </Alert>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Formato" required>
          <select id="che-formato" className={inputCls} value={formato} onChange={(e) => setFormato(e.target.value as Cheque['formato'])}>
            <option value="echeq">E-cheq</option>
            <option value="fisico">Físico</option>
          </select>
        </Field>
        <Field label="Número" required>
          <input id="che-numero" className={inputCls} value={datos.numero} onChange={(e) => set('numero', e.target.value)} />
        </Field>
        <Field label="Banco del cheque">
          <input id="che-banco" className={inputCls} value={datos.banco} onChange={(e) => set('banco', e.target.value)} placeholder="Galicia / Macro" />
        </Field>
        <Field label="Cuenta de débito" required={completo}>
          {completo ? (
            <CuentaSelect id="che-cuenta" cuentas={bancos} value={cuenta} onChange={setCuenta} vacio="— Elegir —" />
          ) : (
            <input className={inputCls} value={cuentas.find((c) => c.id === cheque.cuenta_id)?.nombre ?? '—'} disabled />
          )}
        </Field>
        <Field label="Proveedor (a quién se emitió)" required>
          <input id="che-contraparte" className={inputCls} value={contraparte} onChange={(e) => setContraparte(e.target.value)} />
        </Field>
        <Field label="CUIT del proveedor">
          <input id="che-cuit" className={inputCls} value={datos.cuit} onChange={(e) => set('cuit', e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Fecha de emisión">
          <input id="che-emision" className={inputCls} type="date" value={datos.fecha_emision} onChange={(e) => set('fecha_emision', e.target.value)} />
        </Field>
        <Field label="Fecha de pago (cuándo se debita)" required={completo}>
          <input id="che-pago" className={inputCls} type="date" value={datos.fecha_pago} onChange={(e) => set('fecha_pago', e.target.value)} disabled={!completo} />
        </Field>
        <Field label="Importe" required={completo} hint={completo && !esGerencia ? 'Cambiar el importe requiere Gerencia (A08).' : undefined}>
          <input id="che-importe" className={inputCls} value={importe} onChange={(e) => setImporte(e.target.value)} inputMode="decimal" disabled={!puedeImporte} />
        </Field>
        <Field label="Observaciones">
          <input id="che-obs" className={inputCls} value={obs} onChange={(e) => setObs(e.target.value)} />
        </Field>
      </div>
      {error && <Alert tone="red">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? 'Guardando…' : 'Guardar cambios'}
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------
// Lista de movimientos con acciones
// ---------------------------------------------------------------------
export type AccionMov = 'autorizar' | 'ejecutar' | 'editar' | 'anular' | 'confirmar'

export function MovFila({
  m,
  cuentas,
  categorias,
  onAccion,
  compacto,
}: {
  m: Movimiento
  cuentas: Map<string, Cuenta>
  categorias: Map<string, Categoria>
  onAccion?: (a: AccionMov, m: Movimiento) => void
  compacto?: boolean
}) {
  const { esGerencia } = useAuth()
  const cat = m.categoria_id ? categorias.get(m.categoria_id) : null
  const v = firmado(m)
  const transf = m.tipo === 'transferencia'
  const fechaMostrar = m.estado === 'realizado' ? m.fecha_efectiva : m.fecha_prevista
  return (
    <tr className={cx(m.estado === 'anulado' && 'opacity-50')}>
      <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2 align-top text-sm">
        {fmtFecha(fechaMostrar)}
        {m.fecha !== fechaMostrar && <div className="text-[11px] text-slate-400">oper. {fmtFecha(m.fecha).slice(0, 5)}</div>}
      </td>
      <td className="border-b border-slate-100 px-3 py-2 align-top">
        <div className="text-sm font-medium text-slate-900">{m.concepto}</div>
        <div className="text-xs text-slate-500">
          {[transf ? 'Transferencia propia' : cat ? `${cat.rubro} › ${cat.nombre}` : null, m.contraparte, m.comprobante].filter(Boolean).join(' · ')}
        </div>
        {m.motivo_anulacion && <div className="text-xs text-slate-500">Anulado: {m.motivo_anulacion}</div>}
      </td>
      {!compacto && (
        <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2 align-top text-xs text-slate-600">
          {m.cuenta_id ? cuentas.get(m.cuenta_id)?.nombre : '—'}
          <div className="text-slate-400">{MEDIOS[m.medio]}</div>
        </td>
      )}
      <td className={cx('whitespace-nowrap border-b border-slate-100 px-3 py-2 text-right align-top text-sm font-semibold tabular-nums', transf ? 'text-sky-700' : v > 0 ? 'text-emerald-700' : 'text-red-700')}>
        {v > 0 ? '+' : '−'} {fmtMoney(Math.abs(v))}
      </td>
      <td className="border-b border-slate-100 px-3 py-2 align-top">
        <div className="flex flex-wrap items-center gap-1">
          <Badge tone={ESTADO_MOV[m.estado].tone}>{etiquetaMov(m)}</Badge>
          {m.conciliado && <Badge tone="brand">Conciliado</Badge>}
        </div>
        {!compacto && <div className="mt-0.5 text-[11px] text-slate-400">{m.autor?.nombre ?? ''}</div>}
      </td>
      {onAccion && (
        <td className="whitespace-nowrap border-b border-slate-100 px-2 py-2 text-right align-top">
          <div className="flex flex-wrap justify-end gap-1">
            {m.tipo === 'egreso' && m.estado === 'pendiente' && esGerencia && (
              <Button size="sm" variant="success" onClick={() => onAccion('autorizar', m)}>
                Autorizar
              </Button>
            )}
            {((m.tipo === 'egreso' && m.estado === 'autorizado' && !m.cheque_id) || (m.tipo === 'ingreso' && m.estado === 'pendiente' && !m.cheque_id)) && (
              <Button size="sm" onClick={() => onAccion('ejecutar', m)}>
                {m.tipo === 'egreso' ? 'Pagar' : 'Cobrar'}
              </Button>
            )}
            {m.tipo === 'transferencia' && m.estado === 'pendiente' && (
              <Button size="sm" onClick={() => onAccion('confirmar', m)}>
                {m.sentido === 'entrada' ? 'Se acreditó' : 'Salió'}
              </Button>
            )}
            {m.estado !== 'anulado' && (
              <Button size="sm" variant="ghost" onClick={() => onAccion('editar', m)}>
                Editar
              </Button>
            )}
            {m.estado !== 'anulado' && !m.conciliado && !m.cheque_id && (
              <Button size="sm" variant="ghost" onClick={() => onAccion('anular', m)}>
                Anular
              </Button>
            )}
          </div>
        </td>
      )}
    </tr>
  )
}

export function MovTabla({
  movs,
  cuentas,
  categorias,
  onAccion,
  vacio,
  compacto,
}: {
  movs: Movimiento[]
  cuentas: Cuenta[]
  categorias: Categoria[]
  onAccion?: (a: AccionMov, m: Movimiento) => void
  vacio?: ReactNode
  compacto?: boolean
}) {
  const mc = new Map(cuentas.map((c) => [c.id, c]))
  const mk = new Map(categorias.map((c) => [c.id, c]))
  if (!movs.length) return <div className="px-4 py-8 text-center text-sm text-slate-500">{vacio ?? 'Sin movimientos.'}</div>
  const th = 'border-b border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-500 whitespace-nowrap'
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead>
          <tr>
            <th className={th}>Fecha</th>
            <th className={th}>Concepto</th>
            {!compacto && <th className={th}>Cuenta</th>}
            <th className={`${th} text-right`}>Importe</th>
            <th className={th}>Estado</th>
            {onAccion && <th className={th}></th>}
          </tr>
        </thead>
        <tbody>
          {movs.map((m) => (
            <MovFila key={m.id} m={m} cuentas={mc} categorias={mk} onAccion={onAccion} compacto={compacto} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Maneja autorizar / anular (los formularios de editar y ejecutar los abre la página). */
export async function accionRapida(a: 'autorizar' | 'anular' | 'confirmar', m: Movimiento): Promise<string | null> {
  if (a === 'confirmar') {
    const f = window.prompt(m.sentido === 'entrada' ? '¿Qué día se acreditó? (AAAA-MM-DD)' : '¿Qué día salió? (AAAA-MM-DD)', hoy())
    if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(f)) return null
    const { error } = await sb().rpc('tes_confirmar_transferencia', { p_mov: m.id, p_fecha: f })
    if (error) throw error
    return m.sentido === 'entrada' ? 'Acreditación confirmada: ya suma en la cuenta.' : 'Salida confirmada.'
  }
  if (a === 'autorizar') {
    const { error } = await sb().from('tes_movimientos').update({ estado: 'autorizado' }).eq('id', m.id)
    if (error) throw error
    return `Autorizado: ${m.concepto} por ${fmtMoney(m.importe)}.`
  }
  const motivo = window.prompt(
    m.cobro_id ? `Anular el cobro "${m.concepto}": la factura vuelve a quedar con deuda. Motivo:` : `Motivo de la anulación de "${m.concepto}":`,
  )
  if (!motivo?.trim()) return null
  const { error } = await sb().from('tes_movimientos').update({ estado: 'anulado', motivo_anulacion: motivo.trim() }).eq('id', m.id)
  if (error) throw error
  if (m.cobro_id) {
    const { error: e2 } = await sb().rpc('tes_revertir_cobro', { p_cobro: m.cobro_id })
    if (e2) throw e2
    return 'Cobro anulado: la factura vuelve a quedar con deuda.'
  }
  return m.transferencia_id ? 'Transferencia anulada (las dos cuentas).' : 'Movimiento anulado. Queda en el historial.'
}

// ---------------------------------------------------------------------
// Exportación a Excel
// ---------------------------------------------------------------------
export function filasMovimientos(movs: Movimiento[], cuentas: Cuenta[], categorias: Categoria[]): Celda[][] {
  const mc = new Map(cuentas.map((c) => [c.id, c.nombre]))
  const mk = new Map(categorias.map((c) => [c.id, c]))
  return [
    ['Fecha operación', 'Fecha prevista', 'Fecha efectiva', 'Tipo', 'Rubro', 'Categoría', 'Concepto', 'Cliente / proveedor', 'Medio', 'Cuenta', 'Ingreso', 'Egreso', 'Estado', 'Conciliado', 'Comprobante', 'Observaciones', 'Responsable'],
    ...movs.map((m) => {
      const c = m.categoria_id ? mk.get(m.categoria_id) : null
      const v = firmado(m)
      return [
        fmtFecha(m.fecha),
        fmtFecha(m.fecha_prevista),
        m.fecha_efectiva ? fmtFecha(m.fecha_efectiva) : '',
        TIPO_MOV[m.tipo] + (m.tipo === 'transferencia' ? (m.sentido === 'entrada' ? ' (entra)' : ' (sale)') : ''),
        c?.rubro ?? '',
        c?.nombre ?? '',
        m.concepto,
        m.contraparte ?? '',
        MEDIOS[m.medio],
        m.cuenta_id ? mc.get(m.cuenta_id) ?? '' : 'No pasa por cuenta',
        v > 0 ? v : '',
        v < 0 ? -v : '',
        etiquetaMov(m),
        m.conciliado ? 'Sí' : '',
        m.comprobante ?? '',
        [m.observaciones, m.motivo_anulacion ? `Anulado: ${m.motivo_anulacion}` : ''].filter(Boolean).join(' · '),
        m.autor?.nombre ?? '',
      ]
    }),
  ]
}

export function filasCheques(cheques: Cheque[], cuentas: Cuenta[]): Celda[][] {
  const mc = new Map(cuentas.map((c) => [c.id, c.nombre]))
  return [
    ['Recibido / emitido', 'Formato', 'Número', 'Banco', 'Cliente / proveedor', 'CUIT', 'Importe', 'Emisión', 'Fecha de pago', 'Depósito', 'Acreditación / débito', 'Cuenta', 'Estado', 'Endosado a', 'Motivo'],
    ...cheques.map((c) => [
      c.sentido === 'recibido' ? 'Recibido' : 'Emitido',
      c.formato === 'echeq' ? 'E-cheq' : 'Físico',
      c.numero,
      c.banco ?? '',
      c.contraparte,
      c.cuit ?? '',
      Number(c.importe),
      c.fecha_emision ? fmtFecha(c.fecha_emision) : '',
      fmtFecha(c.fecha_pago),
      c.fecha_deposito ? fmtFecha(c.fecha_deposito) : '',
      c.fecha_efectiva ? fmtFecha(c.fecha_efectiva) : '',
      c.cuenta_id ? mc.get(c.cuenta_id) ?? '' : '',
      ESTADO_CHEQUE[c.estado].label,
      c.endosado_a ?? '',
      c.motivo ?? '',
    ]),
  ]
}

export function exportarExcel(nombre: string, hojas: { nombre: string; filas: Celda[][]; anchos?: number[] }[]) {
  descargar(generarXLSX(hojas), `${nombre}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
}

export const ANCHOS_MOV = [12, 12, 12, 18, 18, 24, 36, 24, 16, 18, 14, 14, 22, 10, 18, 30, 14]
export const ANCHOS_CHQ = [12, 9, 14, 14, 26, 14, 14, 11, 12, 11, 14, 16, 22, 20, 24]

export const primerDiaMes = (f = hoy()) => `${f.slice(0, 7)}-01`
export const enDias = (n: number) => sumarDias(hoy(), n)
