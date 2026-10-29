use omarchy_bot_sidecar::windows_output::decode;
fn framed(body: &str) -> String {
    format!("#< CLIXML\r\n<Objs Version=\"1.1.0.1\" xmlns=\"http://schemas.microsoft.com/powershell/2004/04\">{body}</Objs>")
}
#[test]
fn powershell_diagnostics_preserve_plain_text_and_decode_only_known_frames() {
    assert_eq!(decode(&framed("<Obj S=\"progress\"><MS/></Obj><S S=\"warning\">warning &lt;x&gt; &amp; λ</S><S S=\"Error\">error_x000D__x000A_</S>")), "warning <x> & λ\nerror\r\n");
    assert_eq!(
        decode(&framed(
            "<S S=\"warning\">literal _x005F_x000D_ &amp;lt; _xD83D__xDE00_</S>"
        )),
        "literal _x000D_ &lt; 😀\n"
    );
    for text in [
        "plain <error> _x000D_".to_string(),
        framed("<Obj S=\"Error\"/>"),
        framed("<S S=\"Error\">&unknown;</S>"),
    ] {
        assert_eq!(decode(&text), text);
    }
}
