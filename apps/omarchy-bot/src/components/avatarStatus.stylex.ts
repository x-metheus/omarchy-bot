import * as stylex from "@stylexjs/stylex";

export const avatarStatusScope = stylex.defineMarker();

export const avatarStatusStyles = stylex.create({
  reveal: {
    "--duration-fast-max": "160ms",
    "--duration-fast-min": "100ms",
    "--_avatar-status-duration": {
      default: "var(--duration-fast-min)",
      [stylex.when.ancestor(":has([data-avatar-presentation]:hover)", avatarStatusScope)]: {
        "@media (hover: hover)": "var(--duration-fast-max)",
      },
      [stylex.when.ancestor(":focus-visible", avatarStatusScope)]: "var(--duration-fast-max)",
      [stylex.when.ancestor(":has(:focus-visible)", avatarStatusScope)]: "var(--duration-fast-max)",
    },
    "--_avatar-status-delay": {
      default: "0s, 0s, 0s, var(--duration-fast-min)",
      [stylex.when.ancestor(":has([data-avatar-presentation]:hover)", avatarStatusScope)]: {
        "@media (hover: hover)": "80ms, 80ms, 80ms, 0s",
      },
      [stylex.when.ancestor(":focus-visible", avatarStatusScope)]: "0s",
      [stylex.when.ancestor(":has(:focus-visible)", avatarStatusScope)]: "0s",
    },
    display: "inline-grid",
    gridTemplateColumns: {
      default: "0fr",
      [stylex.when.ancestor(":has([data-avatar-presentation]:hover)", avatarStatusScope)]: {
        "@media (hover: hover)": "1fr",
      },
      [stylex.when.ancestor(":focus-visible", avatarStatusScope)]: "1fr",
      [stylex.when.ancestor(":has(:focus-visible)", avatarStatusScope)]: "1fr",
    },
    opacity: {
      default: 0,
      [stylex.when.ancestor(":has([data-avatar-presentation]:hover)", avatarStatusScope)]: {
        "@media (hover: hover)": 1,
      },
      [stylex.when.ancestor(":focus-visible", avatarStatusScope)]: 1,
      [stylex.when.ancestor(":has(:focus-visible)", avatarStatusScope)]: 1,
    },
    "--_avatar-status-translation": {
      default: "translateX(-4px)",
      [stylex.when.ancestor(":has([data-avatar-presentation]:hover)", avatarStatusScope)]: {
        "@media (hover: hover)": "translateX(0)",
      },
      [stylex.when.ancestor(":focus-visible", avatarStatusScope)]: "translateX(0)",
      [stylex.when.ancestor(":has(:focus-visible)", avatarStatusScope)]: "translateX(0)",
    },
    transform: {
      default: "var(--_avatar-status-translation)",
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    visibility: {
      default: "hidden",
      [stylex.when.ancestor(":has([data-avatar-presentation]:hover)", avatarStatusScope)]: {
        "@media (hover: hover)": "visible",
      },
      [stylex.when.ancestor(":focus-visible", avatarStatusScope)]: "visible",
      [stylex.when.ancestor(":has(:focus-visible)", avatarStatusScope)]: "visible",
    },
    transitionProperty: "grid-template-columns, opacity, transform, visibility",
    transitionDuration: {
      default: "var(--_avatar-status-duration), var(--_avatar-status-duration), var(--_avatar-status-duration), 0s",
      "@media (prefers-reduced-motion: reduce)": "0s",
    },
    transitionDelay: {
      default: "var(--_avatar-status-delay)",
      "@media (prefers-reduced-motion: reduce)": "0s",
    },
    transitionTimingFunction: "var(--ease-standard)",
    minWidth: 0,
    flexShrink: 0,
    pointerEvents: "none",
  },
  content: {
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "pre",
  },
  transcriptReveal: {
    flexShrink: 1,
  },
  workingSuffix: {
    flexShrink: 0,
  },
  nameLine: {
    display: "flex",
    minWidth: 0,
  },
  name: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  identity: {
    minWidth: 0,
  },
  focusTarget: {
    flexShrink: 0,
    outline: {
      default: "none",
      ":focus-visible": "var(--focus-outline-width) var(--focus-outline-style) var(--focus-outline-color)",
    },
    outlineOffset: "var(--focus-outline-offset)",
    borderRadius: "var(--radius-full)",
  },
});
