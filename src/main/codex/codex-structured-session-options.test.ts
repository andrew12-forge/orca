import { describe, expect, it, vi } from 'vitest'
import { CODEX_SESSION_OPTION_CATALOG } from '../../shared/agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../shared/structured-agent-session-options'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { CodexAcquisitionWindow } from './codex-structured-acquisition-window'
import {
  applyCodexStructuredSessionOption,
  readCodexStructuredSessionOptions,
  reportedCodexThreadOptions,
  restoredCodexSessionOptions
} from './codex-structured-session-options'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import type { CodexSession } from './codex-structured-session-state'

function optionSession(request: CodexAppServerConnection['request']): CodexSession {
  return {
    connection: {
      pid: 1,
      closed: false,
      request,
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true
    },
    backgroundTasks: new CodexBackgroundTaskTracker('thread-1'),
    ended: false,
    requestedClose: false,
    fence: 1,
    acquisitionGeneration: 'generation-1',
    threadId: 'thread-1',
    historyPath: null,
    prompts: new CodexAcquisitionWindow().prompts,
    options: new Map(),
    reportedOptions: { model: 'gpt-live', effort: 'high' },
    turnIdWaiters: [],
    translator: null
  }
}

describe('structured Codex session options', () => {
  it('filters restored records to recognized turn options', () => {
    expect(
      Object.fromEntries(
        restoredCodexSessionOptions({
          model: 'gpt-live',
          effort: 'high',
          threadId: 'thread-injected',
          input: 'input-injected'
        })
      )
    ).toEqual({ model: 'gpt-live', effort: 'high' })
  })

  it('hydrates paged provider models and their supported efforts', async () => {
    const request = vi.fn(async (_method: string, params?: Record<string, unknown>) =>
      params?.cursor
        ? {
            data: [
              {
                model: 'gpt-second',
                displayName: 'GPT Second',
                description: 'Fast',
                hidden: false,
                supportedReasoningEfforts: [
                  { reasoningEffort: 'low', description: 'Quick reasoning' }
                ],
                defaultReasoningEffort: 'low',
                isDefault: false
              }
            ],
            nextCursor: null
          }
        : {
            data: [
              {
                model: 'gpt-live',
                displayName: 'GPT Live',
                hidden: false,
                supportedReasoningEfforts: [
                  { reasoningEffort: 'medium', description: 'Balanced' },
                  { reasoningEffort: 'high', description: 'Deep reasoning' }
                ],
                defaultReasoningEffort: 'medium',
                isDefault: true
              }
            ],
            nextCursor: 'page-2'
          }
    )

    await expect(
      readCodexStructuredSessionOptions({
        connection: { request } as never,
        current: { model: 'gpt-live', effort: 'medium' }
      })
    ).resolves.toEqual({
      models: [
        {
          id: 'gpt-live',
          label: 'GPT Live',
          isDefault: true,
          defaultEffort: 'medium',
          efforts: [
            { value: 'medium', label: 'Medium', description: 'Balanced' },
            { value: 'high', label: 'High', description: 'Deep reasoning' }
          ]
        },
        {
          id: 'gpt-second',
          label: 'GPT Second',
          description: 'Fast',
          isDefault: false,
          defaultEffort: 'low',
          efforts: [{ value: 'low', label: 'Low', description: 'Quick reasoning' }]
        }
      ],
      current: { model: 'gpt-live', effort: 'medium' }
    })
    expect(request).toHaveBeenNthCalledWith(
      2,
      'model/list',
      { limit: 100, includeHidden: false, cursor: 'page-2' },
      { timeoutMs: undefined }
    )
  })

  it('reports an unlisted current model without offering it as a choice', async () => {
    // Was: a fabricated `{ id, label: id, efforts: [] }` row, which offered a raw launch
    // id in the picker as though the account were entitled to it.
    const request = vi.fn(async () => ({
      data: [{ model: 'gpt-live', displayName: 'GPT Live', isDefault: true }],
      nextCursor: null
    }))

    await expect(
      readCodexStructuredSessionOptions({
        connection: { request } as never,
        current: { model: 'gpt-unlisted' }
      })
    ).resolves.toEqual({
      models: [{ id: 'gpt-live', label: 'GPT Live', isDefault: true, efforts: [] }],
      current: { model: 'gpt-unlisted' }
    })
  })

  it('falls back to the seed when model/list answers nothing for a running thread', async () => {
    // The thread still runs a model, and an empty list carries no options — the snapshot
    // returns nothing at all for one, taking the effort pill with the model pill.
    const request = vi.fn(async () => ({ data: [], nextCursor: null }))

    const result = await readCodexStructuredSessionOptions({
      connection: { request } as never,
      current: { model: 'gpt-5.9-secret' }
    })

    expect(result.current.model).toBe('gpt-5.9-secret')
    expect(result.models.map((model) => model.id)).toEqual(
      CODEX_SESSION_OPTION_CATALOG.models.map((model) => model.id)
    )
    expect(result.models.some((model) => model.id === 'gpt-5.9-secret')).toBe(false)

    // What the floor is for: both pills survive, and the pill still names what runs.
    const snapshot = structuredAgentSessionOptionSnapshot(
      applyStructuredAgentSessionOptions(
        createStructuredAgentSessionOptionState('codex'),
        CODEX_SESSION_OPTION_CATALOG,
        result
      )
    )
    expect(snapshot.map((descriptor) => descriptor.id)).toEqual(['model', 'effort'])
    // Any source but `unknown` makes the pill name the value it carries.
    expect(snapshot[0]).toMatchObject({
      valueSource: 'dispatched',
      kind: { type: 'select', currentValue: 'gpt-5.9-secret' }
    })
    expect(snapshot[1]).toMatchObject({ settable: true })
  })

  it('still refuses a thread with neither a listed model nor a current one', async () => {
    const request = vi.fn(async () => ({ data: [], nextCursor: null }))

    await expect(
      readCodexStructuredSessionOptions({ connection: { request } as never, current: {} })
    ).rejects.toThrow('codex app-server returned no available models')
  })

  it('hydrates current values from thread start or resume', () => {
    expect(
      reportedCodexThreadOptions({
        threadId: 'thread-1',
        historyPath: null,
        model: 'gpt-live',
        effort: 'high'
      })
    ).toEqual({ model: 'gpt-live', effort: 'high' })
  })

  it('reconciles an incompatible effort when only the model changes', async () => {
    const session = optionSession(
      vi.fn(async () => ({
        data: [
          {
            model: 'gpt-live',
            supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
            defaultReasoningEffort: 'high'
          },
          {
            model: 'gpt-fast',
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
            defaultReasoningEffort: 'low'
          }
        ],
        nextCursor: null
      }))
    )

    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'gpt-fast', undefined)
    ).resolves.toEqual({ model: 'gpt-fast', effort: 'low' })
  })

  it('rejects values absent from the provider catalog', async () => {
    const session = optionSession(
      vi.fn(async () => ({
        data: [{ model: 'gpt-live', supportedReasoningEfforts: [] }],
        nextCursor: null
      }))
    )

    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'not-entitled', undefined)
    ).rejects.toThrow('does not offer model not-entitled')
    await expect(
      applyCodexStructuredSessionOption(session, 'effort', 'high', undefined)
    ).rejects.toThrow('does not support high')
  })
})
