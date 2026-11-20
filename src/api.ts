export type PortalConfig = {
  organizerName: string
  organizerEmail: string
  retentionDays: number
  siteKey: string
}

export type Receipt = {
  reference: string
  name: string
  submittedAt: string
  status: 'pending' | 'complete'
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public errors: Record<string, string> = {}) {
    super(message)
  }
}

export function createRegistrationKey() {
  const crypto = globalThis.crypto
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID()
  if (!crypto?.getRandomValues) {
    throw new ApiError('Open the portal at localhost or over HTTPS in a current browser to submit.', 0)
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export async function getConfig(signal?: AbortSignal): Promise<PortalConfig> {
  const response = await fetch('/api/config', { signal })
  if (!response.ok) throw new Error('Registration settings could not be loaded.')
  return response.json()
}

export async function getReceipt(key: string, signal?: AbortSignal): Promise<Receipt | null> {
  let response: Response
  try {
    response = await fetch('/api/registration', {
      headers: { 'Idempotency-Key': key }, signal, cache: 'no-store',
    })
  } catch {
    throw new ApiError('Could not reach the registration server to check your previous submission. Check the connection and try again.', 0)
  }

  if (response.status === 404) return null
  if (!response.ok) throw new ApiError('The registration status is temporarily unavailable.', response.status)

  const receipt = await response.json().catch(() => null)
  if (!receipt?.reference || typeof receipt.submittedAt !== 'string' ||
      (receipt.status !== 'pending' && receipt.status !== 'complete')) {
    throw new ApiError('The registration server returned an unexpected response. Try again in a moment.', response.status)
  }
  return receipt
}

export function submit(data: FormData, key: string, onProgress: (percent: number | null) => void, onUploadStart: () => void) {
  return new Promise<Receipt>((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', '/api/registration')
    request.responseType = 'json'
    request.timeout = 95_000
    request.setRequestHeader('Idempotency-Key', key)
    request.upload.onloadstart = onUploadStart
    request.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.round(event.loaded * 100 / event.total))
    }
    request.upload.onload = () => onProgress(null)
    request.onload = () => {
      if ((request.status === 200 || request.status === 202) && request.response?.reference) {
        resolve(request.response as Receipt)
        return
      }
      reject(new ApiError(
        request.response?.message ?? (request.status === 413 ? 'Choose four images of 5 MB or less.' : 'Registration could not be submitted. Please try again.'),
        request.status,
        request.response?.errors,
      ))
    }
    request.onerror = request.ontimeout = request.onabort = () => reject(
      new ApiError('The connection was interrupted. Try again to check whether the registration was received.', 0),
    )
    request.send(data)
  })
}
