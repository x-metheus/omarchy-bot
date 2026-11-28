import { useLayoutEffect, useState, type CSSProperties, type JSX, type ReactNode } from "react";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { LayoutPanel } from "@astryxdesign/core/Layout";
import { VStack } from "@astryxdesign/core/VStack";

export interface WorkspaceDrawerProps {
  open: boolean;
  /** Open width on desktop; mobile drawers always cover the viewport. */
  width: string;
  label: string;
  header: ReactNode;
  children: ReactNode;
  "data-testid"?: string;
  panelTestId?: string;
}

/**
 * The workspace's right-side drawer. Stays mounted so open and close both animate;
 * while closed it is inert and hidden from assistive technology.
 */
export function WorkspaceDrawer({
  open,
  width,
  label,
  header,
  children,
  "data-testid": testId,
  panelTestId,
}: WorkspaceDrawerProps): JSX.Element {
  const { isMobile } = useAppShellMobile();
  const drawerWidth = `min(${width}, 100vw)`;
  const [phase, setPhase] = useState<"closed" | "entering" | "ready">("closed");

  useLayoutEffect(() => {
    if (!open) {
      setPhase("closed");
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPhase("ready");
      return;
    }
    if (phase === "ready") return;
    // Paint the initial transform before entry, then entry before mounting heavy content.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setPhase(phase === "closed" ? "entering" : "ready"));
    });
    return () => cancelAnimationFrame(frame);
  }, [open, phase]);

  return (
    <VStack
      gap={0}
      height="100%"
      className="workspace-drawer"
      style={{ "--workspace-drawer-width": drawerWidth } as CSSProperties}
      data-open={open}
      data-entered={open && phase !== "closed"}
      data-mobile={isMobile}
      {...(testId !== undefined ? { "data-testid": testId } : {})}
      inert={!open}
      aria-hidden={!open}
    >
      <LayoutPanel
        width={drawerWidth}
        padding={0}
        hasDivider
        isScrollable
        label={label}
        role="complementary"
        className="workspace-drawer-panel"
        style={{ width: drawerWidth, minWidth: 0, maxWidth: "100vw", height: "100%", animation: "none" }}
        {...(panelTestId !== undefined ? { "data-testid": panelTestId } : {})}
      >
        {header}
        {open && phase === "ready" ? children : null}
      </LayoutPanel>
    </VStack>
  );
}
