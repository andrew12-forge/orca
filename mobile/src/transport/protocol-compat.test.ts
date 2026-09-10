import { describe, expect, it } from 'vitest'
import { evaluateCompat } from './protocol-compat'

describe('evaluateCompat', () => {
  it('blocks a retired protocol-2 desktop', () => {
    expect(
      evaluateCompat({
        desktopProtocolVersion: 2,
        desktopMinCompatibleMobileVersion: 2
      })
    ).toEqual({
      kind: 'blocked',
      reason: 'desktop-too-old',
      desktopVersion: 2,
      requiredDesktopVersion: 3
    })
  })
})
