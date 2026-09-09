import type { Session } from './session'

/** Only the host-observed result survives the operational session. */
export type ExitedSession = { incarnationId: string; code: number }

export type TerminalHostSessionRecord = Session | ExitedSession

export function exitFromRecord(
  record: TerminalHostSessionRecord | undefined
): ExitedSession | undefined {
  // Exit broadcast precedes reaping, so a reentrant reader can still see the exited Session.
  if (record && 'code' in record) {
    return record
  }
  return record && !record.isAlive && record.exitCode !== null
    ? { incarnationId: record.incarnationId, code: record.exitCode }
    : undefined
}

export function sessionFromRecord(
  record: TerminalHostSessionRecord | undefined
): Session | undefined {
  return record && 'isAlive' in record ? record : undefined
}
