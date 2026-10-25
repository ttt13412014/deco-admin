'use client'

import { FormEvent, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { sb, errMsg } from '@/lib/supabase'
import { useAuth } from '@/components/AuthProvider'
import { Alert, Button, Field, cx, inputCls } from '@/components/ui'

export default function LoginPage() {
  const { session } = useAuth()
  const router = useRouter()
  const [modo, setModo] = useState<'ingresar' | 'registrar'>('ingresar')
  const [nombre, setNombre] = useState('')
  const [email, setEmail] = useState('')
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [msg, setMsg] = useState<{ tone: 'red' | 'green' | 'blue'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (session) router.replace('/')
  }, [session, router])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    if (modo === 'registrar') {
      if (!nombre.trim()) return setMsg({ tone: 'red', text: 'Escribí tu nombre.' })
      if (pass.length < 6) return setMsg({ tone: 'red', text: 'La contraseña tiene que tener al menos 6 caracteres.' })
      if (pass !== pass2) return setMsg({ tone: 'red', text: 'Las contraseñas no coinciden.' })
      setBusy(true)
      const { data, error } = await sb().auth.signUp({
        email: email.trim(),
        password: pass,
        options: { data: { nombre: nombre.trim() }, emailRedirectTo: typeof window !== 'undefined' ? window.location.origin : undefined },
      })
      setBusy(false)
      if (error) return setMsg({ tone: 'red', text: traducir(errMsg(error)) })
      if (!data.session) {
        setMsg({ tone: 'blue', text: `Te mandamos un mail a ${email.trim()} para confirmar la cuenta. Abrilo, tocá el link y después ingresá.` })
        setModo('ingresar')
      }
      return
    }
    setBusy(true)
    const { error } = await sb().auth.signInWithPassword({ email: email.trim(), password: pass })
    setBusy(false)
    if (error) setMsg({ tone: 'red', text: traducir(errMsg(error)) })
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-950 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-3xl font-bold tracking-tight text-white">DE&amp;CO</div>
          <div className="mt-1 text-xs uppercase tracking-[0.25em] text-brand-400">Administración</div>
        </div>
        <form onSubmit={onSubmit} className="space-y-4 rounded-xl bg-white p-6 shadow-xl">
          <div className="grid grid-cols-2 rounded-lg bg-slate-100 p-1 text-sm font-medium">
            {(['ingresar', 'registrar'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setModo(m)
                  setMsg(null)
                }}
                className={cx('rounded-md py-1.5', modo === m ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500')}
              >
                {m === 'ingresar' ? 'Ingresar' : 'Crear cuenta'}
              </button>
            ))}
          </div>
          {modo === 'registrar' && (
            <Field label="Nombre">
              <input id="reg-nombre" className={inputCls} value={nombre} onChange={(e) => setNombre(e.target.value)} autoComplete="name" required />
            </Field>
          )}
          <Field label="Email">
            <input id="login-email" className={inputCls} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <Field label="Contraseña" hint={modo === 'registrar' ? 'Mínimo 6 caracteres' : undefined}>
            <input
              id="login-pass"
              className={inputCls}
              type="password"
              autoComplete={modo === 'registrar' ? 'new-password' : 'current-password'}
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              required
            />
          </Field>
          {modo === 'registrar' && (
            <Field label="Repetí la contraseña">
              <input id="reg-pass2" className={inputCls} type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} required />
            </Field>
          )}
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Un momento…' : modo === 'ingresar' ? 'Ingresar' : 'Crear cuenta'}
          </Button>
          {modo === 'registrar' && (
            <p className="text-center text-xs text-slate-500">La primera cuenta queda como Gerencia. Las siguientes esperan que Gerencia les dé acceso.</p>
          )}
        </form>
        <p className="mt-6 text-center text-xs italic text-brand-300">Orden administrativo hoy = empresa protegida mañana.</p>
      </div>
    </div>
  )
}

function traducir(m: string): string {
  if (/already registered|already been registered/i.test(m)) return 'Ya existe una cuenta con ese email. Ingresá con tu contraseña.'
  if (/Email not confirmed/i.test(m)) return 'Todavía no confirmaste el email. Revisá tu correo (y la carpeta de spam).'
  if (/Signups not allowed|signup.*disabled/i.test(m)) return 'El registro está desactivado. Pedile a Gerencia que te cree el usuario.'
  if (/Password should be/i.test(m)) return 'La contraseña es muy corta (mínimo 6 caracteres).'
  if (/rate limit/i.test(m)) return 'Demasiados intentos. Esperá unos minutos y probá de nuevo.'
  return m
}
