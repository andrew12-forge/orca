import type { OrchestrationDb } from './db'
import {
  MAILBOX_POINTER_RESERVED,
  type MailboxPointerReservation
} from './db/messages/mailbox-pointer-enter-state'
import type { PointerDeliveryDependencies } from './mailbox-pointer-delivery-contract'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxPointerState } from './mailbox-pointer-state'

/** Reconciles mailbox pointer reservations left behind by a previous process or a dead PTY.
 *  Reservations are read straight from the durable rows through
 *  `idx_messages_pending_pointer_pty`, so no in-memory mirror can drift from the database. */
export class MailboxPointerRecovery<TWaiter extends OrchestrationMessageWaiter> {
  private connection?: OrchestrationDb['db']

  constructor(
    private readonly deps: PointerDeliveryDependencies<TWaiter>,
    private readonly state: OrchestrationMailboxPointerState
  ) {}

  attach(db: OrchestrationDb | null): void {
    if (this.connection === db?.db) {
      return
    }
    this.connection = db?.db
    this.state.clear()
    if (db) {
      this.reconcile(
        db,
        db.getMailboxPointerReservations().filter((row) => this.isLive(row))
      )
    }
  }

  observeWorking(ptyId: string): void {
    const db = this.deps.getDb()
    this.attach(db)
    if (!db) {
      return
    }
    this.reconcile(
      db,
      db.getMailboxPointerReservationsForPty(ptyId).filter((row) => this.isLive(row))
    )
  }

  settle(ptyId: string, ids: readonly string[], incarnation: string): void {
    const db = this.deps.getDb()
    if (!db || this.connection !== db.db) {
      return
    }
    const selected = new Set(ids)
    this.reconcile(
      db,
      db
        .getMailboxPointerReservationsForPty(ptyId)
        .filter((row) => selected.has(row.id) && row.pointer_process_incarnation === incarnation)
    )
  }

  /** A reservation is only recoverable while the pane still runs the incarnation that made it. */
  private isLive(row: MailboxPointerReservation): boolean {
    try {
      const handle = this.deps.deliveryTarget.resolveTerminalHandle(row.to_handle)
      if (!handle) {
        return false
      }
      const leaf = this.deps.getLiveLeafForHandle(handle)
      return (
        leaf.ptyId === row.pointer_pty_id &&
        this.deps.resolveSubmitTarget(leaf, row.pointer_pty_id)?.processIncarnation ===
          row.pointer_process_incarnation
      )
    } catch {
      // Attach may precede terminal restoration; the next observation retries recovery.
      return false
    }
  }

  private reconcile(db: OrchestrationDb, rows: readonly MailboxPointerReservation[]): void {
    for (const row of rows) {
      if (this.state.observeWorkingFlight(row.pointer_pty_id)) {
        continue
      }
      const target = {
        ptyId: row.pointer_pty_id,
        processIncarnation: row.pointer_process_incarnation
      }
      if (row.pointer_enter_pending === MAILBOX_POINTER_RESERVED) {
        db.releaseMailboxPointerEnter([row.id], target, [row.pointer_enter_pending])
      } else {
        db.settleMailboxPointerEnter([row.id], target, [row.pointer_enter_pending])
      }
    }
  }
}
