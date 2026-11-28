use std::io::Write;
use std::path::{Path, PathBuf};

pub fn write_attachment(directory: &Path, filename: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    if filename.is_empty() || filename == "." || filename == ".." || filename.contains(['/', '\\']) || filename.chars().any(char::is_control) {
        return Err("The attachment has an invalid filename.".into());
    }
    std::fs::create_dir_all(directory).map_err(|error| format!("Could not create Downloads: {error}"))?;
    let mut target = directory.join(filename);
    for suffix in 1.. {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&target) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes) {
                    let _ = std::fs::remove_file(&target);
                    return Err(format!("Could not save the attachment: {error}"));
                }
                return Ok(target);
            },
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => target = directory.join(format!("{suffix}-{filename}")),
            Err(error) => return Err(format!("Could not save the attachment: {error}")),
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downloads_preserve_bytes_and_filenames_without_overwriting_collisions() {
        let directory = std::env::temp_dir().join(format!("omarchy-attachment-test-{}", std::process::id())).join("Downloads");
        std::fs::create_dir_all(&directory).unwrap();
        let result = std::panic::catch_unwind(|| {
            let original = write_attachment(&directory, "report.txt", b"original").unwrap();
            let collision = write_attachment(&directory, "report.txt", b"second").unwrap();
            let next = write_attachment(&directory, "report.txt", b"third").unwrap();
            assert_eq!(original, directory.join("report.txt"));
            assert_eq!(collision, directory.join("1-report.txt"));
            assert_eq!(next, directory.join("2-report.txt"));
            assert_eq!(std::fs::read(original).unwrap(), b"original");
            assert_eq!(std::fs::read(collision).unwrap(), b"second");
            assert_eq!(std::fs::read(next).unwrap(), b"third");
            for filename in ["", ".", "..", "../secret", "a/b", "a\\b", "line\nbreak"] {
                assert!(write_attachment(&directory, filename, b"invalid").is_err());
            }
        });
        std::fs::remove_dir_all(directory.parent().unwrap()).unwrap();
        result.unwrap();
    }
}
