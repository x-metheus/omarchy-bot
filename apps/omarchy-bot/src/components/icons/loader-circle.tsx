// Geometry and animation from Lucide Animated. See LICENSE.
import { motion, type Transition, type Variants } from "motion/react";
import { AnimatedIcon, type AnimatedIconProps } from "./animated-icon";

const G_VARIANTS: Variants = {
  normal: { rotate: 0 },
  animate: {
    rotate: 360,
    transition: {
      repeat: Number.POSITIVE_INFINITY,
      duration: 0.8,
      ease: "linear",
    },
  },
};

const DEFAULT_TRANSITION: Transition = {
  type: "spring",
  stiffness: 50,
  damping: 10,
};

export function LoaderCircleIcon(props: AnimatedIconProps) {
  return (
    <AnimatedIcon {...props}>
      {(controls) => (
        <>
          <motion.path
            animate={controls}
            d="M21 12a9 9 0 1 1-6.219-8.56"
            style={{ transformOrigin: "12px 12px" }}
            transition={DEFAULT_TRANSITION}
            variants={G_VARIANTS}
          />
        </>
      )}
    </AnimatedIcon>
  );
}
