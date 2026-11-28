// Geometry and animation from Lucide Animated. See LICENSE.
import { AnimatedIcon, type AnimatedIconProps } from "./animated-icon";

export function RefreshCwIcon(props: AnimatedIconProps) {
  return (
    <AnimatedIcon
      {...props}
      transition={{ type: "spring", stiffness: 250, damping: 25 }}
      variants={{
        normal: { rotate: "0deg" },
        animate: { rotate: "50deg" },
      }}
    >
      {() => (
        <>
          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
          <path d="M8 16H3v5" />
        </>
      )}
    </AnimatedIcon>
  );
}
