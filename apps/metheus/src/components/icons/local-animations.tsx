import {
  CircleAlert, Ellipsis, File, Image, KeyRound, Monitor, PanelLeft,
  Paperclip, Pencil, Save, Trash2, type LucideIcon,
} from "lucide-react";
import { motion, type TargetAndTransition } from "motion/react";
import { useIconMotion, type AnimatedIconProps } from "./animated-icon";

// Keep the exact Lucide glyphs for names that have no Lucide Animated entry.
function animateLucideIcon(Glyph: LucideIcon, gesture: TargetAndTransition) {
  const AnimatedGlyph = motion.create(Glyph);
  const variants = {
    normal: { scale: 1, rotate: 0, x: 0, y: 0 },
    animate: gesture,
  };

  return function AnimatedLucideIcon({ animateOnInteraction = true, ...props }: AnimatedIconProps) {
    const { ref, controls } = useIconMotion(animateOnInteraction);
    return <AnimatedGlyph ref={ref} data-animated-icon="" aria-hidden="true" initial="normal" animate={controls}
      variants={variants} transition={{ duration: 0.28, ease: "easeInOut" }} {...props} />;
  };
}

export const CircleAlertIcon = animateLucideIcon(CircleAlert, { scale: [1, 1.17, 1] });
export const EllipsisIcon = animateLucideIcon(Ellipsis, { scale: [1, 1.18, 1] });
export const FileIcon = animateLucideIcon(File, { y: [0, -2, 0] });
export const ImageIcon = animateLucideIcon(Image, { scale: [1, 1.12, 1] });
export const KeyRoundIcon = animateLucideIcon(KeyRound, { rotate: [0, -20, 0] });
export const MonitorIcon = animateLucideIcon(Monitor, { y: [0, -2, 0] });
export const PanelLeftIcon = animateLucideIcon(PanelLeft, { x: [0, 2, 0] });
export const PaperclipIcon = animateLucideIcon(Paperclip, { rotate: [0, -28, 0] });
export const PencilIcon = animateLucideIcon(Pencil, { x: [0, 1, -1, 0], rotate: [0, -12, 8, 0] });
export const SaveIcon = animateLucideIcon(Save, { y: [0, 2, 0] });
export const Trash2Icon = animateLucideIcon(Trash2, { rotate: [0, -10, 10, 0] });
