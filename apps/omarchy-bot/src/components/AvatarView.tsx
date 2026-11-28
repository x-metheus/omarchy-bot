import * as stylex from "@stylexjs/stylex";
import type { JSX } from "react";
import type { AvatarDto } from "@omarchy-bot/protocol";
import { Avatar } from "@astryxdesign/core/Avatar";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { avatarStatusScope, avatarStatusStyles } from "./avatarStatus.stylex.ts";
import { renderAvatarRecipe, type AvatarPresentation } from "./avatarRenderer.ts";
import { withDeviceToken } from "../lib/urls.ts";

export type { AvatarPresentation } from "./avatarRenderer.ts";

interface AvatarViewBaseProps {
  avatar: AvatarDto;
  name: string;
  size?: "xsm" | "sm" | "md" | "lg" | number;
  presentation?: AvatarPresentation;
  tooltip?: string | boolean;
}

export type AvatarViewProps =
  | (AvatarViewBaseProps & { decorative: true; label?: never })
  | (AvatarViewBaseProps & { decorative?: false; label?: string });

const workingPulse = stylex.keyframes({
  "0%, 100%": { transform: "scale(1)", opacity: 0.88 },
  "50%": { transform: "scale(1.05)", opacity: 1 },
});

const styles = stylex.create({
  working: {
    animationName: { default: workingPulse, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "var(--duration-slow-max)",
    animationTimingFunction: "var(--ease-standard)",
    animationIterationCount: "infinite",
  },
});
function avatarSource(avatar: AvatarDto, presentation: AvatarPresentation): string | undefined {
  if (avatar.kind !== "upload") return renderAvatarRecipe(avatar.recipe, presentation);
  return /^\/api\/bots\/[\w-]+\/avatar$/.test(avatar.url) ? withDeviceToken(avatar.url) : undefined;
}

function avatarTestId(avatar: AvatarDto): string {
  return avatar.kind === "upload" ? "avatar-upload" : `avatar-${avatar.recipe.style}`;
}

/**
 * Safe Bot avatar rendering. Recipe data is rendered by pinned local DiceBear
 * styles only; uploaded images must use the daemon's same-origin avatar route.
 */
export function AvatarView({
  avatar,
  name,
  size = "md",
  presentation = "static",
  decorative = false,
  label,
  tooltip,
}: AvatarViewProps): JSX.Element {
  const src = avatarSource(avatar, presentation);
  const motionStyle = presentation === "working" && avatar.kind === "upload" ? styles.working : undefined;

  return (
    <HStack
      as="span"
      data-avatar-presentation={presentation}
      data-testid="avatar-view"
    >
      <Avatar
        name={name}
        {...(decorative
          ? { "aria-hidden": "true" as const, "aria-label": "", role: "presentation" as const, tooltip: false as const }
          : {})}
        {...(!decorative && label !== undefined ? { alt: label } : {})}
        {...(!decorative && tooltip !== undefined ? { tooltip } : {})}
        {...(src !== undefined ? { src } : {})}
        {...(motionStyle !== undefined ? { xstyle: motionStyle } : {})}
        size={size}
        data-testid={avatarTestId(avatar)}
      />
    </HStack>
  );
}

export function WorkingAvatarView({ avatar, name }: { avatar: AvatarDto; name: string }): JSX.Element {
  const explanation = `${name} is working`;
  const src = avatarSource(avatar, "working");
  const motionStyle = avatar.kind === "upload" ? styles.working : undefined;

  return (
    <HStack paddingInline={2} gap={2} vAlign="center" xstyle={[avatarStatusScope, avatarStatusStyles.identity]} data-testid="working-avatar">
      <HStack
        as="span"
        role="img"
        aria-label={explanation}
        tabIndex={0}
        data-avatar-presentation="working"
        xstyle={avatarStatusStyles.focusTarget}
      >
        <Avatar
          name={name}
          aria-hidden="true"
          aria-label=""
          role="presentation"
          tooltip={false}
          {...(src !== undefined ? { src } : {})}
          {...(motionStyle !== undefined ? { xstyle: motionStyle } : {})}
          size="sm"
          data-avatar-presentation="working"
          data-testid={avatarTestId(avatar)}
        />
      </HStack>
      <span {...stylex.props(avatarStatusStyles.reveal, avatarStatusStyles.transcriptReveal)} aria-hidden="true" data-testid="working-avatar-status">
        <Text type="supporting" color="secondary" xstyle={[avatarStatusStyles.content, avatarStatusStyles.nameLine]}>
          <span {...stylex.props(avatarStatusStyles.name)} data-testid="working-avatar-name">{name}</span>
          <span {...stylex.props(avatarStatusStyles.workingSuffix)} data-testid="working-avatar-suffix">{" is working"}</span>
        </Text>
      </span>
    </HStack>
  );
}
