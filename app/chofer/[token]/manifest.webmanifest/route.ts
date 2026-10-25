// Manifest para "Agregar a la pantalla de inicio": abre directo la hoja de este link.
export const dynamic = 'force-dynamic'

export function GET(_req: Request, { params }: { params: { token: string } }) {
  if (!/^[a-f0-9]{32,128}$/.test(params.token)) return new Response('Not found', { status: 404 })
  const url = `/chofer/${params.token}`
  return new Response(
    JSON.stringify({
      name: 'Reparto DE&CO',
      short_name: 'Reparto',
      start_url: url,
      scope: url,
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#245153',
      lang: 'es-AR',
      icons: [
        { src: '/chofer-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/chofer-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      ],
    }),
    { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } },
  )
}
