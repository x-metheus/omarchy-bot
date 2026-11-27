use std::{env, fs, str};

use anyhow::{Context, Result, anyhow, ensure};
use rig_core::catalog::{Catalog, ModelSpec};
use rig_core::completion::{Accepts, ReplayTarget};
use rig_core::driver::{DynModel, Model};
use rig_core::operation::Completion;
use rig_core::providers::anthropic::AnthropicConfig;
use rig_core::providers::openai::OpenAIConfig;
use rig_core::providers::registry::ProviderId;
use rig_core::serve::{ErasedHandler, adapters::ModelAdapter};
use rig_core::wire::Secret;
use rig_ecs::{effects::Handler, model::Connection as RigConnection};
use ring::aead;
use ring::digest::{self, Digest};
use ring::rand::{SecureRandom, SystemRandom};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Deserializer, Serialize};
use url::Url;
use zeroize::Zeroizing;

use crate::env_or;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Provider {
    OpenAi,
    Anthropic,
}

impl Provider {
    fn name(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
        }
    }
}

#[derive(Clone, Serialize)]
struct Selection {
    provider: Provider,
    model: String,
    source: Source,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum Source {
    Saved,
    Environment,
}

#[derive(Clone, Copy, Serialize)]
struct StoredCredentials {
    openai: bool,
    anthropic: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsStatus {
    active: Option<Selection>,
    stored_credentials: StoredCredentials,
    writable: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SettingsUpdate {
    provider: Provider,
    model: String,
    #[serde(default, deserialize_with = "deserialize_key")]
    api_key: Option<Secret>,
}

fn deserialize_key<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Secret>, D::Error> {
    String::deserialize(deserializer).map(|key| Some(Secret::from(key)))
}

pub(crate) enum Update {
    Saved(SettingsStatus),
    InvalidModel,
    InvalidKey,
    CredentialRequired,
    MasterKeyRequired,
}

struct ConfiguredModel {
    selection: Selection,
    connection: RigConnection,
}

struct Endpoints {
    openai: Option<String>,
    anthropic: Option<String>,
}

impl Endpoints {
    fn connect(&self, selection: Selection, key: Secret) -> ConfiguredModel {
        let (model, accepts): (DynModel<Completion>, Accepts) = match selection.provider {
            Provider::OpenAi => {
                let mut config = OpenAIConfig::new(key);
                if let Some(url) = &self.openai {
                    config = config.with_base_url(url);
                }
                let model = config.client().chat(&selection.model);
                let accepts = model.wire.accepts(&selection.model);
                (model.into(), accepts)
            }
            Provider::Anthropic => {
                let mut config = AnthropicConfig::new(key);
                if let Some(url) = &self.anthropic {
                    config = config.with_base_url(url);
                }
                let mut wire = config.completion(&selection.model);
                // Rig supplies catalog limits. Messages requires a limit for gateway aliases too.
                wire.default_max_tokens.get_or_insert(1024);
                let accepts = wire.accepts(&selection.model);
                (Model::new(wire, rig_reqwest::shared()).into(), accepts)
            }
        };
        let provider =
            ProviderId::catalog(selection.provider.name()).expect("built-in Rig provider");
        let known = Catalog::builtin().get(provider, &selection.model);
        // Rig's bare spec disables tools. Use the provider wire capabilities for gateway aliases.
        let mut spec = ModelSpec::new(provider, &selection.model)
            .with_tools(accepts.tools && known.as_ref().is_none_or(|known| known.spec.tools));
        spec.input.image = known.map_or(accepts.user_images, |known| known.spec.input.image);
        let handler = ModelAdapter::<Completion>::new(spec.reference(), model);
        ConfiguredModel {
            selection,
            connection: RigConnection {
                spec: spec.into(),
                handler: Handler(ErasedHandler::new(handler)),
            },
        }
    }
}

pub(crate) struct Settings {
    endpoints: Endpoints,
    master_key: Option<aead::LessSafeKey>,
    active: Option<ConfiguredModel>,
    stored_credentials: StoredCredentials,
}

impl Settings {
    pub(crate) fn load(db: &Connection) -> Result<Self> {
        let endpoints = Endpoints {
            openai: endpoint("OPENAI_BASE_URL")?,
            anthropic: endpoint("ANTHROPIC_BASE_URL")?,
        };
        let master_key = env::var_os("OMARCHY_AGENT_MASTER_KEY_FILE")
            .map(|path| {
                let bytes =
                    Zeroizing::new(fs::read(path).context("read OMARCHY_AGENT_MASTER_KEY_FILE")?);
                let key = aead::UnboundKey::new(&aead::AES_256_GCM, &bytes).map_err(|_| {
                    anyhow!("OMARCHY_AGENT_MASTER_KEY_FILE must contain exactly 32 raw bytes")
                })?;
                Ok::<_, anyhow::Error>(aead::LessSafeKey::new(key))
            })
            .transpose()?;
        let saved = db
            .query_row(
                "SELECT provider, model FROM model_settings WHERE id = 1",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let active = if let Some((provider, model)) = saved {
            let provider = match provider.as_str() {
                "openai" => Provider::OpenAi,
                "anthropic" => Provider::Anthropic,
                _ => anyhow::bail!("saved Settings reference an unknown provider"),
            };
            let master_key = master_key
                .as_ref()
                .context("saved Settings require OMARCHY_AGENT_MASTER_KEY_FILE")?;
            let key = read_key(db, master_key, provider)?
                .context("saved Settings have no provider credential")?;
            Some(endpoints.connect(
                Selection {
                    provider,
                    model,
                    source: Source::Saved,
                },
                key,
            ))
        } else {
            bootstrap(&endpoints)?
        };
        let stored_credentials = db.query_row(
            "SELECT EXISTS (SELECT 1 FROM provider_credentials WHERE provider = 'openai'),
                    EXISTS (SELECT 1 FROM provider_credentials WHERE provider = 'anthropic')",
            [],
            |row| {
                Ok(StoredCredentials {
                    openai: row.get(0)?,
                    anthropic: row.get(1)?,
                })
            },
        )?;
        Ok(Self {
            endpoints,
            master_key,
            active,
            stored_credentials,
        })
    }

    pub(crate) fn status(&self) -> SettingsStatus {
        SettingsStatus {
            active: self.active.as_ref().map(|active| active.selection.clone()),
            stored_credentials: self.stored_credentials,
            writable: self.master_key.is_some(),
        }
    }

    pub(crate) fn connection(&self) -> Option<RigConnection> {
        self.active.as_ref().map(|active| active.connection.clone())
    }

    pub(crate) fn update(&mut self, db: &mut Connection, update: SettingsUpdate) -> Result<Update> {
        let SettingsUpdate {
            provider,
            model,
            api_key,
        } = update;
        if !valid_model(&model) {
            return Ok(Update::InvalidModel);
        }
        let Some(master_key) = &self.master_key else {
            return Ok(Update::MasterKeyRequired);
        };
        let transaction = db.transaction()?;
        let key = if let Some(key) = api_key {
            if !valid_header_token(key.expose()) {
                return Ok(Update::InvalidKey);
            }
            let sealed = seal_key(master_key, provider, &key)?;
            transaction.execute(
                "INSERT INTO provider_credentials (provider, sealed_key) VALUES (?1, ?2)
                 ON CONFLICT(provider) DO UPDATE SET sealed_key = excluded.sealed_key",
                params![provider.name(), sealed],
            )?;
            key
        } else {
            let Some(key) = read_key(&transaction, master_key, provider)? else {
                return Ok(Update::CredentialRequired);
            };
            key
        };
        let active = self.endpoints.connect(
            Selection {
                provider,
                model,
                source: Source::Saved,
            },
            key,
        );
        transaction.execute(
            "INSERT INTO model_settings (id, provider, model) VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, model = excluded.model",
            params![provider.name(), active.selection.model],
        )?;
        transaction.commit()?;
        self.active = Some(active);
        match provider {
            Provider::OpenAi => self.stored_credentials.openai = true,
            Provider::Anthropic => self.stored_credentials.anthropic = true,
        }
        Ok(Update::Saved(self.status()))
    }
}

fn bootstrap(endpoints: &Endpoints) -> Result<Option<ConfiguredModel>> {
    let key = env_or("OPENAI_API_KEY", "")?;
    if key.trim().is_empty() {
        return Ok(None);
    }
    ensure!(
        valid_header_token(&key),
        "OPENAI_API_KEY must be a nonempty HTTP token"
    );
    let model = env_or("OMARCHY_AGENT_MODEL", "gpt-4.1-mini")?;
    ensure!(
        valid_model(&model),
        "OMARCHY_AGENT_MODEL must be nonempty with no surrounding whitespace or control characters"
    );
    let selection = Selection {
        provider: Provider::OpenAi,
        model,
        source: Source::Environment,
    };
    Ok(Some(endpoints.connect(selection, Secret::from(key))))
}

fn endpoint(name: &str) -> Result<Option<String>> {
    let Some(value) = env::var_os(name) else {
        return Ok(None);
    };
    let value = value
        .into_string()
        .map_err(|_| anyhow!("{name} must be valid UTF-8"))?;
    let url =
        Url::parse(&value).map_err(|_| anyhow!("{name} must be an absolute HTTP(S) base URL"))?;
    ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.has_host()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "{name} must be an absolute HTTP(S) base URL without credentials, query, or fragment"
    );
    Ok(Some(url.as_str().trim_end_matches('/').to_owned()))
}

fn valid_model(model: &str) -> bool {
    !model.is_empty() && model.trim() == model && !model.chars().any(char::is_control)
}

fn valid_header_token(token: &str) -> bool {
    !token.is_empty() && token.bytes().all(|byte| byte.is_ascii_graphic())
}

pub(crate) fn load_token() -> Result<Option<Digest>> {
    env::var_os("OMARCHY_AGENT_SETTINGS_TOKEN_FILE")
        .map(|path| {
            let token = Zeroizing::new(
                fs::read_to_string(path).context("read OMARCHY_AGENT_SETTINGS_TOKEN_FILE")?,
            );
            let token = token.trim_end_matches(['\r', '\n']);
            ensure!(
                valid_header_token(token),
                "OMARCHY_AGENT_SETTINGS_TOKEN_FILE must contain a nonempty bearer token"
            );
            Ok(digest::digest(&digest::SHA256, token.as_bytes()))
        })
        .transpose()
}

fn seal_key(master_key: &aead::LessSafeKey, provider: Provider, key: &Secret) -> Result<Vec<u8>> {
    let mut nonce = [0; aead::NONCE_LEN];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| anyhow!("could not generate a credential nonce"))?;
    let mut sealed =
        Vec::with_capacity(nonce.len() + key.expose().len() + aead::AES_256_GCM.tag_len());
    sealed.extend_from_slice(&nonce);
    sealed.extend_from_slice(key.expose().as_bytes());
    let tag = master_key
        .seal_in_place_separate_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(provider.name()),
            &mut sealed[aead::NONCE_LEN..],
        )
        .map_err(|_| anyhow!("could not encrypt the provider credential"))?;
    sealed.extend_from_slice(tag.as_ref());
    Ok(sealed)
}

fn read_key(
    db: &Connection,
    master_key: &aead::LessSafeKey,
    provider: Provider,
) -> Result<Option<Secret>> {
    let sealed = db
        .query_row(
            "SELECT sealed_key FROM provider_credentials WHERE provider = ?1",
            [provider.name()],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .optional()?;
    let Some(sealed) = sealed else {
        return Ok(None);
    };
    let mut sealed = Zeroizing::new(sealed);
    let (nonce, ciphertext) = sealed
        .split_at_mut_checked(aead::NONCE_LEN)
        .context("stored provider credential is incomplete")?;
    let nonce = aead::Nonce::try_assume_unique_for_key(nonce)
        .map_err(|_| anyhow!("stored provider credential has an invalid nonce"))?;
    let plaintext = master_key
        .open_in_place(nonce, aead::Aad::from(provider.name()), ciphertext)
        .map_err(|_| {
            anyhow!("cannot decrypt stored provider credential with OMARCHY_AGENT_MASTER_KEY_FILE")
        })?;
    let key = str::from_utf8(plaintext).context("stored provider credential is invalid")?;
    ensure!(
        valid_header_token(key),
        "stored provider credential is invalid"
    );
    Ok(Some(Secret::from(key)))
}
