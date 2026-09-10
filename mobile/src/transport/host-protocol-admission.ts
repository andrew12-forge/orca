import { MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD } from './mobile-runtime-client-capabilities'
import { readHostProtocolVerdict, type CompatVerdict } from './protocol-compat'
import type { RpcResponse } from './types'

// Physical authentication frames precede RPC; capability negotiation and liveness status
// also run inside direct/relay sessions before the logical client is connected.
export const HOST_PROTOCOL_BOOTSTRAP_METHODS = new Set([
  'status.get',
  MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD,
  'pairing.provisionRelay',
  'pairing.getEndpoints'
])

export class HostProtocolAdmission {
  private verdict: CompatVerdict = { kind: 'unknown' }

  allows(method: string): boolean {
    return this.verdict.kind === 'ok' || HOST_PROTOCOL_BOOTSTRAP_METHODS.has(method)
  }

  reset(): void {
    this.verdict = { kind: 'unknown' }
  }

  observe(response: RpcResponse): void {
    const verdict = response.ok
      ? readHostProtocolVerdict(response.result)
      : { kind: 'unknown' as const }
    // A transient failure cannot revoke this generation's verified compatibility.
    if (verdict.kind !== 'unknown') {
      this.verdict = verdict
    }
  }
}
