// Geometry and animation from Lucide Animated. See LICENSE.
import { motion, type Transition } from "motion/react";
import { AnimatedIcon, type AnimatedIconProps } from "./animated-icon";

const DEFAULT_TRANSITION: Transition = {
  times: [0, 0.4, 1],
  duration: 0.5,
};

export function ChevronRightIcon(props: AnimatedIconProps) {
  return (
    <AnimatedIcon {...props}>
      {(controls) => (
        <>
          <motion.path
            animate={controls}
            d="m9 18 6-6-6-6"
            transition={DEFAULT_TRANSITION}
            variants={{
              normal: { x: 0 },
              animate: { x: [0, 2, 0] },
            }}
          />
        </>
      )}
    </AnimatedIcon>
  );
}
