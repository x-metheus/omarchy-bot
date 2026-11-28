//! Resolve and prepare the pinned FastEmbed assets without touching Conversation data.

use std::env;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use ring::digest::{self, SHA256};
use tokio::io::AsyncWriteExt;
use url::Url;

use crate::recall::Unavailable;

const PINNED_SOURCE: &str = "https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78";
const MANIFEST: &str = include_str!("../recall-model.sha256");
const MODEL_DIRECTORY: &str = "recall-model";

pub(crate) struct ModelLocation {
    pub(crate) directory: PathBuf,
    pub(crate) download: bool,
}

pub(crate) fn location(database: &Path) -> Option<ModelLocation> {
    if let Some(directory) = env::var_os("OMARCHY_AGENT_RECALL_MODEL_DIR") {
        return Some(ModelLocation {
            directory: directory.into(),
            download: false,
        });
    }
    let bundled = env::var_os("OMARCHY_AGENT_RECALL_BUNDLE_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            env::current_exe()
                .ok()?
                .parent()
                .map(|parent| parent.join(MODEL_DIRECTORY))
        });
    if let Some(directory) =
        bundled.filter(|directory| !matches!(directory.try_exists(), Ok(false)))
    {
        return Some(ModelLocation {
            directory,
            download: false,
        });
    }
    (env::var("OMARCHY_AGENT_RECALL_DOWNLOAD").as_deref() == Ok("1")).then(|| ModelLocation {
        directory: database.with_file_name(MODEL_DIRECTORY),
        download: true,
    })
}

pub(crate) struct Asset {
    name: &'static str,
    size: u64,
}

pub(crate) const CONFIG: Asset = Asset {
    name: "config.json",
    size: 658,
};
pub(crate) const SPECIAL_TOKENS: Asset = Asset {
    name: "special_tokens_map.json",
    size: 167,
};
pub(crate) const TOKENIZER: Asset = Asset {
    name: "tokenizer.json",
    size: 17_082_730,
};
pub(crate) const TOKENIZER_CONFIG: Asset = Asset {
    name: "tokenizer_config.json",
    size: 443,
};
pub(crate) const ONNX: Asset = Asset {
    name: "onnx/model_int8.onnx",
    size: 118_054_593,
};

impl Asset {
    pub(crate) fn read(&self, directory: &Path) -> Result<Vec<u8>, Unavailable> {
        let path = directory.join(self.name);
        let metadata = fs::metadata(&path).map_err(file_error)?;
        if !metadata.is_file() || metadata.len() != self.size {
            return Err(Unavailable::VerificationFailed);
        }
        let mut bytes = Vec::with_capacity(self.size as usize);
        File::open(path)
            .map_err(file_error)?
            .take(self.size + 1)
            .read_to_end(&mut bytes)
            .map_err(file_error)?;
        let expected = MANIFEST
            .lines()
            .filter_map(|line| line.split_once("  "))
            .find_map(|(hash, file)| (file == self.name).then_some(hash))
            .expect("every Recall asset has a pinned digest");
        let hash = digest::digest(&SHA256, &bytes);
        let hex = b"0123456789abcdef";
        let actual = hash
            .as_ref()
            .iter()
            .flat_map(|byte| [hex[(byte >> 4) as usize], hex[(byte & 15) as usize]]);
        if bytes.len() as u64 != self.size || !actual.eq(expected.bytes()) {
            return Err(Unavailable::VerificationFailed);
        }
        Ok(bytes)
    }
}

pub(crate) async fn download(destination: &Path) -> Result<tempfile::TempDir, Unavailable> {
    let source =
        env::var("OMARCHY_AGENT_RECALL_MODEL_SOURCE").unwrap_or_else(|_| PINNED_SOURCE.into());
    let url = Url::parse(&source).map_err(|_| Unavailable::DownloadFailed)?;
    let https = url.scheme() == "https";
    if !https && !(url.scheme() == "http" && url.host_str() == Some("127.0.0.1")) {
        return Err(Unavailable::DownloadFailed);
    }
    let client = reqwest::Client::builder()
        .https_only(https)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|_| Unavailable::DownloadFailed)?;
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let stage = tempfile::Builder::new()
        .prefix(".recall-")
        .tempdir_in(parent)
        .map_err(file_error)?;
    tokio::fs::create_dir(stage.path().join("onnx"))
        .await
        .map_err(file_error)?;
    for asset in [CONFIG, SPECIAL_TOKENS, TOKENIZER_CONFIG, TOKENIZER, ONNX] {
        let mut asset_url = url.clone();
        asset_url
            .path_segments_mut()
            .map_err(|_| Unavailable::DownloadFailed)?
            .pop_if_empty()
            .extend(asset.name.split('/'));
        asset_url.set_query(Some("download=true"));
        let mut response = client
            .get(asset_url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|_| Unavailable::DownloadFailed)?;
        let mut file = tokio::fs::File::create(stage.path().join(asset.name))
            .await
            .map_err(file_error)?;
        let mut size = 0;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| Unavailable::DownloadFailed)?
        {
            size += chunk.len() as u64;
            if size > asset.size {
                return Err(Unavailable::VerificationFailed);
            }
            file.write_all(&chunk).await.map_err(file_error)?;
        }
        if size != asset.size {
            return Err(Unavailable::VerificationFailed);
        }
        file.flush().await.map_err(file_error)?;
    }
    Ok(stage)
}

pub(crate) fn file_error(error: io::Error) -> Unavailable {
    match error.kind() {
        io::ErrorKind::NotFound => Unavailable::ModelMissing,
        _ => Unavailable::ModelUnreadable,
    }
}
