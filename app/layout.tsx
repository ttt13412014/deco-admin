import type { Metadata } from 'next'
import './globals.css'
import { AuthProvider } from '@/components/AuthProvider'
import { AppFrame } from '@/components/AppFrame'

export const metadata: Metadata = {
  title: 'DE&CO · Administración',
  description: 'Panel administrativo DE&CO — clientes, cobranzas y caja diaria',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-AR">
      <body>
        <AuthProvider>
          <AppFrame>{children}</AppFrame>
        </AuthProvider>
      </body>
    </html>
  )
}
