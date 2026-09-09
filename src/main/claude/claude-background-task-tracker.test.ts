import { describe, expect, it } from 'vitest'
import {
  ClaudeBackgroundTaskTracker,
  classifyClaudeBackgroundTaskKind
} from './claude-background-task-tracker'

function system(subtype: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { type: 'system', subtype, session_id: 'provider-1', uuid: crypto.randomUUID(), ...fields }
}

function result(): Record<string, unknown> {
  return { type: 'result', subtype: 'success', session_id: 'provider-1', uuid: crypto.randomUUID() }
}

function aggregate(tasks: unknown[]): Record<string, unknown> {
  return system('background_tasks_changed', { tasks })
}

describe('ClaudeBackgroundTaskTracker', () => {
  it('classifies SDK task types without inferring them from descriptions', () => {
    expect(classifyClaudeBackgroundTaskKind('local_agent')).toBe('agent')
    expect(classifyClaudeBackgroundTaskKind('local_workflow')).toBe('workflow')
    expect(classifyClaudeBackgroundTaskKind('local_bash')).toBe('command')
    expect(classifyClaudeBackgroundTaskKind('monitor')).toBe('monitor')
    expect(classifyClaudeBackgroundTaskKind('future_task')).toBe('unknown')
  })

  it('monitors a background task while the foreground turn is still open', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe({ type: 'user' }, true)
    tracker.observe(
      system('task_started', {
        task_id: 'task-1',
        task_type: 'local_agent',
        is_backgrounded: true
      })
    )
    const running = { state: 'monitoring', tasks: [{ id: 'task-1', kind: 'agent' }] }
    expect(tracker.state).toEqual(running)

    // `result` is not this task's outcome: it was backgrounded, so it survives.
    expect(tracker.observe(result())).toBe(false)
    expect(tracker.state).toEqual(running)
  })

  it('reports a foreground subagent in flight and retires it when the turn ends', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe({ type: 'user' }, true)
    for (const id of ['agent-1', 'agent-2']) {
      tracker.observe(
        system('task_started', { task_id: id, task_type: 'local_agent', is_backgrounded: false })
      )
    }
    // A fan-out the turn is awaiting is running work, so the strip says so.
    expect(tracker.state).toEqual({
      state: 'monitoring',
      tasks: [
        { id: 'agent-1', kind: 'agent', stoppable: false },
        { id: 'agent-2', kind: 'agent', stoppable: false }
      ]
    })
    // The turn IS the outcome of work the provider marked foreground.
    expect(tracker.observe(result())).toBe(true)
    expect(tracker.state).toBeNull()
    // Foreground work is never stoppable through the background-task control.
    expect(tracker.stoppableTaskIds).toEqual([])
  })

  it('marks a foreground row not stoppable and leaves a backgrounded row alone', () => {
    // `stopTask` has no foreground target, so the row must not offer a Stop that
    // would silently do nothing. A backgrounded row stays untouched on the wire.
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe({ type: 'user' }, true)
    tracker.observe(
      system('task_started', {
        task_id: 'fore-1',
        task_type: 'local_agent',
        is_backgrounded: false
      })
    )
    tracker.observe(
      system('task_started', { task_id: 'back-1', task_type: 'local_agent', is_backgrounded: true })
    )

    expect(tracker.state?.tasks).toEqual([
      { id: 'fore-1', kind: 'agent', stoppable: false },
      { id: 'back-1', kind: 'agent' }
    ])
    expect(tracker.stoppableTaskIds).toEqual(['back-1'])
  })

  it('uses an explicit background update for a foreground task and ignores progress alone', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe({ type: 'user' }, true)
    tracker.observe(
      system('task_started', {
        task_id: 'task-1',
        task_type: 'local_bash',
        is_backgrounded: false
      })
    )
    expect(
      tracker.observe(system('task_progress', { task_id: 'task-1', description: 'still working' }))
    ).toBe(false)
    // Live while the turn runs, then retired by that turn's `result`.
    expect(tracker.state?.tasks).toEqual([{ id: 'task-1', kind: 'command', stoppable: false }])
    tracker.observe(result())
    expect(tracker.state).toBeNull()

    tracker.observe(system('task_updated', { task_id: 'task-1', patch: { is_backgrounded: true } }))
    expect(tracker.state).toEqual({
      state: 'monitoring',
      tasks: [{ id: 'task-1', kind: 'command' }]
    })
  })

  it('empties only between one task retiring and the next starting', () => {
    // The strip's mid-turn unmount in a sequential fan-out is TRUTHFUL: A leaves
    // on the provider's own terminal frame for A, B does not exist yet, and
    // nothing sweeps A early. An empty roster means no task is running.
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe({ type: 'user' }, true)
    tracker.observe(
      system('task_started', { task_id: 'A', task_type: 'local_agent', is_backgrounded: false })
    )
    expect(tracker.state?.tasks).toEqual([{ id: 'A', kind: 'agent', stoppable: false }])
    tracker.observe(system('task_notification', { task_id: 'A', status: 'completed' }))
    expect(tracker.state).toBeNull()
    tracker.observe(
      system('task_started', { task_id: 'B', task_type: 'local_agent', is_backgrounded: false })
    )
    expect(tracker.state?.tasks).toEqual([{ id: 'B', kind: 'agent', stoppable: false }])

    // Backgrounded work spanning the same gap holds the roster open, so an
    // empty one is never work the strip is hiding.
    const spanned = new ClaudeBackgroundTaskTracker()
    spanned.observe({ type: 'user' }, true)
    spanned.observe(
      system('task_started', { task_id: 'bg', task_type: 'local_bash', is_backgrounded: true })
    )
    spanned.observe(
      system('task_started', { task_id: 'A', task_type: 'local_agent', is_backgrounded: false })
    )
    spanned.observe(system('task_notification', { task_id: 'A', status: 'completed' }))
    expect(spanned.state?.tasks).toEqual([{ id: 'bg', kind: 'command' }])
  })

  it('settles a previous turn the way the subagent roster settles it', () => {
    // On this same frame the roster's `settleTurn` moves a still-working
    // FOREGROUND child to `unverifiable` and leaves a backgrounded one alone.
    // The strip has no `unverifiable` row, so keeping one would assert `live`
    // for work Orca has already stopped vouching for.
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe({ type: 'user' }, true)
    tracker.observe(
      system('task_started', { task_id: 'fore', task_type: 'local_agent', is_backgrounded: false })
    )
    tracker.observe(
      system('task_started', { task_id: 'back', task_type: 'local_bash', is_backgrounded: true })
    )

    // No `result` for that turn; the next one starting is its only end.
    tracker.observe({ type: 'user' }, true)
    expect(tracker.state?.tasks).toEqual([{ id: 'back', kind: 'command' }])
  })

  it('retires a phantom foreground row when the next turn starts', () => {
    // A foreground `task_started` with no turn open has no `result` coming to
    // retire it, so it would sit in the strip — with no stop of its own — and
    // refuse a conversation command. Turn start is the same evidence `result`
    // is, and settling on it is cleanup only: nothing gates visibility on it.
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe(
      system('task_started', {
        task_id: 'phantom',
        task_type: 'local_agent',
        is_backgrounded: false
      })
    )
    expect(tracker.state?.tasks).toEqual([{ id: 'phantom', kind: 'agent', stoppable: false }])

    tracker.observe({ type: 'user' }, true)
    expect(tracker.state).toBeNull()
  })

  it('publishes bounded display details when a running task description changes', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    expect(
      tracker.observe(
        system('task_started', {
          task_id: 'task-1',
          task_type: 'local_bash',
          is_backgrounded: true,
          description: '  run\n  the build  '
        })
      )
    ).toBe(true)
    expect(tracker.state).toEqual({
      state: 'monitoring',
      tasks: [{ id: 'task-1', kind: 'command', description: 'run the build' }]
    })

    expect(
      tracker.observe(
        system('task_updated', {
          task_id: 'task-1',
          patch: { description: 'x'.repeat(600) }
        })
      )
    ).toBe(true)
    expect(tracker.state?.tasks?.[0]?.description).toHaveLength(512)
    expect(
      tracker.observe(
        system('task_updated', {
          task_id: 'task-1',
          patch: { description: 'x'.repeat(600) }
        })
      )
    ).toBe(false)
  })

  it('replaces its roster from aggregate lifecycle frames and preserves stoppable provider ids', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    expect(
      tracker.observe(
        aggregate([
          { task_id: 'task-agent', task_type: 'local_agent', description: 'agent' },
          { task_id: 'task-bash', task_type: 'local_bash', description: 'bash' }
        ])
      )
    ).toBe(true)
    expect(tracker.stoppableTaskIds).toEqual(['task-agent', 'task-bash'])
    expect(tracker.state).toEqual({
      state: 'monitoring',
      tasks: [
        { id: 'task-agent', kind: 'agent', description: 'agent' },
        { id: 'task-bash', kind: 'command', description: 'bash' }
      ]
    })

    expect(
      tracker.observe(
        aggregate([{ task_id: 'task-next', task_type: 'local_workflow', description: 'workflow' }])
      )
    ).toBe(true)
    expect(tracker.stoppableTaskIds).toEqual(['task-next'])
    expect(tracker.state).toEqual({
      state: 'monitoring',
      tasks: [{ id: 'task-next', kind: 'workflow', description: 'workflow' }]
    })

    expect(tracker.observe(aggregate([]))).toBe(true)
    expect(tracker.stoppableTaskIds).toEqual([])
    expect(tracker.state).toBeNull()
  })

  it('keeps live foreground work across an aggregate roster that never lists it', () => {
    // `background_tasks_changed` enumerates BACKGROUNDED work only, so it is
    // authoritative over that class alone. Treating it as the whole world wiped
    // every in-flight foreground row and then dropped every later start.
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe({ type: 'user' }, true)
    tracker.observe(
      system('task_started', {
        task_id: 'fore-1',
        task_type: 'local_agent',
        is_backgrounded: false
      })
    )
    tracker.observe(
      aggregate([{ task_id: 'back-1', task_type: 'local_bash', description: 'bash' }])
    )

    // A retained row keeps the place the user is already reading it in: a roster
    // frame must not make a live row jump down the list.
    expect(tracker.state?.tasks).toEqual([
      { id: 'fore-1', kind: 'agent', stoppable: false },
      { id: 'back-1', kind: 'command', description: 'bash' }
    ])

    // A foreground start after the roster is new work, not a stale echo.
    tracker.observe(
      system('task_started', {
        task_id: 'fore-2',
        task_type: 'local_agent',
        is_backgrounded: false
      })
    )
    expect(tracker.state?.tasks).toEqual([
      { id: 'fore-1', kind: 'agent', stoppable: false },
      { id: 'back-1', kind: 'command', description: 'bash' },
      { id: 'fore-2', kind: 'agent', stoppable: false }
    ])

    // Turn end still retires the foreground rows and only those.
    tracker.observe(result())
    expect(tracker.state?.tasks).toEqual([{ id: 'back-1', kind: 'command', description: 'bash' }])
  })

  it('drops a backgrounded start the roster no longer lists but bounds what it retains', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe({ type: 'user' }, true)
    for (let index = 0; index < 300; index += 1) {
      tracker.observe(
        system('task_started', {
          task_id: `fore-${index}`,
          task_type: 'local_agent',
          is_backgrounded: false
        })
      )
    }
    tracker.observe(
      aggregate([{ task_id: 'back-1', task_type: 'local_bash', description: 'bash' }])
    )
    // 255 retained foreground rows plus the roster's own entry: retention is
    // real and still counts against the cap.
    const ids = tracker.state?.tasks?.map((task) => task.id) ?? []
    expect(ids).toHaveLength(256)
    // When the cap bites, the STALEST retained row goes, not the newest.
    expect(ids).toContain('fore-299')
    expect(ids).not.toContain('fore-44')
    expect(ids).toContain('back-1')

    // Aggregate authority over its OWN class is unchanged.
    tracker.observe(
      system('task_started', { task_id: 'stale', task_type: 'local_agent', is_backgrounded: true })
    )
    expect(tracker.stoppableTaskIds).toEqual(['back-1'])
  })

  it('excludes ambient aggregate tasks', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe(
      aggregate([
        { task_id: 'ambient', task_type: 'monitor', description: 'watcher', ambient: true },
        { task_id: 'visible', task_type: 'local_bash', description: 'command' }
      ])
    )

    expect(tracker.stoppableTaskIds).toEqual(['visible'])
  })

  it('does not let late edge frames revive tasks cleared by an aggregate roster', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe(
      aggregate([{ task_id: 'task-late', task_type: 'local_agent', description: 'agent' }])
    )
    tracker.observe(aggregate([]))

    tracker.observe(
      system('task_started', {
        task_id: 'task-late',
        task_type: 'local_agent',
        is_backgrounded: true
      })
    )
    tracker.observe(
      system('task_updated', { task_id: 'task-late', patch: { is_backgrounded: true } })
    )

    expect(tracker.stoppableTaskIds).toEqual([])
    expect(tracker.state).toBeNull()
  })

  it('keeps a finished foreground id dead across a roster that never listed it', () => {
    // The admission guard only convicts BACKGROUNDED starts now, so terminal
    // evidence is the only thing left defending a finished foreground id — and
    // the roster carries no evidence about one, so it must not wipe it.
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe({ type: 'user' }, true)
    tracker.observe(
      system('task_started', {
        task_id: 'fore-1',
        task_type: 'local_agent',
        is_backgrounded: false
      })
    )
    tracker.observe(system('task_notification', { task_id: 'fore-1', status: 'completed' }))
    expect(tracker.state).toBeNull()

    tracker.observe(
      aggregate([{ task_id: 'back-1', task_type: 'local_bash', description: 'bash' }])
    )
    tracker.observe(
      system('task_started', {
        task_id: 'fore-1',
        task_type: 'local_agent',
        is_backgrounded: false
      })
    )

    expect(tracker.state?.tasks).toEqual([{ id: 'back-1', kind: 'command', description: 'bash' }])
  })

  it('lets an authoritative aggregate roster replace earlier terminal-edge evidence', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe(system('task_notification', { task_id: 'task-live', status: 'completed' }))

    tracker.observe(
      aggregate([{ task_id: 'task-live', task_type: 'local_agent', description: 'agent' }])
    )

    expect(tracker.stoppableTaskIds).toEqual(['task-live'])
    expect(tracker.state).toEqual({
      state: 'monitoring',
      tasks: [{ id: 'task-live', kind: 'agent', description: 'agent' }]
    })
  })

  it('keeps terminal edges authoritative on either side of aggregate replacement', () => {
    const terminalFirst = new ClaudeBackgroundTaskTracker()
    terminalFirst.observe(
      system('task_notification', { task_id: 'task-first', status: 'completed' })
    )
    terminalFirst.observe(aggregate([]))
    terminalFirst.observe(
      system('task_started', {
        task_id: 'task-first',
        task_type: 'local_agent',
        is_backgrounded: true
      })
    )
    expect(terminalFirst.state).toBeNull()

    const terminalLast = new ClaudeBackgroundTaskTracker()
    terminalLast.observe(
      aggregate([{ task_id: 'task-last', task_type: 'local_agent', description: 'agent' }])
    )
    terminalLast.observe(system('task_notification', { task_id: 'task-last', status: 'completed' }))
    terminalLast.observe(
      system('task_started', {
        task_id: 'task-last',
        task_type: 'local_agent',
        is_backgrounded: true
      })
    )
    expect(terminalLast.state).toBeNull()
  })

  it('keeps terminal evidence authoritative across duplicates and out-of-order starts', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    const terminal = system('task_notification', { task_id: 'task-late', status: 'completed' })
    tracker.observe(terminal)
    tracker.observe(terminal)
    tracker.observe(
      system('task_started', {
        task_id: 'task-late',
        task_type: 'local_workflow',
        is_backgrounded: true
      })
    )
    expect(tracker.state).toBeNull()

    tracker.observe(
      system('task_started', {
        task_id: 'task-live',
        task_type: 'monitor'
      })
    )
    expect(tracker.state).toEqual({
      state: 'monitoring',
      tasks: [{ id: 'task-live', kind: 'monitor' }]
    })
    expect(
      tracker.observe(system('task_updated', { task_id: 'task-live', patch: { status: 'killed' } }))
    ).toBe(true)
    expect(tracker.state).toBeNull()
  })

  it('recognizes task types that are registered only as background work', () => {
    for (const taskType of ['local_workflow', 'monitor']) {
      const tracker = new ClaudeBackgroundTaskTracker()
      tracker.observe(system('task_started', { task_id: taskType, task_type: taskType }))
      expect(tracker.state).toEqual({
        state: 'monitoring',
        tasks: [{ id: taskType, kind: taskType === 'local_workflow' ? 'workflow' : 'monitor' }]
      })
    }
  })

  it('admits unknown background updates conservatively and bounds edge-only fallback ids', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe(
      system('task_updated', { task_id: 'unknown', patch: { is_backgrounded: true } })
    )
    expect(tracker.stoppableTaskIds).toEqual(['unknown'])

    for (let index = 0; index < 400; index += 1) {
      tracker.observe(
        system('task_started', {
          task_id: `task-${index}`,
          task_type: 'local_agent',
          is_backgrounded: true
        })
      )
    }
    expect(tracker.stoppableTaskIds.length).toBeLessThanOrEqual(256)
  })

  it('bounds aggregate rosters and resets to the edge-only fallback on clear', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe(
      aggregate(
        Array.from({ length: 400 }, (_, index) => ({
          task_id: `aggregate-${index}`,
          task_type: 'local_bash',
          description: 'command'
        }))
      )
    )
    expect(tracker.stoppableTaskIds).toHaveLength(256)

    tracker.clear()
    tracker.observe(
      system('task_started', {
        task_id: 'edge-after-reset',
        task_type: 'local_agent',
        is_backgrounded: true
      })
    )
    expect(tracker.stoppableTaskIds).toEqual(['edge-after-reset'])
  })

  it('monitors an aggregate roster without waiting for the turn to finish', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe({ type: 'user' }, true)
    tracker.observe(
      aggregate([{ task_id: 'task-live', task_type: 'local_bash', description: 'command' }])
    )
    const running = {
      state: 'monitoring',
      tasks: [{ id: 'task-live', kind: 'command', description: 'command' }]
    }
    expect(tracker.state).toEqual(running)

    expect(tracker.observe(result())).toBe(false)
    expect(tracker.state).toEqual(running)
  })

  it('ignores ambient SDK tasks and clears all liveness when the session ends', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe(
      system('task_started', {
        task_id: 'ambient',
        task_type: 'monitor',
        is_backgrounded: true,
        ambient: true
      })
    )
    expect(tracker.state).toBeNull()
    tracker.observe(
      system('task_started', {
        task_id: 'task-live',
        task_type: 'local_agent',
        is_backgrounded: true
      })
    )
    expect(tracker.clear()).toBe(true)
    expect(tracker.state).toBeNull()
  })
})
