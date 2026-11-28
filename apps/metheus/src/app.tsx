import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { StrictMode, useEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { AgentDesktop } from "./components/AgentDesktop.tsx";
import { connectionState, pairService, subscribeConnection } from "./lib/pairing.ts";
import { getShell } from "./lib/shell.ts";
import { AppearanceProvider } from "./lib/appearance.tsx";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 5_000 },
  },
});

function Root() {
  const connection = useSyncExternalStore(subscribeConnection, connectionState);
  const queryClient = useQueryClient();
  useEffect(() => { if (!connection.paired) queryClient.clear(); }, [connection.paired, queryClient]);
  useEffect(() => getShell().pairing.onRequest(request => { void pairService(request); }), []);
  return (
    <AppearanceProvider>
      <TooltipProvider>
        <AgentDesktop daemon={getShell().agentDaemon} paired={connection.paired} baseUrl={connection.serviceUrl} />
      </TooltipProvider>
    </AppearanceProvider>
  );
}

export function startApp(): void {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <Root />
      </QueryClientProvider>
    </StrictMode>,
  );
}
