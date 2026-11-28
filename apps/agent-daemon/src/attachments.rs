//! Conversation attachment storage and conversion to Rig Inbox parts.

use std::io::Cursor;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use image::codecs::{gif::GifDecoder, png::PngDecoder, webp::WebPDecoder};
use image::{AnimationDecoder, DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use rig_core::catalog::ModelSpec;
use rig_core::message::{ImageMediaType, UserContent};
use rig_ecs::inbox::Attachment as RigAttachment;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub(crate) const MAX_ATTACHMENTS: usize = 8;
const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_IMAGE_BYTES: usize = 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 2048;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Input {
    Inline {
        name: String,
        #[serde(rename = "mediaType")]
        media_type: String,
        content: Option<String>,
    },
    Reference {
        id: Uuid,
    },
}

impl Input {
    pub(crate) fn valid_metadata(&self) -> bool {
        match self {
            Self::Inline {
                name, media_type, ..
            } => {
                !name.trim().is_empty()
                    && name.len() <= 255
                    && !name.contains(['/', '\\'])
                    && !name.chars().any(char::is_control)
                    && media_type.len() <= 127
                    && media_type.split_once('/').is_some_and(|(kind, subtype)| {
                        !kind.is_empty()
                            && !subtype.is_empty()
                            && [kind, subtype].into_iter().all(|part| {
                                part.bytes().all(|byte| {
                                    byte.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&byte)
                                })
                            })
                    })
            }
            Self::Reference { .. } => true,
        }
    }

    pub(crate) fn prepare(self) -> Submission {
        match self {
            Self::Reference { id } => Submission::Reference(id),
            Self::Inline {
                name,
                media_type,
                content,
            } => {
                let content = content.and_then(|content| validated_content(&media_type, content));
                Submission::Inline(Stored {
                    metadata: Metadata {
                        id: Uuid::new_v4(),
                        name,
                        media_type,
                        available: content.is_some(),
                    },
                    content,
                })
            }
        }
    }
}

pub(crate) enum Submission {
    Inline(Stored),
    Reference(Uuid),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Metadata {
    pub(crate) id: Uuid,
    pub(crate) name: String,
    pub(crate) media_type: String,
    pub(crate) available: bool,
}

pub(crate) struct Stored {
    pub(crate) metadata: Metadata,
    pub(crate) content: Option<Vec<u8>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Warning {
    attachment_id: Uuid,
    code: &'static str,
    message: &'static str,
}

impl Stored {
    pub(crate) fn into_part(self, model: &ModelSpec) -> Result<RigAttachment, Warning> {
        let Metadata {
            id,
            name,
            media_type,
            ..
        } = self.metadata;
        let warning = |code, message| Warning {
            attachment_id: id,
            code,
            message,
        };
        let unavailable = || {
            warning(
                "attachment_unavailable",
                "attachment content is missing, invalid, or exceeds its limits",
            )
        };
        let content = if media_type == "text/plain" {
            let text = self
                .content
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .ok_or_else(unavailable)?;
            UserContent::text(text)
        } else {
            let Some((_, image_type)) = image_type(&media_type) else {
                return Err(warning(
                    "attachment_format_unsupported",
                    "the daemon does not support this attachment format",
                ));
            };
            let bytes = self.content.ok_or_else(unavailable)?;
            if !model.input.image {
                return Err(warning(
                    "attachment_model_unsupported",
                    "the selected model does not accept image attachments",
                ));
            }
            UserContent::image_base64(STANDARD.encode(bytes), Some(image_type), None)
        };
        Ok(RigAttachment {
            label: name,
            content,
        })
    }
}

pub(crate) fn insert(db: &Connection, attachment: &Stored) -> rusqlite::Result<()> {
    let metadata = &attachment.metadata;
    db.execute(
        "INSERT INTO attachments (id, name, media_type, content) VALUES (?1, ?2, ?3, ?4)",
        params![
            metadata.id.as_bytes(),
            metadata.name,
            metadata.media_type,
            attachment.content
        ],
    )?;
    Ok(())
}

pub(crate) fn associate(
    db: &Connection,
    message: i64,
    position: usize,
    attachment: Uuid,
) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO message_attachments (message_id, position, attachment_id) VALUES (?1, ?2, ?3)",
        params![message, position, attachment.as_bytes()],
    )?;
    Ok(())
}

