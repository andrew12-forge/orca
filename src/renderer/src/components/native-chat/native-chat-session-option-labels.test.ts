import { describe, expect, it, vi } from 'vitest'
import { translate } from '@/i18n/i18n'
import {
  nativeChatModelPillLabel,
  nativeChatSessionChoiceLabel
} from './native-chat-session-option-labels'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import { CLAUDE_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session-option-catalog-claude-codex'
import { buildNativeChatSessionOptionSnapshot } from '../../../../shared/native-chat-session-option-snapshot'
import { createNativeChatSessionOptionRecord } from '../../../../shared/native-chat-session-option-state'

vi.mock('@/i18n/i18n', () => ({
  translate: vi.fn((_key: string, fallback: string) => fallback)
}))

function modelDescriptor(
  valueSource: SessionOptionDescriptor['valueSource'],
  currentValue?: string
): SessionOptionDescriptor {
  return {
    id: 'model',
    label: 'Model',
    valueSource,
    transport: 'catalog',
    settable: true,
    kind: {
      type: 'select',
      ...(currentValue ? { currentValue } : {}),
      choices: [{ value: 'grok-4.5', label: 'Grok 4.5' }]
    }
  }
}

describe('nativeChatModelPillLabel', () => {
  it('names a model the CLI defaulted to, not the bare category', () => {
    // This is the last step between `defaultModelIsCliDefault` and pixels: withholding
    // `default` here would silently undo the whole load-time default display.
    expect(nativeChatModelPillLabel(modelDescriptor('default', 'grok-4.5'))).toBe('Grok 4.5')
  })

  it('names a model the user picked', () => {
    expect(nativeChatModelPillLabel(modelDescriptor('applied', 'grok-4.5'))).toBe('Grok 4.5')
  })

  it('withholds a value it has no evidence for', () => {
    expect(nativeChatModelPillLabel(modelDescriptor('unknown', 'grok-4.5'))).toBe('Model')
    expect(nativeChatModelPillLabel(modelDescriptor('default'))).toBe('Model')
  })

  it('falls back to the raw id when the list no longer offers it', () => {
    // A discovered list can drop an id the record still tracks; showing the id beats
    // showing "Model" while a real model is running.
    expect(nativeChatModelPillLabel(modelDescriptor('reported', 'grok-build'))).toBe('grok-build')
  })

  it('names the unlisted model a real snapshot reports, end to end', () => {
    // The producer half of the contract above: the snapshot must keep handing the pill a
    // `currentValue` and a non-`unknown` source for a model that is running but unlisted,
    // or the composer goes back to reading a neutral "Model" over a live session.
    const record = createNativeChatSessionOptionRecord('claude')
    record.model = { value: 'claude-opus-5', source: 'reported' }
    const snapshot = buildNativeChatSessionOptionSnapshot({
      catalog: CLAUDE_SESSION_OPTION_CATALOG,
      models: CLAUDE_SESSION_OPTION_CATALOG.models,
      record,
      mode: 'live',
      modelLabel: 'Model',
      liveTransport: 'catalog'
    })

    expect(nativeChatModelPillLabel(snapshot[0]!)).toBe('claude-opus-5')
  })
})

describe('nativeChatSessionChoiceLabel', () => {
  it('routes ultra through the localized effort label', () => {
    nativeChatSessionChoiceLabel({ value: 'ultra', label: 'Ultra' })

    expect(translate).toHaveBeenCalledWith(
      'components.native-chat.composer.optionValue.ultra',
      'Ultra'
    )
  })
})
