import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readCustomLanguages } from './read-custom-languages'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-languages-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})
const grammar = (scopeName: string) => ({
  scopeName,
  patterns: [{ name: 'keyword.control', match: '\\blet\\b' }]
})
async function json(path: string, value: unknown): Promise<void> {
  await writeFile(join(dir, path), JSON.stringify(value))
}
async function extension(): Promise<void> {
  await mkdir(join(dir, 'extension'))
  await json('extension/package.json', {
    main: './must-not-run.js',
    contributes: {
      languages: [
        { id: 'ExampleLang', extensions: ['.examplelang'], configuration: './configuration.json' }
      ],
      grammars: [
        { language: 'ExampleLang', scopeName: 'source.examplelang', path: './examplelang.json' }
      ]
    }
  })
  await json('extension/examplelang.json', grammar('source.examplelang'))
  await writeFile(
    join(dir, 'extension/configuration.json'),
    `{
    // VS Code configuration supports comments and tuple pairs.
    "comments": { "lineComment": { "comment": "//" } },
    "autoClosingPairs": [["{", "}"]],
  }`
  )
  await writeFile(
    join(dir, 'extension/must-not-run.js'),
    'throw new Error("Extension code executed")'
  )
}

describe('readCustomLanguages', () => {
  it('returns an empty configuration when no file exists', async () => {
    expect(await readCustomLanguages(join(dir, 'languages.json'))).toEqual({
      languages: [],
      grammars: {},
      diagnostics: []
    })
  })

  it('imports extension metadata, JSONC configuration, and dependency grammars without executing code', async () => {
    await extension()
    await json('typescript.json', grammar('source.ts'))
    await json('languages.json', { extensions: ['./extension'], grammars: ['./typescript.json'] })
    const result = await readCustomLanguages(join(dir, 'languages.json'))
    expect(result.diagnostics).toEqual([])
    expect(Object.keys(result.grammars)).toEqual(['source.examplelang', 'source.ts'])
    expect(result.languages).toEqual([
      {
        id: 'ExampleLang',
        extensions: ['.examplelang'],
        scopeName: 'source.examplelang',
        configuration: {
          comments: { lineComment: '//' },
          autoClosingPairs: [{ open: '{', close: '}' }]
        }
      }
    ])
  })

  it('keeps valid direct registrations when neighboring entries are invalid', async () => {
    await json('valid.json', grammar('source.valid'))
    await json('languages.json', {
      languages: [
        { id: 'bad', grammar: './missing.json' },
        { id: 'valid', grammar: './valid.json', filenames: ['Specialfile'], extensions: ['.valid'] }
      ]
    })
    const result = await readCustomLanguages(join(dir, 'languages.json'))
    expect(result.languages.map((language) => language.id)).toEqual(['valid'])
    expect(result.diagnostics).toHaveLength(1)
  })

  it('releases the scope and byte budget when direct configuration fails', async () => {
    await json('retry.json', { ...grammar('source.retry'), padding: ' '.repeat(4 * 1024 * 1024) })
    await writeFile(join(dir, 'invalid-config.json'), '{ invalid')
    await json('languages.json', {
      languages: [
        ...Array.from({ length: 4 }, () => ({
          id: 'retry',
          grammar: './retry.json',
          configuration: './invalid-config.json'
        })),
        { id: 'retry', grammar: './retry.json', extensions: ['.retry'] }
      ]
    })
    const result = await readCustomLanguages(join(dir, 'languages.json'))
    expect(result.diagnostics).toHaveLength(4)
    expect(result.diagnostics.every((message) => message.includes('Invalid JSON'))).toBe(true)
    expect(result.languages.map((language) => language.id)).toEqual(['retry'])
    expect(Object.keys(result.grammars)).toEqual(['source.retry'])
  })

  it('releases a rejected duplicate language grammar without changing the existing language', async () => {
    await extension()
    await json('retry.json', grammar('source.retry'))
    await json('languages.json', {
      extensions: ['./extension'],
      languages: [
        { id: 'ExampleLang', grammar: './retry.json' },
        { id: 'retry', grammar: './retry.json', extensions: ['.retry'] }
      ]
    })
    const result = await readCustomLanguages(join(dir, 'languages.json'))
    expect(result.diagnostics).toEqual(['Custom language: Duplicate language id ExampleLang'])
    expect(result.languages.map((language) => language.id)).toEqual(['ExampleLang', 'retry'])
    expect(Object.keys(result.grammars)).toEqual(['source.examplelang', 'source.retry'])
  })

  it('rejects extension grammar paths outside the extension directory', async () => {
    await extension()
    await json('outside.json', grammar('source.examplelang'))
    await json('extension/package.json', {
      contributes: {
        languages: [{ id: 'ExampleLang', extensions: ['.examplelang'] }],
        grammars: [
          { language: 'ExampleLang', scopeName: 'source.examplelang', path: '../outside.json' }
        ]
      }
    })
    await json('languages.json', { extensions: ['./extension'] })
    const result = await readCustomLanguages(join(dir, 'languages.json'))
    expect(result.languages).toEqual([])
    expect(result.diagnostics[0]).toContain('escapes its directory')
  })

  it('reports malformed JSON and scope mismatches without throwing', async () => {
    await writeFile(join(dir, 'languages.json'), '{ nope')
    expect((await readCustomLanguages(join(dir, 'languages.json'))).diagnostics[0]).toContain(
      'Invalid JSON'
    )
    await json('valid.json', grammar('source.actual'))
    await json('languages.json', {
      languages: [{ id: 'bad', grammar: './valid.json', scopeName: 'source.expected' }]
    })
    const result = await readCustomLanguages(join(dir, 'languages.json'))
    expect(result.languages).toEqual([])
    expect(result.diagnostics[0]).toContain('Expected scope source.expected, found source.actual')
  })

  it.skipIf(process.platform === 'win32')(
    'rejects extension resources that escape through symlinks',
    async () => {
      await extension()
      await rm(join(dir, 'extension/examplelang.json'))
      await json('outside.json', grammar('source.examplelang'))
      await symlink(join(dir, 'outside.json'), join(dir, 'extension/examplelang.json'))
      await json('languages.json', { extensions: ['./extension'] })
      const result = await readCustomLanguages(join(dir, 'languages.json'))
      expect(result.languages).toEqual([])
      expect(result.diagnostics[0]).toContain('escapes its directory')
    }
  )

  it('reports duplicate scopes and preserves the first grammar', async () => {
    await json('first.json', grammar('source.same'))
    await json('second.json', { scopeName: 'source.same', patterns: [] })
    await json('languages.json', { grammars: ['./first.json', './second.json'] })
    const result = await readCustomLanguages(join(dir, 'languages.json'))
    expect(result.diagnostics[0]).toContain('Duplicate grammar scope source.same')
    expect(result.grammars['source.same'].patterns).toHaveLength(1)
  })

  it('rejects oversized grammar files', async () => {
    await writeFile(join(dir, 'large.json'), ' '.repeat(5 * 1024 * 1024 + 1))
    await json('languages.json', { grammars: ['./large.json'] })
    expect((await readCustomLanguages(join(dir, 'languages.json'))).diagnostics[0]).toContain(
      'smaller than 5 MiB'
    )
  })
})
