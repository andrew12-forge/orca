import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../../sqlite/sync-database'
import { resolveOrchestrationMigrationStartVersion } from '../orchestration-schema-version-skew'
import { LEGACY_RUN_ID, SCHEMA_VERSION, federatedStubHomeRunId } from './contract-constants'
import { OrchestrationDb } from './orchestration-db'

/**
 * Opens real SQLite files written by real release tags.
 *
 * orchestration-all-start-versions-migration.test.ts builds the CURRENT schema and stamps
 * user_version backwards, so a migration that forgets its ALTER TABLE still passes there: the
 * column was already present. These fixtures were produced by running each tag's own
 * OrchestrationDb (tests/fixtures/orchestration-db/generate-fixtures.mjs), so a forgotten column
 * is genuinely absent and the open fails. See that directory's README.md.
 */

type FixtureMessage = { id: string; to: string; read: number; run_id: string }

type Fixture = {
  tag: string
  commit: string
  userVersion: number
  sha256: string
  populateShape: { dispatchArguments: string; attachmentCarriesRunId: boolean }
  expected: {
    runIds: string[]
    taskIds: string[]
    dispatchIds: string[]
    messages: FixtureMessage[]
    legacyAdoptionsCount: number
    attachments: { dispatchId: string; taskId: string }[]
    tableRowCounts: Record<string, number>
  }
}

const FIXTURE_DIR = join(__dirname, '..', '..', '..', '..', '..', 'tests', 'fixtures')
const ORCHESTRATION_FIXTURE_DIR = join(FIXTURE_DIR, 'orchestration-db')

const fixtures: Fixture[] = (
  JSON.parse(readFileSync(join(ORCHESTRATION_FIXTURE_DIR, 'manifest.json'), 'utf8')) as {
    fixtures: Fixture[]
  }
).fixtures

function fixturePath(tag: string): string {
  return join(ORCHESTRATION_FIXTURE_DIR, `${tag}.sqlite`)
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * `user_version` straight out of the SQLite file header (offset 60, big-endian).
 *
 * Opening a WAL database leaves `-wal` and `-shm` beside it even read-only, and nothing in a test
 * may write next to a committed fixture. Every other read here happens on a temp-dir copy.
 */
function storedUserVersion(path: string): number {
  return readFileSync(path).readUInt32BE(60)
}

type DatabaseShape = { objects: string[]; rowCounts: Record<string, number> }

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string
    }[]
  ).map((row) => row.name)
}

function databaseShape(db: Database.Database): DatabaseShape {
  const objects = (
    db
      .prepare("SELECT type || ' ' || name || ' ' || COALESCE(sql, '') AS entry FROM sqlite_master")
      .all() as { entry: string }[]
  )
    .map((row) => row.entry)
    .sort()
  const rowCounts: Record<string, number> = {}
  for (const name of tableNames(db)) {
    rowCounts[name] = (
      db.prepare(`SELECT COUNT(*) AS total FROM "${name}"`).get() as { total: number }
    ).total
  }
  return { objects, rowCounts }
}

/**
 * Column sets and index/trigger SQL, compared as sets.
 *
 * ALTER TABLE appends, so a migrated table's stored CREATE SQL and column order never match a
 * freshly created one even when the schemas agree. What must agree is which columns exist and
 * how they are declared.
 */
function schemaFingerprint(db: Database.Database): Record<string, string[]> {
  const fingerprint: Record<string, string[]> = {}
  for (const name of tableNames(db)) {
    if (name === 'sqlite_sequence') {
      continue
    }
    const columns = db.pragma(`table_info(${name})`) as {
      name: string
      type: string
      notnull: number
      dflt_value: unknown
      pk: number
    }[]
    fingerprint[`table ${name}`] = columns
      .map(
        (column) =>
          `${column.name} ${column.type} notnull=${column.notnull} pk=${column.pk} default=${String(column.dflt_value)}`
      )
      .sort()
  }
  const rest = db
    .prepare(
      `SELECT type, name, COALESCE(sql, '') AS sql FROM sqlite_master
       WHERE type IN ('index', 'trigger', 'view') AND name NOT LIKE 'sqlite_autoindex_%'`
    )
    .all() as { type: string; name: string; sql: string }[]
  for (const entry of rest) {
    fingerprint[`${entry.type} ${entry.name}`] = [entry.sql.replace(/\s+/g, ' ').trim()]
  }
  return fingerprint
}

/** The Run a fixture row ends up under. Legacy-Run rows are adopted into a new Run on upgrade. */
function migratedRunId(db: OrchestrationDb, recordedRunId: string): string {
  if (recordedRunId !== LEGACY_RUN_ID) {
    return recordedRunId
  }
  const adoption = db.db
    .prepare('SELECT adopted_run_id FROM legacy_adoptions WHERE source_run_id = ?')
    .get(LEGACY_RUN_ID) as { adopted_run_id: string } | undefined
  expect(adoption, 'legacy graph must be adopted into a real Run').toBeDefined()
  return adoption?.adopted_run_id ?? ''
}

