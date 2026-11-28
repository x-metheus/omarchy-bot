import { useEffect, useState, type JSX } from "react";
import * as stylex from "@stylexjs/stylex";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { VStack } from "@astryxdesign/core/VStack";
import { apiErrorMessage } from "../lib/api.ts";
import { getShell, type LocalApproval, type LocalApprovalDecision } from "../lib/shell.ts";

const styles = stylex.create({
  detail: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", minWidth: 0, margin: 0, maxHeight: "40dvh", overflow: "auto" },
  actions: { display: "flex", flexWrap: "wrap", gap: "var(--spacing-2)" },
});

export function LocalApprovalPrompt(): JSX.Element | null {
  const [queue, setQueue] = useState<(LocalApproval & { busy: boolean; error?: string })[]>([]);
  const [startupError, setStartupError] = useState<string>();
  useEffect(() => {
    const sidecar = getShell().localSidecar;
    let active = true;
    void sidecar.start().catch(error => { if (active) setStartupError(apiErrorMessage(error, "Local actions are unavailable.")); });
    const stopDismiss = sidecar.onApprovalDismiss(jobId => {
      setQueue(pending => pending.filter(approval => approval.jobId !== jobId));
    });
    const stopApproval = sidecar.onApproval(approval => {
      setQueue(pending => [...pending, { ...approval, busy: false }]);
    });
    return () => { active = false; stopApproval(); stopDismiss(); };
  }, []);

  const approval = queue[0];
  if (approval === undefined) return startupError === undefined ? null : <Banner status="error" title={startupError} />;

  let detail = approval.path;
  if (approval.action === "run") detail = approval.command;
  if (approval.action === "search") detail = `Query:\n${approval.query}\nPath:\n${approval.path}`;
  if (approval.action === "transfer") detail = `Path:\n${approval.path}\nDestination:\n${approval.destination}`;

  const decide = async (decision: LocalApprovalDecision): Promise<void> => {
    if (approval.busy) return;
    setQueue(pending => pending.map(item => item.jobId === approval.jobId ? { ...item, busy: true, error: "" } : item));
    try {
      await getShell().localSidecar.decide(approval.jobId, decision);
      setQueue(pending => pending.filter(item => item.jobId !== approval.jobId));
    } catch (error) {
      setQueue(pending => pending.map(item => item.jobId === approval.jobId
        ? { ...item, busy: false, error: apiErrorMessage(error, "The decision could not be sent. Try again.") }
        : item));
    }
  };

  return (
    <Dialog key={approval.jobId} isOpen purpose="required" onOpenChange={() => {}} width={640} data-testid="local-approval">
      <DialogHeader title={`Allow local ${approval.action} on ${approval.hostname}?`} subtitle="Choose whether the Local Sidecar may perform this action on this device." />
      <VStack gap={4} padding={4}>
        <pre {...stylex.props(styles.detail)} data-testid="local-approval-detail">{detail}</pre>
        {approval.error ? <Banner status="error" title={approval.error} /> : null}
        <div {...stylex.props(styles.actions)} aria-busy={approval.busy}>
          <Button label="Allow once" variant="primary" isDisabled={approval.busy} onClick={() => void decide("allow-once")} />
          <Button label="Always allow" variant="secondary" isDisabled={approval.busy} onClick={() => void decide("always")} />
          <Button label="Never allow" variant="secondary" isDisabled={approval.busy} onClick={() => void decide("never")} />
          <Button label="Deny" variant="ghost" isDisabled={approval.busy} onClick={() => void decide("deny")} />
        </div>
      </VStack>
    </Dialog>
  );
}
