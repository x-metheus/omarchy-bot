// Geometry and animation from Lucide Animated. See LICENSE.
import { motion, type Variants } from "motion/react";
import { AnimatedIcon, type AnimatedIconProps } from "./animated-icon";

const ARROW_VARIANTS: Variants = {
  normal: { y: 0 },
  animate: {
    y: 2,
    transition: {
      type: "spring",
      stiffness: 200,
      damping: 10,
      mass: 1,
    },
  },
};

export function DownloadIcon(props: AnimatedIconProps) {
  return (
    <AnimatedIcon {...props}>
      {(controls) => (
        <>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <motion.g animate={controls} variants={ARROW_VARIANTS}>
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" x2="12" y1="15" y2="3" />
          </motion.g>
        </>
      )}
    </AnimatedIcon>
  );
}
