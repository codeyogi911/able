export type HelpdeskQueueDiagnostics = {
  actionable: number
  unassigned: number
  oldestAgeSeconds: number | null
}

type CountRow = { value: number }
type OldestRow = { age_seconds: number | null }

export async function loadHelpdeskQueueDiagnostics(db: D1Database): Promise<HelpdeskQueueDiagnostics> {
  const [actionable, unassigned, oldest] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS value FROM cases WHERE status IN ('open', 'waiting_on_customer', 'on_hold')`).first<CountRow>(),
    db.prepare(`SELECT COUNT(*) AS value FROM cases WHERE status IN ('open', 'waiting_on_customer', 'on_hold') AND assignee_id IS NULL`).first<CountRow>(),
    db.prepare(
      `SELECT CAST((julianday('now') - julianday(MIN(opened_at))) * 86400 AS INTEGER) AS age_seconds
       FROM cases WHERE status IN ('open', 'waiting_on_customer', 'on_hold')`,
    ).first<OldestRow>(),
  ])
  return {
    actionable: actionable?.value ?? 0,
    unassigned: unassigned?.value ?? 0,
    oldestAgeSeconds: oldest?.age_seconds ?? null,
  }
}

export type HelpdeskSubjectCoordinate = {
  subjectType: string
  subjectId: string | null
}

/** Resolve Helpdesk subjects for generic platform read models, preserving order. */
export async function loadHelpdeskSubjectReferences(
  db: D1Database,
  subjects: readonly HelpdeskSubjectCoordinate[],
): Promise<Array<string | null>> {
  const publicIds = [...new Set(
    subjects
      .filter((subject) => subject.subjectType === 'case' && subject.subjectId)
      .map((subject) => subject.subjectId as string),
  )]
  if (publicIds.length === 0) return subjects.map(() => null)
  const placeholders = publicIds.map(() => '?').join(', ')
  const rows = await db.prepare(
    `SELECT public_id, ref FROM cases WHERE public_id IN (${placeholders})`,
  ).bind(...publicIds).all<{ public_id: string; ref: string }>()
  const references = new Map(rows.results.map((row) => [row.public_id, row.ref]))
  return subjects.map((subject) => (
    subject.subjectType === 'case' && subject.subjectId
      ? references.get(subject.subjectId) ?? null
      : null
  ))
}
