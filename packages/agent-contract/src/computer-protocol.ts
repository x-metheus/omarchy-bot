export interface ComputerWindowListItem {
  id: string;
  title: string;
  appId?: string;
  focused: boolean;
  pid?: number;
  bounds?: { x: number; y: number; width: number; height: number };
  workspace?: string;
  /** Sway's own visibility: a container on a hidden workspace (scratchpad) is not shown. */
  visible?: boolean;
  clientType?: "x11" | "wayland";
}

