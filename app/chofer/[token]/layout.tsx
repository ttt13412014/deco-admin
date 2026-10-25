import type { Metadata, Viewport } from 'next'

const tokenOk = (t: string) => /^[a-f0-9]{32,128}$/.test(t)

export function generateMetadata({ params }: { params: { token: string } }): Metadata {
  return {
    title: 'Reparto · DE&CO',
    description: 'Hoja de ruta del chofer: marcá entregas y cobros.',
    manifest: tokenOk(params.token) ? `/chofer/${params.token}/manifest.webmanifest` : undefined,
    robots: { index: false, follow: false },
    // Que el link secreto no viaje a Google Maps ni a WhatsApp al tocar un enlace
    referrer: 'no-referrer',
    appleWebApp: { capable: true, title: 'Reparto DE&CO', statusBarStyle: 'default' },
    icons: { icon: '/chofer-icon-192.png', apple: '/chofer-icon-192.png' },
  }
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#245153',
}

export default function ChoferLayout({ children }: { children: React.ReactNode }) {
  return children
}
