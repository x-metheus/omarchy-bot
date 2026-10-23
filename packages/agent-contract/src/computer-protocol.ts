export interface ComputerWindowListItem {
  id: string;
  title: string;
  appId?: string;
  focused: boolean;
  pid?: number;
  bounds?: { x: number; y: number; width: number; height: number };
  workspace?: string;
  clientType?: "x11" | "wayland";
}

