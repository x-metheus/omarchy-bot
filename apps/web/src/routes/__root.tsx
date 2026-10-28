import { Outlet, createRootRoute } from "@tanstack/react-router";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { useEffect, useSyncExternalStore, type JSX } from "react";
import { connectionState, pairService, subscribeConnection } from "../lib/pairing.ts";
import { getShell } from "../lib/shell.ts";
import { AddService } from "../components/AddService.tsx";
import { ProtocolGate } from "../components/ProtocolGate.tsx";
import { LocalApprovalPrompt } from "../components/LocalApprovalPrompt.tsx";
import { useQueryClient } from "@tanstack/react-query";

function Root(): JSX.Element {
  const connection = useSyncExternalStore(subscribeConnection, connectionState);
  const queryClient = useQueryClient();
  useEffect(() => { if (!connection.paired) queryClient.clear(); }, [connection.paired, queryClient]);
  useEffect(() => getShell().pairing.onRequest(request => { void pairService(request); }), []);
  return (
    <Theme theme={neutralTheme}>
      {connection.paired ? <><ProtocolGate><Outlet /></ProtocolGate><LocalApprovalPrompt /></> : <AddService />}
    </Theme>
  );
}

export const Route = createRootRoute({ component: Root });
