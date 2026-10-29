use serde::{Deserialize, Deserializer, Serialize};

pub const RESULT_MAX: usize = 16_384;

pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}
pub fn truncate(text: &str, max: usize) -> String {
    let mut units = 0;
    text.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= max
        })
        .collect()
}
fn bounded(value: &str, min: usize, max: usize) -> Result<(), String> {
    if (min..=max).contains(&utf16_len(value)) {
        Ok(())
    } else {
        Err("string outside protocol bounds".into())
    }
}
fn identifier<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    bounded(&value, 1, 256).map_err(serde::de::Error::custom)?;
    Ok(value)
}
fn nonempty<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    bounded(&value, 1, usize::MAX).map_err(serde::de::Error::custom)?;
    Ok(value)
}
fn device<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    if !valid_device(&value) {
        return Err(serde::de::Error::custom(
            "invalid Local Sidecar device identity",
        ));
    }
    Ok(value)
}
pub fn valid_device(value: &str) -> bool {
    value.len() == 36
        && value.starts_with("dev_")
        && value[4..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn host<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    bounded(value.trim(), 1, 256).map_err(serde::de::Error::custom)?;
    Ok(value)
}
// An absent optional property is valid; explicit JSON null is not a TypeScript string.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}
fn capabilities<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Capability>, D::Error> {
    let values = Vec::<Capability>::deserialize(d)?;
    if values.is_empty() {
        return Err(serde::de::Error::custom("capabilities must not be empty"));
    }
    Ok(values)
}
fn result_text<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let value = String::deserialize(d)?;
    bounded(&value, 0, RESULT_MAX).map_err(serde::de::Error::custom)?;
    Ok(Some(value))
}
fn result_error<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let value = String::deserialize(d)?;
    bounded(&value, 0, 2048).map_err(serde::de::Error::custom)?;
    Ok(Some(value))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Os {
    Linux,
    Macos,
    Windows,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum Shell {
    #[serde(rename = "posix-sh")]
    Posix,
    #[serde(rename = "powershell-5.1")]
    PowerShell,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
    Shell,
    Search,
    Files,
    Transfer,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Run,
    Search,
    Read,
    Write,
    Transfer,
}
impl Action {
    pub fn name(self) -> &'static str {
        match self {
            Self::Run => "run",
            Self::Search => "search",
            Self::Read => "read",
            Self::Write => "write",
            Self::Transfer => "transfer",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Direction {
    ToWorkspace,
    FromWorkspace,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Decision {
    AllowOnce,
    Deny,
    Always,
    Never,
}
#[derive(Debug, Deserialize)]
pub struct DecisionLine {
    #[serde(rename = "type")]
    pub decision: Decision,
    #[serde(default, deserialize_with = "present", rename = "jobId")]
    pub job_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum ClientFrame {
    #[serde(rename = "register")]
    Register {
        #[serde(rename = "deviceId", deserialize_with = "device")]
        device_id: String,
        #[serde(deserialize_with = "host")]
        hostname: String,
        os: Os,
        shell: Shell,
        #[serde(deserialize_with = "capabilities")]
        capabilities: Vec<Capability>,
    },
    #[serde(rename = "heartbeat")]
    Heartbeat {},
    #[serde(rename = "local.result")]
    Result {
        #[serde(rename = "jobId", deserialize_with = "identifier")]
        job_id: String,
        ok: bool,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "result_text"
        )]
        text: Option<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "result_error"
        )]
        error: Option<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "present",
            rename = "exitCode"
        )]
        exit_code: Option<i64>,
    },
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum ServerFrame {
    #[serde(rename = "registered")]
    Registered {
        #[serde(rename = "deviceId", deserialize_with = "device")]
        device_id: String,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(deserialize_with = "nonempty")]
        error: String,
    },
    #[serde(rename = "local.cancel")]
    Cancel {
        #[serde(rename = "jobId", deserialize_with = "identifier")]
        job_id: String,
    },
    #[serde(rename = "local.job")]
    Job(Job),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(try_from = "RawJob")]
pub struct Job {
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub hostname: String,
    #[serde(rename = "botId")]
    pub bot_id: String,
    #[serde(rename = "turnId")]
    pub turn_id: String,
    pub action: Action,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contents: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<Direction>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawJob {
    #[serde(rename = "jobId", deserialize_with = "identifier")]
    job_id: String,
    #[serde(deserialize_with = "host")]
    hostname: String,
    #[serde(rename = "botId", deserialize_with = "nonempty")]
    bot_id: String,
    #[serde(rename = "turnId", deserialize_with = "nonempty")]
    turn_id: String,
    action: Action,
    #[serde(default, deserialize_with = "present")]
    target: Option<String>,
    #[serde(default, deserialize_with = "present")]
    command: Option<String>,
    #[serde(default, deserialize_with = "present")]
    path: Option<String>,
    #[serde(default, deserialize_with = "present")]
    destination: Option<String>,
    #[serde(default, deserialize_with = "present")]
    query: Option<String>,
    #[serde(default, deserialize_with = "present")]
    contents: Option<String>,
    #[serde(default, deserialize_with = "present")]
    direction: Option<Direction>,
}
impl TryFrom<RawJob> for Job {
    type Error = String;
    fn try_from(raw: RawJob) -> Result<Self, Self::Error> {
        for (field, min, max) in [
            (&raw.target, 1, usize::MAX),
            (&raw.command, 1, 8192),
            (&raw.path, 1, 4096),
            (&raw.destination, 1, 4096),
            (&raw.query, 1, 1024),
            (&raw.contents, 0, 65536),
        ] {
            if let Some(value) = field {
                bounded(value, min, max)?;
            }
        }
        let valid = match raw.action {
            Action::Run => raw.command.is_some(),
            Action::Search => raw.query.is_some(),
            Action::Read | Action::Write => raw.path.is_some(),
            Action::Transfer => {
                raw.path.is_some() && raw.destination.is_some() && raw.direction.is_some()
            }
        };
        if !valid {
            return Err("local.job does not match LOCAL_SCHEMA".into());
        }
        Ok(Self {
            job_id: raw.job_id,
            hostname: raw.hostname,
            bot_id: raw.bot_id,
            turn_id: raw.turn_id,
            action: raw.action,
            target: raw.target,
            command: raw.command,
            path: raw.path,
            destination: raw.destination,
            query: raw.query,
            contents: raw.contents,
            direction: raw.direction,
        })
    }
}
impl Job {
    pub fn rule(&self) -> String {
        format!(
            "{}:{}",
            self.action.name(),
            self.command
                .as_deref()
                .or(self.path.as_deref())
                .or(self.query.as_deref())
                .unwrap_or("")
        )
    }
}
