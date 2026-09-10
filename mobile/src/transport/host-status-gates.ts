import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'
import type { DesktopStatus } from '../worktree/host-worktree-rpc-types'
import { readHostProtocolVerdict, type CompatVerdict } from './protocol-compat'
import { normalizeHostAppVersion, recordHostAppVersion } from './host-app-version-store'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'

export type HostStatusGates = {
  hostCapabilities: string[]
  floatingWorkspaceEnabled: boolean
  desktopAppVersion: string | null
  compatVerdict: CompatVerdict
  statusPending: boolean
  retryStatus: () => void
}

type LoadedHostStatusGates = Omit<HostStatusGates, 'statusPending' | 'retryStatus'> & {
  hostId: string | undefined
  client: RpcClient
  generation: number
}

const EMPTY_HOST_CAPABILITIES: string[] = []
const STATUS_RETRY_DELAYS = [1_000, 2_000, 4_000]

export function useHostStatusGates(args: {
  hostId: string | undefined
  client: RpcClient | null
  connState: ConnectionState
}): HostStatusGates {
  const { hostId, client, connState } = args
  const [loaded, setLoaded] = useState<LoadedHostStatusGates | null>(null)
  const [unverified, setUnverified] = useState(false)
  const [retry, setRetry] = useState(0)
  const retryStatus = useCallback(() => setRetry((value) => value + 1), [])
  const readGeneration = useCallback(
    () => (client as Partial<StableLogicalRpcClient> | null)?.getGeneration?.() ?? 0,
    [client]
  )
  const subscribeGeneration = useCallback(
    (listener: () => void) => client?.onStateChange?.(listener) ?? (() => {}),
    [client]
  )
  const generation = useSyncExternalStore(subscribeGeneration, readGeneration, readGeneration)

  useEffect(() => {
    if (connState !== 'connected' || !client) {
      setUnverified(true)
      return
    }
    let cancelled = false
    let cancelRetry = () => {}
    let attempt = 0
    const settleUnknown = () => {
      if (cancelled || generation !== readGeneration()) {
        return
      }
      setUnverified(false)
      setLoaded((previous) => {
        if (
          previous !== null &&
          previous.hostId === hostId &&
          previous.client === client &&
          previous.generation === generation
        ) {
          return previous
        }
        return {
          hostId,
          client,
          generation,
          hostCapabilities: EMPTY_HOST_CAPABILITIES,
          floatingWorkspaceEnabled: false,
          desktopAppVersion: null,
          compatVerdict: { kind: 'unknown' }
        }
      })
      const delay = STATUS_RETRY_DELAYS[attempt++]
      if (delay !== undefined) {
        cancelRetry = scheduleHostStatusRetry(() => void probe(), delay)
      }
    }
    const probe = async () => {
      if (cancelled || generation !== readGeneration()) {
        return
      }
      setUnverified(true)
      try {
        const response = await client.sendRequest('status.get', undefined, { timeoutMs: 8_000 })
        if (cancelled || generation !== readGeneration()) {
          return
        }
        const verdict = response.ok
          ? readHostProtocolVerdict(response.result)
          : { kind: 'unknown' as const }
        if (verdict.kind === 'unknown' || !response.ok) {
          settleUnknown()
          return
        }
        const status = response.result as DesktopStatus & { capabilities?: string[] }
        const desktopAppVersion = normalizeHostAppVersion(status.appVersion)
        if (hostId && desktopAppVersion) {
          void recordHostAppVersion(hostId, desktopAppVersion)
        }
        setLoaded({
          hostId,
          client,
          generation,
          hostCapabilities: status.capabilities ?? EMPTY_HOST_CAPABILITIES,
          floatingWorkspaceEnabled: status.floatingWorkspaceEnabled === true,
          desktopAppVersion,
          compatVerdict: verdict
        })
        setUnverified(false)
        if (verdict.kind === 'blocked') {
          console.warn('[protocol-compat] blocked', {
            reason: verdict.reason,
            desktopVersion: verdict.desktopVersion,
            requiredMobileVersion: verdict.requiredMobileVersion,
            requiredDesktopVersion: verdict.requiredDesktopVersion
          })
        }
      } catch {
        settleUnknown()
      }
    }
    void probe()
    return () => {
      cancelled = true
      cancelRetry()
    }
  }, [client, connState, hostId, generation, readGeneration, retry])

  // A logical client survives cutover; its generation fences even a same-host late reply.
  const proven =
    loaded &&
    loaded.hostId === hostId &&
    loaded.client === client &&
    loaded.generation === generation
      ? loaded
      : null
  if (!proven) {
    return {
      hostCapabilities: EMPTY_HOST_CAPABILITIES,
      floatingWorkspaceEnabled: false,
      desktopAppVersion: null,
      compatVerdict: { kind: 'unknown' },
      statusPending: connState === 'connected' && client !== null,
      retryStatus
    }
  }
  return {
    hostCapabilities: proven.hostCapabilities,
    floatingWorkspaceEnabled: proven.floatingWorkspaceEnabled,
    desktopAppVersion: proven.desktopAppVersion,
    compatVerdict: proven.compatVerdict,
    // Proven capabilities and navigation survive a transient same-generation reconnect.
    statusPending: connState === 'connected' && unverified,
    retryStatus
  }
}

function scheduleHostStatusRetry(probe: () => void, delay: number): () => void {
  const timer = setTimeout(probe, delay)
  return () => clearTimeout(timer)
}