pub(crate) fn for_bot(db: &Connection, bot: Uuid, id: Uuid) -> rusqlite::Result<Option<Stored>> {
    db.prepare_cached(
        "SELECT a.id, a.name, a.media_type, a.content IS NOT NULL, a.content
         FROM attachments a
         WHERE a.id = ?1 AND EXISTS (
             SELECT 1 FROM message_attachments ma JOIN messages m ON m.id = ma.message_id
             WHERE ma.attachment_id = a.id AND m.bot_id = ?2
         )",
    )?
    .query_row(params![id.as_bytes(), bot.as_bytes()], stored)
    .optional()
}

pub(crate) fn for_message(db: &Connection, message: i64) -> rusqlite::Result<Vec<Stored>> {
    db.prepare_cached(
        "SELECT a.id, a.name, a.media_type, a.content IS NOT NULL, a.content
         FROM message_attachments ma JOIN attachments a ON a.id = ma.attachment_id
         WHERE ma.message_id = ?1 ORDER BY ma.position",
    )?
    .query_map([message], stored)?
    .collect()
}

fn stored(row: &Row<'_>) -> rusqlite::Result<Stored> {
    Ok(Stored {
        metadata: metadata(row)?,
        content: row.get(4)?,
    })
}

pub(crate) fn visit_conversation(
    db: &Connection,
    bot: Uuid,
    mut visit: impl FnMut(i64, Metadata),
) -> rusqlite::Result<()> {
    let mut statement = db.prepare_cached(
        "SELECT a.id, a.name, a.media_type, a.content IS NOT NULL, ma.message_id
         FROM messages m JOIN message_attachments ma ON ma.message_id = m.id
         JOIN attachments a ON a.id = ma.attachment_id
         WHERE m.bot_id = ?1 ORDER BY ma.message_id, ma.position",
    )?;
    let mut rows = statement.query([bot.as_bytes()])?;
    while let Some(row) = rows.next()? {
        visit(row.get(4)?, metadata(row)?);
    }
    Ok(())
}

fn metadata(row: &Row<'_>) -> rusqlite::Result<Metadata> {
    Ok(Metadata {
        id: Uuid::from_bytes(row.get(0)?),
        name: row.get(1)?,
        media_type: row.get(2)?,
        available: row.get(3)?,
    })
}

fn image_type(media_type: &str) -> Option<(ImageFormat, ImageMediaType)> {
    match media_type {
        "image/png" => Some((ImageFormat::Png, ImageMediaType::PNG)),
        "image/jpeg" => Some((ImageFormat::Jpeg, ImageMediaType::JPEG)),
        "image/gif" => Some((ImageFormat::Gif, ImageMediaType::GIF)),
        "image/webp" => Some((ImageFormat::WebP, ImageMediaType::WEBP)),
        _ => None,
    }
}

fn validated_content(media_type: &str, content: String) -> Option<Vec<u8>> {
    if media_type == "text/plain" {
        return (!content.trim().is_empty()
            && content.len() <= MAX_TEXT_BYTES
            && !content.contains('\0'))
        .then(|| content.into_bytes());
    }
    let (format, _) = image_type(media_type)?;
    if content.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
        return None;
    }
    let bytes = STANDARD.decode(content).ok()?;
    if bytes.len() > MAX_IMAGE_BYTES || image::guess_format(&bytes).ok()? != format {
        return None;
    }
    valid_image(format, &bytes).then_some(bytes)
}

fn valid_image(format: ImageFormat, bytes: &[u8]) -> bool {
    let input = Cursor::new(bytes);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(64 * 1024 * 1024);
    match format {
        ImageFormat::Gif => GifDecoder::new(input).is_ok_and(|mut decoder| {
            if decoder.set_limits(limits).is_err() {
                return false;
            }
            let mut frames = decoder.into_frames();
            frames.next().is_some_and(|frame| frame.is_ok()) && frames.next().is_none()
        }),
        ImageFormat::Png => PngDecoder::with_limits(input, limits).is_ok_and(|decoder| {
            matches!(decoder.is_apng(), Ok(false)) && DynamicImage::from_decoder(decoder).is_ok()
        }),
        ImageFormat::WebP => WebPDecoder::new(input).is_ok_and(|mut decoder| {
            !decoder.has_animation()
                && decoder.set_limits(limits).is_ok()
                && DynamicImage::from_decoder(decoder).is_ok()
        }),
        _ => {
            let mut reader = ImageReader::with_format(input, format);
            reader.limits(limits);
            reader.decode().is_ok()
        }
    }
}
