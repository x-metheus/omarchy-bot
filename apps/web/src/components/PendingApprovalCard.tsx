import type { JSX } from "react";
import * as stylex from "@stylexjs/stylex";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import type { ApprovalAnswerBodyDto, ApprovalDto } from "@omarchy-bot/protocol";
import { displayPath } from "../lib/displayPath.ts";

const styles = stylex.create({
  path: { whiteSpace: "pre-wrap" },
});

export interface PendingApprovalCardData {
  approval: ApprovalDto;
  botName: string | undefined;
  isBusy: boolean;
  error: string | undefined;
}

interface PendingApprovalCardProps extends PendingApprovalCardData {
  onAnswer: (answer: ApprovalAnswerBodyDto["answer"], button: HTMLButtonElement) => void;
}

export function PendingApprovalCard({ approval, botName, isBusy, error, onAnswer }: PendingApprovalCardProps): JSX.Element {
  return (
    <Banner
      status="warning"
      container="section"
      title={`${botName ?? "A Bot"} wants to ${approval.tool} a file`}
      description={
        <>
          <Text type="inherit" color="inherit" {...stylex.props(styles.path)}>{displayPath(approval.path)}</Text>
          {error !== undefined ? <Text type="inherit" color="inherit" display="block">{error}</Text> : null}
        </>
      }
      endContent={
        <>
          <Button
            label="Allow once"
            variant="secondary"
            size="sm"
            isDisabled={isBusy}
            onClick={(event) => onAnswer("allow_once", event.currentTarget)}
            data-approval-first-action=""
          />
          <Button
            label="Always allow this folder"
            variant="secondary"
            size="sm"
            isDisabled={isBusy}
            onClick={(event) => onAnswer("allow_folder", event.currentTarget)}
          />
          <Button
            label="Deny"
            variant="ghost"
            size="sm"
            isDisabled={isBusy}
            onClick={(event) => onAnswer("deny", event.currentTarget)}
          />
        </>
      }
      aria-busy={isBusy}
      data-testid="pending-approval-card"
      data-approval-id={approval.id}
    />
  );
}
