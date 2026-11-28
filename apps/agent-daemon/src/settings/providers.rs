//! Saved OpenAI-compatible Responses connections and model discovery.

mod responses;

use std::sync::LazyLock;
use std::time::{Duration, Instant};

use anyhow::Context;
use reqwest::StatusCode;
use rig_core::completion::ReplayTarget;
use rig_core::error::ProviderError;
use rig_core::model::ModelList;
use rig_core::providers::openai::{OpenAI, OpenAIConfig, wire::Auth};
use rig_core::serve::adapters::ModelAdapter;
use rig_core::wire::Secret;
use rig_reqwest::ReqwestClient;
use ring::aead;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use self::responses::ResponsesHandler;

use super::{
    ConfiguredModel, Provider, Selection, Settings, Source, base_url, deserialize_key,
    model_connection, open_key, seal_key, valid_header_token, valid_model,
};

const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(10);

static HTTP: LazyLock<Result<ReqwestClient, reqwest::Error>> = LazyLock::new(|| {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(DISCOVERY_TIMEOUT)
        .build()?;
    Ok(ReqwestClient::from(client))
});

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Authentication {
    ApiKey,
    None,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DiscoveryInput {
    base_url: String,
    authentication: Authentication,
    #[serde(default, deserialize_with = "deserialize_key")]
    api_key: Option<Secret>,
    id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveInput {
    name: String,
    model: String,
    base_url: String,
    authentication: Authentication,
    #[serde(default, deserialize_with = "deserialize_key")]
    api_key: Option<Secret>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Configuration {
    id: Uuid,
    name: String,
    base_url: String,
    authentication: Authentication,
    model: String,
    has_api_key: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    configurations: Vec<Configuration>,
    current_id: Option<Uuid>,
}

#[derive(Debug)]
pub(crate) enum Error {
    Storage,
    ReadOnly,
    NotFound,
    Changed,
    InvalidName,
    InvalidBaseUrl,
    InvalidKey,
    CredentialRequired,
    UnexpectedKey,
    InvalidModel,
    ModelUnavailable,
    DiscoveryFailed,
    AuthenticationFailed,
    DiscoveryTimeout,
}

impl From<anyhow::Error> for Error {
    fn from(_: anyhow::Error) -> Self {
        Self::Storage
    }
}

impl From<rusqlite::Error> for Error {
    fn from(_: rusqlite::Error) -> Self {
        Self::Storage
    }
}

pub(crate) struct PreparedSave {
    id: Option<Uuid>,
    revision: Option<i64>,
    name: String,
    model: String,
    client: OpenAI,
}

pub(crate) enum Mutation {
    Save(Box<ValidatedSave>),
    Activate(Uuid),
}

pub(crate) struct ValidatedSave(PreparedSave);

impl PreparedSave {
    pub(crate) async fn validate(self) -> Result<Mutation, Error> {
        if !list_models(&self.client)
            .await?
            .iter()
            .any(|model| model.id == self.model)
        {
            return Err(Error::ModelUnavailable);
        }
        Ok(Mutation::Save(Box::new(ValidatedSave(self))))
    }
}

struct Saved {
    base_url: String,
    model: String,
    sealed_key: Option<Vec<u8>>,
    revision: i64,
}

impl Saved {
    fn read(db: &Connection, id: Uuid) -> rusqlite::Result<Option<Self>> {
        db.query_row(
            "SELECT base_url, model, sealed_key, revision FROM provider_configurations WHERE id = ?1",
            [id.as_bytes()],
            |row| Ok(Self {
                base_url: row.get(0)?,
                model: row.get(1)?,
                sealed_key: row.get(2)?,
                revision: row.get(3)?,
            }),
        ).optional()
    }

    fn credential(
        &mut self,
        id: Uuid,
        master_key: Option<&aead::LessSafeKey>,
    ) -> anyhow::Result<Option<Secret>> {
        self.sealed_key
            .take()
            .map(|sealed| {
                let master_key =
                    master_key.context("saved Settings require OMARCHY_AGENT_MASTER_KEY_FILE")?;
                open_key(master_key, &credential_identity(id, &self.base_url), sealed)
            })
            .transpose()
    }

    fn connect(
        mut self,
        id: Uuid,
        master_key: Option<&aead::LessSafeKey>,
    ) -> anyhow::Result<ConfiguredModel> {
        let key = self.credential(id, master_key)?;
        Ok(responses_connection(
            client(self.base_url, key)?,
            self.model,
            id,
            self.revision,
        ))
    }
}

pub(crate) fn initialize(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS provider_configurations (
            id BLOB PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            model TEXT NOT NULL,
            sealed_key BLOB,
            revision INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS current_provider_configuration (
            slot INTEGER PRIMARY KEY CHECK (slot = 1),
            configuration_id BLOB NOT NULL REFERENCES provider_configurations(id)
        );",
    )
}

fn current_id(db: &Connection) -> rusqlite::Result<Option<Uuid>> {
    db.query_row(
        "SELECT configuration_id FROM current_provider_configuration WHERE slot = 1",
        [],
        |row| Ok(Uuid::from_bytes(row.get(0)?)),
    )
    .optional()
}

pub(super) fn restore_current(
    db: &Connection,
    master_key: Option<&aead::LessSafeKey>,
) -> anyhow::Result<Option<ConfiguredModel>> {
    current_id(db)?
        .map(|id| {
            Saved::read(db, id)?
                .context("saved Settings reference an unknown provider configuration")?
                .connect(id, master_key)
        })
        .transpose()
}

pub(crate) fn status(db: &Connection) -> rusqlite::Result<Status> {
    let mut query = db.prepare_cached(
        "SELECT id, name, base_url, model, sealed_key IS NOT NULL
         FROM provider_configurations ORDER BY name COLLATE NOCASE, id",
    )?;
    let configurations = query
        .query_map([], |row| {
            let has_api_key = row.get(4)?;
            Ok(Configuration {
                id: Uuid::from_bytes(row.get(0)?),
                name: row.get(1)?,
                base_url: row.get(2)?,
                model: row.get(3)?,
                authentication: if has_api_key {
                    Authentication::ApiKey
                } else {
                    Authentication::None
                },
                has_api_key,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Status {
        configurations,
        current_id: current_id(db)?,
    })
}

impl Settings {
    pub(crate) fn prepare_discovery(
        &self,
        db: &Connection,
        input: DiscoveryInput,
    ) -> Result<OpenAI, Error> {
        let (client, _) = self.prepare_client(
            db,
            input.id,
            &input.base_url,
            input.authentication,
            input.api_key,
        )?;
        Ok(client)
    }

    pub(crate) fn prepare_save(
        &self,
        db: &Connection,
        id: Option<Uuid>,
        input: SaveInput,
    ) -> Result<PreparedSave, Error> {
        self.master_key.as_ref().ok_or(Error::ReadOnly)?;
        let name = input.name.trim();
        if name.is_empty() || name.chars().any(char::is_control) {
            return Err(Error::InvalidName);
        }
        if !valid_model(&input.model) {
            return Err(Error::InvalidModel);
        }
        let (client, revision) =
            self.prepare_client(db, id, &input.base_url, input.authentication, input.api_key)?;
        Ok(PreparedSave {
            id,
            revision,
            name: name.to_owned(),
            model: input.model,
            client,
        })
    }

    fn prepare_client(
        &self,
        db: &Connection,
        id: Option<Uuid>,
        url: &str,
        authentication: Authentication,
        key: Option<Secret>,
    ) -> Result<(OpenAI, Option<i64>), Error> {
        let base_url = base_url("baseUrl", url).map_err(|_| Error::InvalidBaseUrl)?;
        let mut saved = id
            .map(|id| Saved::read(db, id)?.ok_or(Error::NotFound))
            .transpose()?;
        let revision = saved.as_ref().map(|saved| saved.revision);
        let key = match (authentication, key) {
            (Authentication::None, None) => None,
            (Authentication::None, Some(_)) => return Err(Error::UnexpectedKey),
            (Authentication::ApiKey, Some(key)) if valid_header_token(key.expose()) => Some(key),
            (Authentication::ApiKey, Some(_)) => return Err(Error::InvalidKey),
            (Authentication::ApiKey, None) => {
                let (Some(id), Some(saved)) = (
                    id,
                    saved.as_mut().filter(|saved| saved.base_url == base_url),
                ) else {
                    return Err(Error::CredentialRequired);
                };
                if saved.sealed_key.is_some() && self.master_key.is_none() {
                    return Err(Error::ReadOnly);
                }
                Some(
                    saved
                        .credential(id, self.master_key.as_ref())?
                        .ok_or(Error::CredentialRequired)?,
                )
            }
        };
        Ok((client(base_url, key)?, revision))
    }

    pub(crate) fn mutate_provider(
        &mut self,
        db: &mut Connection,
        mutation: Mutation,
    ) -> Result<Status, Error> {
        let master_key = self.master_key.as_ref().ok_or(Error::ReadOnly)?;
        let transaction = db.transaction()?;
        let active = match mutation {
            Mutation::Save(save) => {
                let ValidatedSave(PreparedSave {
                    id,
                    revision,
                    name,
                    model,
                    client,
                }) = *save;
                let id = id.unwrap_or_else(Uuid::new_v4);
                let config = client.config();
                let sealed_key = if config.api_key.is_empty() {
                    None
                } else {
                    Some(seal_key(
                        master_key,
                        &credential_identity(id, &config.base_url),
                        &config.api_key,
                    )?)
                };
                let revision = if let Some(revision) = revision {
                    let next_revision = revision.checked_add(1).ok_or(Error::Storage)?;
                    // The credential used for discovery must still be the one this edit is replacing.
                    let changed = transaction.execute(
                        "UPDATE provider_configurations
                         SET name = ?2, base_url = ?3, model = ?4, sealed_key = ?5, revision = ?7
                         WHERE id = ?1 AND revision = ?6",
                        params![
                            id.as_bytes(),
                            name,
                            config.base_url,
                            model,
                            sealed_key,
                            revision,
                            next_revision
                        ],
                    )?;
                    if changed == 0 {
                        return Err(Error::Changed);
                    }
                    next_revision
                } else {
                    transaction.execute(
                        "INSERT INTO provider_configurations (id, name, base_url, model, sealed_key)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![id.as_bytes(), name, config.base_url, model, sealed_key],
                    )?;
                    if self.active.is_none() {
                        select(&transaction, id)?;
                    }
                    0
                };
                (current_id(&transaction)? == Some(id))
                    .then(|| responses_connection(client, model, id, revision))
            }
            Mutation::Activate(id) => {
                let saved = Saved::read(&transaction, id)?.ok_or(Error::NotFound)?;
                let active = saved.connect(id, Some(master_key))?;
                select(&transaction, id)?;
                Some(active)
            }
        };
        let status = status(&transaction)?;
        transaction.commit()?;
        if let Some(active) = active {
            self.active = Some(active);
        }
        Ok(status)
    }
}

fn select(db: &Connection, id: Uuid) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO current_provider_configuration (slot, configuration_id) VALUES (1, ?1)
         ON CONFLICT(slot) DO UPDATE SET configuration_id = excluded.configuration_id",
        [id.as_bytes()],
    )?;
    Ok(())
}

fn credential_identity(id: Uuid, base_url: &str) -> String {
    format!("custom:{id}:{base_url}")
}

fn client(base_url: String, key: Option<Secret>) -> anyhow::Result<OpenAI> {
    let http = HTTP
        .as_ref()
        .map_err(|_| anyhow::anyhow!("could not initialize custom provider transport"))?;
    let config = match key {
        Some(key) => OpenAIConfig::new(key),
        None => OpenAIConfig::new("").with_auth(Auth::OptionalBearer),
    };
    Ok(config.with_base_url(base_url).connect(http.clone()))
}

async fn list_models(client: &OpenAI) -> Result<ModelList, Error> {
    let started = Instant::now();
    let result = tokio::time::timeout(DISCOVERY_TIMEOUT, client.list_models()).await;
    let duration_ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(Ok(models)) => {
            tracing::info!(
                duration_ms,
                model_count = models.len(),
                "Provider models listed"
            );
            Ok(models)
        }
        Ok(Err(error)) => Err(discovery_error(error, duration_ms)),
        Err(_) => {
            tracing::warn!(
                duration_ms,
                code = "provider_discovery_timeout",
                "Provider model discovery timed out"
            );
            Err(Error::DiscoveryTimeout)
        }
    }
}

pub(crate) async fn discover(client: &OpenAI) -> Result<Vec<String>, Error> {
    let mut models: Vec<_> = list_models(client)
        .await?
        .into_iter()
        .map(|model| model.id)
        .filter(|id| valid_model(id))
        .collect();
    models.sort_unstable();
    models.dedup();
    Ok(models)
}

fn discovery_error(error: ProviderError, duration_ms: u64) -> Error {
    let status = error.provider_response_status();
    let (failure, code) = if matches!(error, ProviderError::InvalidAuthentication(_))
        || matches!(
            status,
            Some(StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
        ) {
        (
            Error::AuthenticationFailed,
            "provider_authentication_failed",
        )
    } else {
        (Error::DiscoveryFailed, "provider_discovery_failed")
    };
    tracing::warn!(
        duration_ms,
        upstream_status = ?status.map(|status| status.as_u16()),
        code,
        "Provider model discovery failed"
    );
    failure
}

fn responses_connection(
    client: OpenAI,
    model_id: String,
    id: Uuid,
    revision: i64,
) -> ConfiguredModel {
    let model = client.responses(&model_id);
    let accepts = model.wire.accepts(&model_id);
    ConfiguredModel {
        connection: model_connection(Provider::OpenAi, &model_id, accepts, |label| {
            ResponsesHandler::new(ModelAdapter::new(label, model), id, revision)
        }),
        selection: Selection {
            provider: "custom",
            model: model_id,
            source: Source::Saved,
        },
    }
}
