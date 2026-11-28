// Geometry and animation from Lucide Animated. See LICENSE.
import { motion, type Transition } from "motion/react";
import { AnimatedIcon, type AnimatedIconProps } from "./animated-icon";

const DEFAULT_TRANSITION: Transition = {
  times: [0, 0.4, 1],
  duration: 0.5,
};

export function ChevronUpIcon(props: AnimatedIconProps) {
  return (
    <AnimatedIcon {...props}>
      {(controls) => (
        <>
          <motion.path
            animate={controls}
            d="m18 15-6-6-6 6"
            transition={DEFAULT_TRANSITION}
            variants={{
              normal: { y: 0 },
              animate: { y: [0, -2, 0] },
            }}
          />
        </>
      )}
    </AnimatedIcon>
  );
}
