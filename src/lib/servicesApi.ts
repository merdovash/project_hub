export interface PublicService {
  id: string
  name: string
  description: string
  subdomain: string
  url: string
}

export async function fetchServices(): Promise<{ domain: string; services: PublicService[] }> {
  const response = await fetch('/api/services', { credentials: 'include' })
  if (!response.ok) {
    throw new Error('Не удалось загрузить список сервисов')
  }
  return (await response.json()) as { domain: string; services: PublicService[] }
}
