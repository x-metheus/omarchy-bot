use std::sync::LazyLock;
static FRAMED: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?m)^#< CLIXML\r?\n(<Objs\b[\s\S]*?</Objs>)").unwrap());
static ESCAPE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)_x([0-9a-f]{4})_").unwrap());
fn document(xml: &str) -> Option<String> {
    let document = roxmltree::Document::parse(xml).ok()?;
    let root = document.root_element();
    if root.tag_name().name() != "Objs"
        || root.tag_name().namespace() != Some("http://schemas.microsoft.com/powershell/2004/04")
        || root.attributes().any(|a| a.name() != "Version")
    {
        return None;
    }
    let mut output = String::new();
    for node in root.children().filter(|node| node.is_element()) {
        if node.tag_name().name() == "Obj" && node.attribute("S") == Some("progress") {
            continue;
        }
        if node.tag_name().name() != "S"
            || !matches!(
                node.attribute("S")?.to_ascii_lowercase().as_str(),
                "warning" | "error" | "verbose" | "debug" | "information"
            )
            || node.attributes().any(|a| a.name() != "S")
            || node.children().any(|n| n.is_element())
        {
            return None;
        }
        let encoded = node.text().unwrap_or("");
        let mut units = Vec::new();
        let mut end = 0;
        for capture in ESCAPE.captures_iter(encoded) {
            let found = capture.get(0)?;
            units.extend(encoded[end..found.start()].encode_utf16());
            units.push(u16::from_str_radix(&capture[1], 16).ok()?);
            end = found.end();
        }
        units.extend(encoded[end..].encode_utf16());
        let value = String::from_utf16_lossy(&units);
        output.push_str(&value);
        if !value.ends_with('\n') {
            output.push('\n');
        }
    }
    Some(output)
}
pub fn decode(text: &str) -> String {
    FRAMED
        .replace_all(text, |capture: &regex::Captures<'_>| {
            document(&capture[1]).unwrap_or_else(|| capture[0].to_string())
        })
        .into_owned()
}
