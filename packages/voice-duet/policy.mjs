// Apache-2.0. Policy for the adapted dsh-duet host paths.
export function requireSecureEndpoint(value) {
  const url = new URL(value)
  if (url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => key !== 'protocol')) throw Error('invalid_voice_endpoint')
  const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname)
  if (!(url.protocol === 'wss:' || url.protocol === 'https:' || (loopback && ['ws:', 'http:'].includes(url.protocol)))) throw Error('voice_requires_tls')
  return url
}
