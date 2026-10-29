import { useState, type ComponentProps, type JSX, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import styles from "../lib/styles.ts";
import { Text } from "@astryxdesign/core/Text";
import { getShell } from "../lib/shell.ts";

export function ExternalLink({ href, children, ...props }: ComponentProps<"a"> & { href: string }): JSX.Element {
  const [error, setError] = useState<string>();
  return <>
    <a {...props} href={href} target="_blank" rel="noopener noreferrer" onClick={event => {
      if (!/^https?:$/i.test(new URL(href).protocol)) return;
      event.preventDefault();
      setError(undefined);
      void getShell().browser.open(href).catch(error => setError(error instanceof Error ? error.message : String(error)));
    }}>{children}</a>
    {error === undefined ? null : <Text role="status">{error}</Text>}
  </>;
}

export function ExternalMarkdownLink({ href, children }: { href: string; children: ReactNode }): JSX.Element {
  let protocol: string;
  try { protocol = new URL(href).protocol.toLowerCase(); }
  catch { return <>{children}</>; }
  if (protocol !== "http:" && protocol !== "https:" && protocol !== "mailto:") return <>{children}</>;
  return <ExternalLink href={href} {...stylex.props(styles.markdownLink)}>{children}</ExternalLink>;
}
