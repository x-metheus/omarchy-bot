// Geometry and animation from Lucide Animated. See LICENSE.
import { motion, type Variants } from "motion/react";
import { AnimatedIcon, type AnimatedIconProps } from "./animated-icon";

const PATH_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: (i: number) => ({
    opacity: [0, 1],
    transition: { delay: i * 0.1, duration: 0.3 },
  }),
};

export function SunIcon(props: AnimatedIconProps) {
  return (
    <AnimatedIcon {...props}>
      {(controls) => (
        <>
          <circle cx="12" cy="12" r="4" />
          {[
            "M12 2v2",
            "m19.07 4.93-1.41 1.41",
            "M20 12h2",
            "m17.66 17.66 1.41 1.41",
            "M12 20v2",
            "m6.34 17.66-1.41 1.41",
            "M2 12h2",
            "m4.93 4.93 1.41 1.41",
          ].map((d, index) => (
            <motion.path
              animate={controls}
              custom={index + 1}
              d={d}
              key={d}
              variants={PATH_VARIANTS}
            />
          ))}
        </>
      )}
    </AnimatedIcon>
  );
}
