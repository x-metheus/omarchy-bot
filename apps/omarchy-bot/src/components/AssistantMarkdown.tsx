import { Children, isValidElement, useState, type ReactNode } from "react";
import { CircleAlertIcon } from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from "@/components/ui/code-block";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { getShell } from "../lib/shell.ts";

function FencedCode({ code, language }: { code: string; language: string }) {
  const lines = useHighlightedCode(code, language);
  return <CodeBlock>
    <CodeBlockHeader>
      <CodeBlockTitle>{language || "Code"}</CodeBlockTitle>
      <CodeBlockActions><CodeBlockCopyButton value={code} /></CodeBlockActions>
    </CodeBlockHeader>
    <CodeBlockContent className="max-h-96">{lines.map((line, index) => <CodeBlockLine key={index}>{line}</CodeBlockLine>)}</CodeBlockContent>
  </CodeBlock>;
}

function ExternalLink({ href, children }: { href?: string | undefined; children?: ReactNode }) {
  const [failed, setFailed] = useState(false);
  // Only absolute web links leave the app. Relative URLs never navigate the WebView.
  if (!href || !/^https?:\/\//i.test(href)) return <>{children}</>;
  return <>
    <a href={href} onAuxClick={event => event.preventDefault()} onClick={event => {
      event.preventDefault();
      setFailed(false);
      void getShell().browser.open(href).catch(() => setFailed(true));
    }}>{children}</a>
    {failed && <span role="alert" className="ml-2 inline-flex items-center gap-1 text-destructive">
      <CircleAlertIcon className="size-3" aria-hidden="true" /> Could not open link.
    </span>}
  </>;
}

const components: Components = {
  a: ({ href, children }) => <ExternalLink href={href}>{children}</ExternalLink>,
  img: ({ alt }) => <>{alt}</>,
  pre: ({ children }) => {
    const code = Children.toArray(children)[0];
    if (!isValidElement<{ children: ReactNode; className?: string }>(code) || typeof code.props.children !== "string") return null;
    const language = code.props.className?.match(/^language-([^\s]+)/)?.[1] ?? "";
    return <FencedCode code={code.props.children.replace(/\n$/, "")} language={language} />;
  },
  table: ({ children }) => <div className="max-w-full overflow-x-auto"><table>{children}</table></div>,
};

export function AssistantMarkdown({ text }: { text: string }) {
  return <div className="assistant-markdown min-w-0"><Markdown skipHtml remarkPlugins={[remarkGfm]} components={components}>{text}</Markdown></div>;
}
