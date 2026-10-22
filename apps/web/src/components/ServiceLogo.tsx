import type { JSX } from "react";
import * as stylex from "@stylexjs/stylex";
import { Icon } from "@iconify/react/offline";
import { Text } from "@astryxdesign/core/Text";
import { SERVICE_ICONS } from "../lib/serviceIcons.ts";

const styles = stylex.create({
  tile: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: 32,
    height: 32,
    borderRadius: "var(--radius-element)",
    backgroundColor: "#fff",
  },
  large: { width: 40, height: 40 },
});

export function ServiceLogo({ serviceId, serviceName, size = "md" }: {
  serviceId: string;
  serviceName: string;
  size?: "md" | "lg";
}): JSX.Element {
  const icon = SERVICE_ICONS[serviceId] ?? (serviceId === "intercom-eu" ? SERVICE_ICONS.intercom : undefined);
  const pixels = size === "lg" ? 24 : 20;
  return <span {...stylex.props(styles.tile, size === "lg" && styles.large)} aria-hidden="true">
    {icon
      ? <Icon icon={icon} width={pixels} height={pixels} />
      : <Text>{serviceName.trim().charAt(0) || "?"}</Text>}
  </span>;
}
