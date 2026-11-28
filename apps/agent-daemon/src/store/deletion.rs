//! Transactional removal of a Bot's Conversation and its derived data.

use anyhow::Result;
use rusqlite::Connection;
use uuid::Uuid;

use super::Store;

pub(super) fn initialize(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TRIGGER IF NOT EXISTS remove_unreferenced_attachment
         AFTER DELETE ON message_attachments
         WHEN NOT EXISTS (
             SELECT 1 FROM message_attachments WHERE attachment_id = OLD.attachment_id
         )
         BEGIN
             DELETE FROM attachments WHERE id = OLD.attachment_id;
         END;",
    )
}

impl Store {
    pub(crate) async fn delete_bot(&self, bot: Uuid) -> Result<bool> {
        let deleted = self
            .run(move |db| {
                let tx = db.connection.transaction()?;
                let key = bot.as_bytes();
                // Existing databases require an explicit message delete before removing the Bot.
                tx.execute("DELETE FROM messages WHERE bot_id = ?1", [key])?;
                let deleted = tx.execute("DELETE FROM bots WHERE id = ?1", [key])? != 0;
                tx.commit()?;
                Ok(deleted)
            })
            .await?;
        if deleted {
            self.2
                .send_modify(|deletions| *deletions = deletions.wrapping_add(1));
        }
        Ok(deleted)
    }
}
