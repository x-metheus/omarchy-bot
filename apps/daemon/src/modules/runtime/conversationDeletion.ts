import { Database } from "bun:sqlite";

const conversationDocuments = `SELECT id FROM pi_documents
  WHERE (scope_kind = 'conversation' AND owner_id = ?1)
     OR (scope_kind = 'task' AND owner_id IN (SELECT id FROM pi_tasks WHERE conversation_id = ?1))`;

// pi-durable 1.5.2. Delete ID claims and document revisions before their owning rows.
const conversationPredicates = {
  pi_record_ids: `id IN (
    SELECT id FROM pi_conversations WHERE id = ?1
    UNION ALL SELECT id FROM pi_entries WHERE conversation_id = ?1
    UNION ALL SELECT id FROM pi_tasks WHERE conversation_id = ?1
    UNION ALL SELECT id FROM pi_submissions WHERE conversation_id = ?1
    UNION ALL ${conversationDocuments}
  )`,
  pi_document_revisions: `document_id IN (${conversationDocuments})`,
  pi_documents: `id IN (${conversationDocuments})`,
  pi_submissions: "conversation_id = ?1",
  pi_tasks: "conversation_id = ?1",
  pi_entries: "conversation_id = ?1",
  pi_conversations: "id = ?1",
  // Schema version and ID/sequence allocation are shared by all conversations.
  pi_durable_metadata: null,
  pi_durable_schema: null,
};

export const durableConversationTables: ReadonlySet<string> = new Set(Object.keys(conversationPredicates));

/** Permanently remove one quiesced conversation from pi-durable, joining the caller's transaction if present. */
export function deleteConversation(db: Database, conversationId: number): void {
  db.transaction(() => {
    const tables = db.query<{ name: string }, []>(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name GLOB 'pi_*'
        AND name NOT IN ('pi_thread_conversations', 'pi_turn_submissions')
      ORDER BY name
    `).all();
    const unknown = tables.filter(({ name }) => !durableConversationTables.has(name));
    if (unknown.length > 0) {
      throw new Error(`Unknown pi-durable tables: ${unknown.map(({ name }) => name).join(", ")}`);
    }

    for (const [table, predicate] of Object.entries(conversationPredicates)) {
      if (predicate !== null) db.query(`DELETE FROM ${table} WHERE ${predicate}`).run(conversationId);
    }
  }).immediate();
}

function findOrphanedConversations(serviceDb: Database, durableDb: Database): { id: number }[] {
  if (serviceDb === durableDb) {
    return durableDb.query<{ id: number }, []>(`
      SELECT id FROM pi_conversations
      EXCEPT SELECT conversation_id FROM pi_thread_conversations
    `).all();
  }
  const mapped = new Set(serviceDb.query<{ conversation_id: number }, []>(
    "SELECT conversation_id FROM pi_thread_conversations",
  ).all().map(({ conversation_id }) => conversation_id));
  return durableDb.query<{ id: number }, []>("SELECT id FROM pi_conversations").all().filter(({ id }) => !mapped.has(id));
}

/** Sweep initialized storage in the runtime writer before opening the Harness. */
export function sweepOrphanedConversations(serviceDb: Database, dbPath: string): number {
  using separateDurableDb = serviceDb.filename === dbPath ? undefined : new Database(dbPath, { readwrite: true });
  const durableDb = separateDurableDb ?? serviceDb;
  if (findOrphanedConversations(serviceDb, durableDb).length === 0) return 0;
  return durableDb.transaction(() => {
    const orphans = findOrphanedConversations(serviceDb, durableDb);
    for (const { id } of orphans) deleteConversation(durableDb, id);
    return orphans.length;
  }).immediate();
}
