import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  resolveExistingDiffBase,
  resolvePullRequestDiffBase
} from './git-pull-request-diff-base.mjs'

// Flags a diff that changes what an EXISTING test expects, in the two areas where a
// silently-rewritten expectation shipped a user-visible break (#19542/#19684): the
// Playwright suite that does not gate PRs, and the orchestration RPC methods.
//
// Deliberately hunk-scoped and textual. Known false negative: a test deleted in one
// hunk and re-added in another reads as an unrelated delete plus add, so a full
// rewrite is not flagged. Renames are direction-blind, so restoring an old title is
// flagged too. Both cost one PR-body paragraph, which is the whole price of the gate.

const SCOPED_DIRECTORIES = ['tests/e2e/', 'src/main/runtime/rpc/methods/orchestration/']
const TEST_FILE_PATTERN = /\.(?:spec\.ts|test\.ts|test\.mjs)$/
const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/
const TEST_TITLE_PATTERN = /\b(?:test|it)(?:\.[\w.]+)*\s*\(\s*(['"`])([^'"`]*)\1/
// `toBeInstanceOf(Error)` and `toBeInstanceOf(RuntimeRpcFailureError)` both count.
const FAILURE_EXPECTATION = /toThrow|\.rejects\b|toBeInstanceOf\(\s*\w*Error\b/
// The removed side of a flip: the line that consumed a successful result.
const SUCCESS_PATH = /expect\(|await\s/
const EMPTY_EXPECTATION =
  /\.toEqual\(\s*[[{]\s*[\]}]\s*\)|\.toHaveLength\(\s*0\s*\)|\.toBeNull\(\s*\)|\.toBeUndefined\(\s*\)/
const NON_EMPTY_EXPECTATION =
  /toMatchObject|toContain|\.toHaveLength\(\s*[1-9]|\.toEqual\(\s*[[{](?!\s*[\]}]\s*\))/
const SECTION_HEADING = /^#{2,6}\s+User-visible change$/
const ANY_HEADING = /^#{1,6}\s+\S/

const INSTRUCTIONS = [
  'This change rewrites what an existing test expects. If that is intentional, the product',
  'behaviour it pins changed too, so say what a user sees. Add this to the PR body:',
  '',
  '  ## User-visible change',
  '  Before: <what the user got with the old expectation>',
  '  After: <what the user gets now>',
  '',
  'If nothing user-visible changed, the test is asserting something the product still does',
  'not do — restore the old expectation instead of the section.'
].join('\n')

export function isScopedTestFile(file) {
  return (
    SCOPED_DIRECTORIES.some((prefix) => file.startsWith(prefix)) && TEST_FILE_PATTERN.test(file)
  )
}

export function parseUnifiedDiffHunks(diff) {
  const hunks = []
  let file = null
  let hunk = null
  let newLine = 0
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith('+++ ')) {
      const target = raw.slice(4).trim()
      file = target === '/dev/null' ? null : target.replace(/^b\//, '')
      hunk = null
      continue
    }
    if (raw.startsWith('--- ')) {
      continue
    }
    const header = HUNK_HEADER_PATTERN.exec(raw)
    if (header) {
      newLine = Number.parseInt(header[1], 10)
      hunk = file === null ? null : { file, added: [], removed: [] }
      if (hunk !== null) {
        hunks.push(hunk)
      }
      continue
    }
    if (hunk === null) {
      continue
    }
    if (raw.startsWith('+')) {
      hunk.added.push({ line: newLine, text: raw.slice(1) })
      newLine += 1
    } else if (raw.startsWith('-')) {
      hunk.removed.push({ line: newLine, text: raw.slice(1) })
    } else if (!raw.startsWith('\\')) {
      newLine += 1
    }
  }
  return hunks
}

function codeLines(lines) {
  return lines.filter(({ text }) => !/^\s*(?:\/\/|\/\*|\*)/.test(text))
}

export function extractTestTitles(lines) {
  const titles = []
  for (const { line, text } of codeLines(lines)) {
    const match = TEST_TITLE_PATTERN.exec(text)
    if (match) {
      titles.push({ line, title: match[2] })
    }
  }
  return titles
}

export function findRenamedTests(hunk) {
  const removed = extractTestTitles(hunk.removed)
  const added = extractTestTitles(hunk.added)
  const removedTitles = new Set(removed.map((entry) => entry.title))
  const addedTitles = new Set(added.map((entry) => entry.title))
  const dropped = removed.filter((entry) => !addedTitles.has(entry.title))
  const introduced = added.filter((entry) => !removedTitles.has(entry.title))
  return dropped.slice(0, introduced.length).map((entry, index) => ({
    file: hunk.file,
    line: introduced[index].line,
    kind: 'renamed test',
    removed: entry.title,
    added: introduced[index].title
  }))
}

export function findFlippedToFailure(hunk) {
  const removed = codeLines(hunk.removed).find(
    ({ text }) => SUCCESS_PATH.test(text) && !FAILURE_EXPECTATION.test(text)
  )
  const added = codeLines(hunk.added).find(({ text }) => FAILURE_EXPECTATION.test(text))
  if (!removed || !added) {
    return []
  }
  return [
    {
      file: hunk.file,
      line: added.line,
      kind: 'flipped to expect-failure',
      removed: removed.text.trim(),
      added: added.text.trim()
    }
  ]
}

export function findEmptiedExpectations(hunk) {
  const removed = codeLines(hunk.removed).find(({ text }) => NON_EMPTY_EXPECTATION.test(text))
  const added = codeLines(hunk.added).find(({ text }) => EMPTY_EXPECTATION.test(text))
  if (!removed || !added) {
    return []
  }
  return [
    {
      file: hunk.file,
      line: added.line,
      kind: 'expectation emptied',
      removed: removed.text.trim(),
      added: added.text.trim()
    }
  ]
}

export function collectFindings(diff) {
  return parseUnifiedDiffHunks(diff)
    .filter((hunk) => isScopedTestFile(hunk.file))
    .flatMap((hunk) => [
      ...findRenamedTests(hunk),
      ...findFlippedToFailure(hunk),
      ...findEmptiedExpectations(hunk)
    ])
}

// Exact by design: `## User-visible changes` (plural) is not this section, and a
// pointer to it from some other heading is not the section either.
export function hasUserVisibleChangeSection(body) {
  const lines = (body ?? '').split(/\r?\n/)
  const start = lines.findIndex((line) => SECTION_HEADING.test(line.trim()))
  if (start === -1) {
    return false
  }
  let before = false
  let after = false
  for (const line of lines.slice(start + 1)) {
    if (ANY_HEADING.test(line.trim())) {
      break
    }
    const text = line.replace(/^[\s>]*(?:[-*+]\s+)?(?:\*\*|__|\*|_)?/, '')
    before ||= text.startsWith('Before:')
    after ||= text.startsWith('After:')
  }
  return before && after
}

export function formatFinding(finding) {
  return `${finding.file}:${finding.line}: ${finding.kind}: ${finding.removed} → ${finding.added}`
}

function annotationValue(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

function collectScopedDiff(root, requestedBase) {
  const base = resolveExistingDiffBase(root, requestedBase)
  const mergeBase = execFileSync('git', ['merge-base', base, 'HEAD'], {
    cwd: root,
    encoding: 'utf8'
  }).trim()
  return execFileSync(
    'git',
    [
      'diff',
      '--unified=0',
      '--no-color',
      resolvePullRequestDiffBase(root, mergeBase),
      '--',
      ...SCOPED_DIRECTORIES
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
}

function parseArguments(argv) {
  const options = { diffFile: null, requireBody: false, requestedBase: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--require-body') {
      options.requireBody = true
    } else if (argument.startsWith('--diff-file=')) {
      options.diffFile = argument.slice('--diff-file='.length)
    } else if (argument === '--diff-file') {
      index += 1
      options.diffFile = argv[index]
    } else if (argument !== '--' && !argument.startsWith('--') && !options.requestedBase) {
      options.requestedBase = argument
    }
  }
  return options
}

export function main(argv = process.argv.slice(2), root = process.cwd(), env = process.env) {
  const { diffFile, requireBody, requestedBase } = parseArguments(argv)
  const diff =
    diffFile === null
      ? collectScopedDiff(root, requestedBase)
      : readFileSync(diffFile === '-' ? 0 : diffFile, 'utf8')
  const findings = collectFindings(diff)
  if (findings.length === 0) {
    console.log('Flipped-assertion gate: no rewritten test expectations in the gated paths.')
    return 0
  }
  for (const finding of findings) {
    console.error(
      `::error file=${annotationValue(finding.file)},line=${finding.line},title=${annotationValue(finding.kind)}::${annotationValue(INSTRUCTIONS.split('\n')[0])}`
    )
    console.error(formatFinding(finding))
  }
  if (hasUserVisibleChangeSection(env.PR_BODY)) {
    console.log(
      `Flipped-assertion gate: ${findings.length} rewritten expectation(s), explained by the PR body's "## User-visible change" section.`
    )
    return 0
  }
  console.error('')
  console.error(INSTRUCTIONS)
  if (requireBody) {
    return 1
  }
  console.log(
    'Reporting only: CI passes --require-body, which turns the findings above into a failure.'
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