describe('shipped-schema orchestration fixtures', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function openCopy(tag: string): { path: string; db: OrchestrationDb } {
    const dir = mkdtempSync(join(tmpdir(), `orca-shipped-${tag}-`))
    tempDirs.push(dir)
    const path = join(dir, 'orchestration.db')
    copyFileSync(fixturePath(tag), path)
    return { path, db: new OrchestrationDb(path) }
  }

  function freshSchemaFingerprint(): Record<string, string[]> {
    const dir = mkdtempSync(join(tmpdir(), 'orca-shipped-fresh-'))
    tempDirs.push(dir)
    const fresh = new OrchestrationDb(join(dir, 'orchestration.db'))
    try {
      return schemaFingerprint(fresh.db)
    } finally {
      fresh.close()
    }
  }

  it('has a manifest entry for every committed fixture', () => {
    expect(fixtures.map((fixture) => fixture.tag)).toEqual([
      'v1.4.180',
      'v1.4.190',
      'v1.4.198',
      'v1.4.199'
    ])
    for (const fixture of fixtures) {
      expect(sha256(fixturePath(fixture.tag)), `${fixture.tag} bytes`).toBe(fixture.sha256)
      expect(storedUserVersion(fixturePath(fixture.tag)), `${fixture.tag} user_version`).toBe(
        fixture.userVersion
      )
      expect(fixture.userVersion, `${fixture.tag} predates the current schema`).toBeLessThanOrEqual(
        SCHEMA_VERSION
      )
    }
  })

  for (const fixture of fixtures) {
    const { tag, expected } = fixture

    it(`migrates ${tag} to the schema a fresh install creates`, () => {
      const expectedFingerprint = freshSchemaFingerprint()
      const { db } = openCopy(tag)
      try {
        expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
        // The stamp is not the schema: a migration that forgets a column still stamps 40.
        expect(schemaFingerprint(db.db)).toEqual(expectedFingerprint)
      } finally {
        db.close()
      }
    })

    it(`keeps every ${tag} row addressable after migration`, () => {
      const { db } = openCopy(tag)
      try {
        for (const runId of expected.runIds) {
          expect(db.getRun(runId), `${tag} run ${runId}`).toMatchObject({ id: runId })
        }
        for (const taskId of expected.taskIds) {
          expect(db.getTask(taskId), `${tag} task ${taskId}`).toMatchObject({ id: taskId })
        }
        for (const dispatchId of expected.dispatchIds) {
          expect(
            db.getDispatchContextById(dispatchId),
            `${tag} dispatch ${dispatchId}`
          ).toMatchObject({ id: dispatchId })
        }

        for (const message of expected.messages) {
          const row = db.db
            .prepare('SELECT to_handle, read, run_id FROM messages WHERE id = ?')
            .get(message.id) as { to_handle: string; read: number; run_id: string } | undefined
          expect(row, `${tag} message ${message.id}`).toBeDefined()
          expect(row?.to_handle, `${tag} message ${message.id} recipient`).toBe(message.to)
          expect(row?.read, `${tag} message ${message.id} read flag`).toBe(message.read)
          expect(row?.run_id, `${tag} message ${message.id} Run`).toBe(
            migratedRunId(db, message.run_id)
          )
        }

        for (const attachment of expected.attachments) {
          const row = db.getRemoteDispatchAttachment(attachment.dispatchId)
          expect(row, `${tag} attachment ${attachment.dispatchId}`).toMatchObject({
            task_id: attachment.taskId
          })
          // v40 gives a pre-federation attachment a stub home Run so its control mail still files.
          const homeRunId = fixture.populateShape.attachmentCarriesRunId
            ? expected.runIds[0]
            : federatedStubHomeRunId(attachment.dispatchId)
          expect(row?.home_run_id, `${tag} attachment home Run`).toBe(homeRunId)
          expect(db.getRunRaw(homeRunId), `${tag} home Run ${homeRunId}`).toBeDefined()
        }
      } finally {
        db.close()
      }
    })

    it(`adopts the legacy graph in ${tag} exactly once and reopens unchanged`, () => {
      const { path, db } = openCopy(tag)
      const adoptsLegacyGraph = expected.messages.some(
        (message) => message.run_id === LEGACY_RUN_ID
      )
      let firstShape: DatabaseShape
      try {
        const adoptions = (
          db.db.prepare('SELECT COUNT(*) AS total FROM legacy_adoptions').get() as { total: number }
        ).total
        expect(adoptions, `${tag} legacy_adoptions rows`).toBe(
          expected.legacyAdoptionsCount + (adoptsLegacyGraph ? 1 : 0)
        )
        expect(
          resolveOrchestrationMigrationStartVersion(db.db, SCHEMA_VERSION, SCHEMA_VERSION),
          `${tag} start version after upgrade`
        ).toBe(SCHEMA_VERSION)
        firstShape = databaseShape(db.db)
      } finally {
        db.close()
      }

      const reopened = new OrchestrationDb(path)
      try {
        expect(databaseShape(reopened.db), `${tag} reopen shape`).toEqual(firstShape)
        expect(reopened.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
        expect(
          resolveOrchestrationMigrationStartVersion(reopened.db, SCHEMA_VERSION, SCHEMA_VERSION),
          `${tag} start version on reopen`
        ).toBe(SCHEMA_VERSION)
      } finally {
        reopened.close()
      }

      expect(sha256(fixturePath(tag)), `${tag} committed fixture must not be written`).toBe(
        fixture.sha256
      )
    })
  }
})
