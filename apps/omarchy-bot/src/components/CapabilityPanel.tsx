import { useCallback, useLayoutEffect, type JSX, type RefObject } from "react";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { StackItem } from "@astryxdesign/core/Stack";
import type { ComputerSurfaceProps } from "./ComputerPanel.tsx";
import { ComputerSurface } from "./ComputerPanel.tsx";
import { WorkspaceDrawer } from "./WorkspaceDrawer.tsx";

export interface CapabilityPanelProps extends ComputerSurfaceProps {
  open: boolean;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

/** The workspace's sole right-side Computer Surface region. */
export function CapabilityPanel({
  open,
  returnFocusRef,
  onClose,
  bot,
  ...surfaceProps
}: CapabilityPanelProps): JSX.Element {
  const closePanel = useCallback((): void => {
    onClose();
    requestAnimationFrame(() => returnFocusRef.current?.focus());
  }, [onClose, returnFocusRef]);

  useLayoutEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closePanel();
    };
    // Expanded Web Control consumes Escape during capture before drawer dismissal.
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closePanel, open]);

  return (
    <WorkspaceDrawer
      open={open}
      width="560px"
      label="Workspace capabilities"
      data-testid="capability-presence"
      panelTestId="workspace-capabilities"
      header={
        <HStack gap={2} padding={4} vAlign="center">
          <StackItem size="fill">
            <Heading level={2}>Capabilities</Heading>
          </StackItem>
          <IconButton
            label="Close capabilities"
            tooltip="Close capabilities"
            icon={<Icon icon="close" size="md" />}
            variant="ghost"
            onClick={closePanel}
            data-testid="capabilities-close"
          />
        </HStack>
      }
    >
      <section>
        <HStack gap={2} padding={4} paddingBlockEnd={0} vAlign="center">
          <Heading level={3}>{bot.name}’s screen</Heading>
        </HStack>
        <ComputerSurface
          {...surfaceProps}
          bot={bot}
        />
      </section>
    </WorkspaceDrawer>
  );
}
