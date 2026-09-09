import { describe, expect, it, vi } from 'vitest'
import {
  dispatchStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionComposerCommand,
  structuredSlashCommands
} from './structured-agent-session-composer'
import type { SessionOptionDescriptor } from './native-chat-session-options'

describe('structuredSlashCommands', () => {
  // The composer menu and the dispatcher read this one list. When they disagreed,
  // a Claude session was offered Codex-only tokens that missed the command guard
  // and reached the model as literal prompt text instead of erroring.
  it.each(['codex', 'claude'] as const)('offers %s only commands it also accepts', (agent) => {
    const offered = structuredSlashCommands()
    expect(offered.length).toBeGreaterThan(0)
    for (const command of offered) {
      expect(isStructuredAgentSessionComposerCommand(`/${command.name}`, agent)).toBe(true)
    }
  })

  it('offers only the commands a chat session can carry out', () => {
    expect(structuredSlashCommands().map((command) => command.name)).toEqual(['model', 'effort'])
  })
  it('adds only implemented host-supported conversation commands', () => {
    expect(structuredSlashCommands(['clear', 'compact']).map((command) => command.name)).toEqual([
      'model',
      'effort',
      'clear',
      'compact'
    ])
    expect(structuredSlashCommands(['compact']).map((command) => command.name)).toEqual([
      'model',
      'effort',
      'compact'
    ])
  })
})

describe('isStructuredAgentSessionComposerCommand', () => {
  // The menu hides TUI-only commands, but the guard must still claim a typed one
  // so it is answered here instead of sent to the model as prose.
  it.each([
    ['codex', 'vim'],
    ['codex', 'clear'],
    ['claude', 'compact'],
    ['claude', 'clear']
  ] as const)('claims the unoffered %s command /%s', (agent, name) => {
    expect(isStructuredAgentSessionComposerCommand(`/${name}`, agent)).toBe(true)
  })

  it('leaves an unknown token to the chat path', () => {
    expect(isStructuredAgentSessionComposerCommand('/my-skill', 'claude')).toBe(false)
  })
})

describe('dispatchStructuredAgentSessionComposerCommand', () => {
  const controller = {
    agent: 'codex' as const,
    snapshot: [],
    invokeAction: async () => true,
    setOption: async () => true
  }

  it('names what does work when a TUI-only command is typed', async () => {
    const outcome = await dispatchStructuredAgentSessionComposerCommand('/vim', controller)
    expect(outcome.handled).toBe(true)
    expect(outcome.error).toBe(
      '/vim is not available in chat sessions. Use the slash menu to see available commands.'
    )
  })
  it.each(['claude', 'codex'] as const)(
    'handles %s conversation commands without message fallthrough',
    async (agent) => {
      const runConversationCommand = vi.fn(async () => ({ accepted: true, error: null }))
      for (const command of ['clear', 'compact'] as const) {
        const result = await dispatchStructuredAgentSessionComposerCommand(`/${command}`, {
          ...controller,
          agent,
          conversationCommands: ['clear', 'compact'],
          runConversationCommand
        })
        expect(result).toEqual({ handled: true, accepted: true, error: null })
        expect(runConversationCommand).toHaveBeenLastCalledWith(command)
      }
    }
  )
  it('accepts the running model as a no-op even though it is never offered', async () => {
    // The pill names an unlisted model the session actually runs; typing that same id
    // used to be refused as "not an available model", contradicting the pill.
    const setOption = vi.fn(async () => true)
    const running = {
      ...controller,
      setOption,
      snapshot: [
        {
          id: 'model',
          label: 'Model',
          category: 'model',
          kind: {
            type: 'select',
            currentValue: 'claude-opus-5',
            choices: [{ value: 'gpt-live', label: 'GPT Live' }]
          },
          valueSource: 'reported',
          transport: 'agent-session',
          settable: true
        }
      ] satisfies SessionOptionDescriptor[]
    }

    expect(
      await dispatchStructuredAgentSessionComposerCommand('/model Claude-Opus-5', running)
    ).toEqual({ handled: true, accepted: true, error: null })
    expect(setOption).not.toHaveBeenCalled()

    // A genuinely unavailable id is still refused.
    expect(
      await dispatchStructuredAgentSessionComposerCommand('/model gpt-retired', running)
    ).toEqual({
      handled: true,
      accepted: false,
      error: 'gpt-retired is not an available model for this chat session.'
    })
  })

  it('retains a draft on unsupported hosts and rejects arguments before dispatch', async () => {
    expect(await dispatchStructuredAgentSessionComposerCommand('/clear', controller)).toMatchObject(
      { handled: true, accepted: false, error: '/clear is not supported by this chat host.' }
    )
    const runConversationCommand = vi.fn()
    expect(
      await dispatchStructuredAgentSessionComposerCommand('/compact keep this', {
        ...controller,
        conversationCommands: ['compact'],
        runConversationCommand
      })
    ).toMatchObject({ handled: true, accepted: false })
    expect(runConversationCommand).not.toHaveBeenCalled()
  })
})
