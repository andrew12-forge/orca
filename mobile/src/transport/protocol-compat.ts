// evaluateCompat mirrors the shared evaluator; the mobile status probe additionally
// distinguishes unreadable status from a verified version mismatch.
import { MIN_COMPATIBLE_DESKTOP_VERSION, MOBILE_PROTOCOL_VERSION } from './protocol-version'

export type CompatVerdict =
  | { kind: 'ok' }
  | { kind: 'unknown' }
  | {
      kind: 'blocked'
      reason: 'mobile-too-old' | 'desktop-too-old'
      desktopVersion: number
      requiredMobileVersion?: number
      requiredDesktopVersion?: number
    }

export function evaluateCompat(input: {
  desktopProtocolVersion: number | undefined
  desktopMinCompatibleMobileVersion: number | undefined
}): CompatVerdict {
  const desktopVersion = input.desktopProtocolVersion ?? 0
  const requiredMobile = input.desktopMinCompatibleMobileVersion ?? 0

  if (MOBILE_PROTOCOL_VERSION < requiredMobile) {
    return {
      kind: 'blocked',
      reason: 'mobile-too-old',
      desktopVersion,
      requiredMobileVersion: requiredMobile
    }
  }
  if (desktopVersion < MIN_COMPATIBLE_DESKTOP_VERSION) {
    return {
      kind: 'blocked',
      reason: 'desktop-too-old',
      desktopVersion,
      requiredDesktopVersion: MIN_COMPATIBLE_DESKTOP_VERSION
    }
  }
  return { kind: 'ok' }
}

export function readHostProtocolVerdict(status: unknown): CompatVerdict {
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    return { kind: 'unknown' }
  }
  const fields = status as Record<string, unknown>
  const version = fields.protocolVersion
  const minimum = fields.minCompatibleMobileVersion
  if (
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 0 ||
    typeof minimum !== 'number' ||
    !Number.isSafeInteger(minimum) ||
    minimum < 0
  ) {
    return { kind: 'unknown' }
  }
  return evaluateCompat({
    desktopProtocolVersion: version,
    desktopMinCompatibleMobileVersion: minimum
  })
}
