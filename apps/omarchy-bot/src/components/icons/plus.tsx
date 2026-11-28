// Geometry and animation from Lucide Animated. See LICENSE.
import { AnimatedIcon, type AnimatedIconProps } from "./animated-icon";

export function PlusIcon(props: AnimatedIconProps) {
  return (
    <AnimatedIcon
      {...props}
      transition={{ type: "spring", stiffness: 100, damping: 15 }}
      variants={{
        normal: {
          rotate: 0,
        },
        animate: {
          rotate: 180,
        },
      }}
    >
      {() => (
        <>
          <path d="M5 12h14" />
          <path d="M12 5v14" />
        </>
      )}
    </AnimatedIcon>
  );
}
