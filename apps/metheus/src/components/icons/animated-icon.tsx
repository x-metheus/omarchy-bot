import { useEffect, useRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { motion, useAnimation, type MotionProps, type SVGMotionProps } from "motion/react";

type IconControls = ReturnType<typeof useAnimation>;
export type AnimatedIconProps = Omit<ComponentPropsWithoutRef<"svg">, keyof MotionProps | "children"> & {
  size?: string | number;
  animateOnInteraction?: boolean;
};

const triggerSelector = [
  "button", "a[href]", "[role='button']", "[role='menuitem']", "[role='menuitemradio']",
  "[role='menuitemcheckbox']", "[role='option']", "[data-slot='alert']", "[data-slot='trace-line']",
  "[data-slot='marker']", "[data-slot='attachment']", "[data-slot='empty']",
].join(", ");

export function useIconMotion(enabled: boolean) {
  const ref = useRef<SVGSVGElement>(null);
  const controls = useAnimation();

  useEffect(() => {
    const svg = ref.current;
    if (!enabled || !svg) return;
    const target = svg.closest(triggerSelector) ?? svg;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let hovered = target.matches(":hover");
    let focused = target.matches(":focus-visible");
    let active = false;

    function sync() {
      const disabled = target.matches(":disabled, [aria-disabled='true'], [data-disabled]");
      const next = !preference.matches && !disabled && (hovered || focused || target.hasAttribute("data-highlighted"));
      if (next === active) return;
      active = next;
      void controls.start(active ? "animate" : "normal");
    }

    function preferenceChanged() {
      if (!preference.matches) {
        sync();
        return;
      }
      active = false;
      controls.stop();
      void controls.start("normal", { duration: 0, delay: 0 });
    }

    function enter(event: Event) {
      if ((event as PointerEvent).pointerType === "touch") return;
      hovered = true;
      sync();
    }

    function leave() {
      hovered = false;
      sync();
    }

    function focus() {
      focused = target.matches(":focus-visible");
      sync();
    }

    function blur() {
      focused = false;
      sync();
    }

    target.addEventListener("pointerenter", enter);
    target.addEventListener("pointerleave", leave);
    target.addEventListener("focus", focus);
    target.addEventListener("blur", blur);
    preference.addEventListener("change", preferenceChanged);
    // Combobox options use aria-activedescendant, so keyboard focus stays on the input.
    const highlight = target.matches("[role='option']") ? new MutationObserver(sync) : undefined;
    highlight?.observe(target, { attributeFilter: ["data-highlighted"] });
    sync();
    return () => {
      target.removeEventListener("pointerenter", enter);
      target.removeEventListener("pointerleave", leave);
      target.removeEventListener("focus", focus);
      target.removeEventListener("blur", blur);
      preference.removeEventListener("change", preferenceChanged);
      highlight?.disconnect();
    };
  }, [controls, enabled]);

  return { ref, controls };
}

type AnimatedIconOptions = Pick<SVGMotionProps<SVGSVGElement>, "variants" | "transition" | "style">;

export function AnimatedIcon({ children, size = 24, animateOnInteraction = true, ...props }: AnimatedIconProps & AnimatedIconOptions & {
  children: (controls: IconControls) => ReactNode;
}) {
  const { ref, controls } = useIconMotion(animateOnInteraction);

  return <motion.svg ref={ref} data-animated-icon="" aria-hidden="true" initial="normal" animate={controls}
    width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg" {...props}>
    {children(controls)}
  </motion.svg>;
}
