// Geometry and animation from Lucide Animated. See LICENSE.
import { motion, type Variants } from "motion/react";
import { AnimatedIcon, type AnimatedIconProps } from "./animated-icon";

const PATH_VARIANTS: Variants = {
  normal: { d: "m5 12 7-7 7 7", translateY: 0 },
  animate: {
    d: "m5 12 7-7 7 7",
    translateY: [0, 3, 0],
    transition: {
      duration: 0.4,
    },
  },
};

const SECOND_PATH_VARIANTS: Variants = {
  normal: { d: "M12 19V5" },
  animate: {
    d: ["M12 19V5", "M12 19V10", "M12 19V5"],
    transition: {
      duration: 0.4,
    },
  },
};

export function ArrowUpIcon(props: AnimatedIconProps) {
  return (
    <AnimatedIcon {...props}>
      {(controls) => (
        <>
          <motion.path
            animate={controls}
            d="m5 12 7-7 7 7"
            variants={PATH_VARIANTS}
          />
          <motion.path
            animate={controls}
            d="M12 19V5"
            variants={SECOND_PATH_VARIANTS}
          />
        </>
      )}
    </AnimatedIcon>
  );
}
