// Geometry and animation from Lucide Animated. See LICENSE.
import { type Transition, type Variants } from "motion/react";
import { AnimatedIcon, type AnimatedIconProps } from "./animated-icon";

const SVG_VARIANTS: Variants = {
  normal: {
    rotate: 0,
  },
  animate: {
    rotate: [0, -10, 10, -5, 5, 0],
  },
};

const SVG_TRANSITION: Transition = {
  duration: 1.2,
  ease: "easeInOut",
};

export function MoonIcon(props: AnimatedIconProps) {
  return (
    <AnimatedIcon
      {...props}
      transition={SVG_TRANSITION}
      variants={SVG_VARIANTS}
    >
      {() => (
        <>
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </>
      )}
    </AnimatedIcon>
  );
}
