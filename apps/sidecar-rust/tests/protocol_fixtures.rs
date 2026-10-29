use omarchy_bot_sidecar::protocol::{ClientFrame, ServerFrame};
use serde_json::{json, Value};

#[test]
fn canonical_wire_fixtures_roundtrip_without_unknown_fields() {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/protocol/fixtures/sidecar");
    let mut count = 0;
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let fixture: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let original = fixture["frame"].clone();
        let roundtrip = match fixture["direction"].as_str().unwrap() {
            "client" => serde_json::to_value(
                serde_json::from_value::<ClientFrame>(original.clone()).unwrap(),
            )
            .unwrap(),
            "server" => serde_json::to_value(
                serde_json::from_value::<ServerFrame>(original.clone()).unwrap(),
            )
            .unwrap(),
            other => panic!("unknown direction {other}"),
        };
        assert_eq!(roundtrip, original, "{}", path.display());
        let mut unknown = original;
        unknown
            .as_object_mut()
            .unwrap()
            .insert("unrecognized".into(), json!(true));
        assert!(
            match fixture["direction"].as_str().unwrap() {
                "client" => serde_json::from_value::<ClientFrame>(unknown).is_err(),
                _ => serde_json::from_value::<ServerFrame>(unknown).is_err(),
            },
            "unknown field accepted: {}",
            path.display()
        );
        count += 1;
    }
    assert!(count > 0);
}

#[test]
fn invalid_local_jobs_are_rejected_at_the_wire_boundary() {
    let valid = json!({"type":"local.job","jobId":"job","hostname":"paired","botId":"bot","turnId":"turn","action":"run","command":"printf ok"});
    for (key, value) in [
        ("action", json!("screenshot")),
        ("command", json!("")),
        ("command", json!("x".repeat(8193))),
        ("jobId", json!("")),
        ("path", json!(null)),
    ] {
        let mut frame = valid.clone();
        frame[key] = value;
        assert!(
            serde_json::from_value::<ServerFrame>(frame).is_err(),
            "accepted {key}"
        );
    }
    let mut missing = valid;
    missing.as_object_mut().unwrap().remove("command");
    assert!(serde_json::from_value::<ServerFrame>(missing).is_err());
}
