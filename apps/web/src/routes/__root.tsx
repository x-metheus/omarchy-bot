import { Outlet, createRootRoute } from "@tanstack/react-router";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { Banner } from "@astryxdesign/core/Banner";
import type { JSX } from "react";
import { pairingError } from "../lib/pairing.ts";
import { ProtocolGate } from "../components/ProtocolGate.tsx";

function Root(): JSX.Element {
  const error = pairingError();
  return (
    <Theme theme={neutralTheme}>
      {error === undefined ? null : (
        <Banner status="error" title="Pairing failed" description={error} container="section" />
      )}
      <ProtocolGate><Outlet /></ProtocolGate>
    </Theme>
  );
}

export const Route = createRootRoute({ component: Root });
