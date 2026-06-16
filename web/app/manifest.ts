import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Agentkeep',
    short_name: 'Agentkeep',
    description: 'Your vault, kept by your own agent.',
    start_url: '/',
    display: 'standalone',
    background_color: '#F4EDDF',
    theme_color: '#3B6B53',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
