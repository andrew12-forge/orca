import { forkJournalSeed } from './structured-fork-journal-seed'
import { restoreRewindJournalBody } from './structured-rewind-journal-body'
import type { AgentSessionRewindReason } from '../../../shared/agent-session-rewind'
import { prepareStructuredForkReplay } from './structured-agent-session-fork-replay'
import type { AgentSessionForkSource } from '../../../shared/agent-session-fork'
import { agentSessionLeaseAdmitsWriter } from '../../../shared/agent-session-lease-adjudication'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionExecutionLocationsEqual } from '../../../shared/agent-session-record'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import { selectAgentSessionPrefix } from '../../../shared/agent-session-prefix'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { attachStructuredAgentSession } from './structured-agent-session-attach-orchestration'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import { conversationCommandBlocked } from './structured-conversation-command-admission'

export function forkStructuredAgentSession(
  context: Pick<StructuredAgentSessionMutationContext, 'deps' | 'sessions' | 'serialize' | 'now'>,
  attachContext: StructuredAgentSessionAttachContext,
  caller: StructuredAgentSessionCaller,
  params: AgentSessionAttachParams,
  source: AgentSessionForkSource
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  if (
    source.sessionId === params.envelope.sessionId ||
    params.adopt ||
    params.envelope.expectedRuntimeFence !== null
  ) {
    return Promise.resolve(refuse('invalid-target'))
  }
  return context.serialize(source.sessionId, async () => {
    const store = context.deps.store
    const target = store.getRecord(params.envelope.sessionId)
    const parent = store.getRecord(source.sessionId)
    const prior = target?.fork
    if (
      prior &&
      (prior.operationId !== params.envelope.clientOperationId ||
        prior.callerKey !== caller.callerKey)
    ) {
      return refuse('invalid-target')
    }
    if (
      prior &&
      (prior.sourceSessionId !== source.sessionId ||
        prior.itemId !== source.itemId ||
        prior.expectedEpoch !== source.expectedEpoch ||
        prior.expectedRuntimeFence !== source.expectedRuntimeFence)
    ) {
      return refuse('invalid-target')
    }
    const pinned = prior ? target : parent
    if (
      !pinned ||
      pinned.provider !== params.provider ||
      !agentSessionExecutionLocationsEqual(pinned.location, params.location)
    ) {
      return refuse('invalid-target')
    }
    let fork = prior
    if (!fork) {
      const support = context.deps.adapter.forkSupport?.(source.sessionId)
      if (!support?.supported) {
        return refuse(support?.reason === 'history-not-paginated' ? support.reason : 'unsupported')
      }
      const session = context.sessions.get(source.sessionId)
      if (!parent || !session || !agentSessionLeaseAdmitsWriter(parent.lease)) {
        return refuse('busy')
      }
      await attachContext.runtimeState.flushEventSink(source.sessionId)
      if (
        parent.lease.runtimeFence !== source.expectedRuntimeFence ||
        session.journal.cursor().epoch !== source.expectedEpoch
      ) {
        return refuse('stale-epoch')
      }
      const blocked = conversationCommandBlocked(
        { sessionId: source.sessionId, journal: session.journal, adapter: context.deps.adapter },
        parent
      )
      if (blocked || session.journal.isReadOnly) {
        return refuse('busy')
      }
      const head = agentSessionProviderHandleChainHead(parent.providerHandleChain)?.handle
      if (!head) {
        return refuse('invalid-target')
      }
      const selected = selectAgentSessionPrefix({
        ...session.journal.snapshot(),
        itemId: source.itemId,
        handle: head,
        boundary: 'through'
      })
      if (!selected.ok) {
        return refuse(selected.reason)
      }
      const retained = selected.retained.map(({ itemId, body, observedAt }) => ({
        itemId,
        body: restoreRewindJournalBody(body),
        observedAt
      }))
      try {
        forkJournalSeed(retained, head, head)
      } catch {
        return refuse('unsupported')
      }
      fork = {
        sourceSessionId: source.sessionId,
        operationId: params.envelope.clientOperationId,
        callerKey: caller.callerKey,
        itemId: source.itemId,
        expectedEpoch: source.expectedEpoch,
        expectedRuntimeFence: source.expectedRuntimeFence,
        source: head,
        throughId: selected.throughId,
        phase: 'prepared',
        retained
      }
    }
    const attach: AgentSessionAttachParams = {
      ...params,
      accountHome: pinned.accountHome,
      options: pinned.options,
      launchArgs: pinned.launchArgs,
      fork
    }
    attach.envelope = {
      ...params.envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId: params.envelope.sessionId,
        fields: attachFingerprintFields(attach)
      })
    }
    const replay = await prepareStructuredForkReplay(context, caller, attach)
    if (replay.result) {
      return replay.result
    }
    return attachStructuredAgentSession(attachContext, caller.callerKey, replay.params)
  })
}

function refuse(reason: AgentSessionRewindReason): AgentSessionMutationResult<never> {
  return {
    ok: false,
    refusal: {
      code: 'agent_session_operation_invalid',
      message: `agent_session_fork:${reason}`,
      forkReason: reason
    }
  }
}
