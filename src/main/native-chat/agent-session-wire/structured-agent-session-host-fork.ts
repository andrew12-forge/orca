import type { AgentSessionForkSource } from '../../../shared/agent-session-fork'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { forkStructuredAgentSession } from './structured-agent-session-fork'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'

export function createStructuredAgentSessionFork(
  attachContext: () => StructuredAgentSessionAttachContext
) {
  return (
    caller: StructuredAgentSessionCaller,
    params: AgentSessionAttachParams,
    source: AgentSessionForkSource
  ) => {
    const context = attachContext()
    return forkStructuredAgentSession(context, context, caller, params, source)
  }
}
