import type { JSX, RefObject } from "react";
import { useCallback, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Heading } from "@astryxdesign/core/Heading";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { api, apiErrorMessage } from "../lib/api.ts";
import { BottomSheetWithReturnFocus } from "./BottomSheetWithReturnFocus.tsx";

interface CreateBotDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (botId: string) => void;
  mobileReturnFocusRef: RefObject<HTMLElement | null>;
}

export function CreateBotDialog({
  isOpen,
  onClose,
  onCreated,
  mobileReturnFocusRef,
}: CreateBotDialogProps): JSX.Element {
  const { isMobile } = useAppShellMobile();
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [nameInvalid, setNameInvalid] = useState(false);
  const [creating, setCreating] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const dialogGenerationRef = useRef(0);

  const reset = useCallback((): void => {
    setName("");
    setInstructions("");
    setError(undefined);
    setNameInvalid(false);
  }, []);

  const submit = useCallback(async (): Promise<void> => {
    if (name.trim().length === 0) {
      setNameInvalid(true);
      setError("Give this bot a name.");
      nameRef.current?.focus();
      return;
    }
    const dialogGeneration = dialogGenerationRef.current;
    setCreating(true);
    setNameInvalid(false);
    setError(undefined);
    try {
      const bot = await api.createBot({ name: name.trim(), instructions });
      reset();
      onCreated(bot.id);
      onClose();
    } catch (createError) {
      if (dialogGenerationRef.current === dialogGeneration) {
        setError(apiErrorMessage(createError, "This bot couldn’t be created. Check your connection and try again."));
        nameRef.current?.focus();
      }
    } finally {
      setCreating(false);
    }
  }, [name, instructions, onCreated, onClose, reset]);

  const handleOpenChange = (open: boolean): void => {
    if (!open) {
      dialogGenerationRef.current += 1;
      onClose();
      reset();
    }
  };

  const content = (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <VStack padding={4} gap={4}>
        {isMobile ? <Heading level={2}>Create a bot</Heading> : null}
        {error !== undefined ? <Banner status="error" title={error} /> : null}
        <TextInput
          ref={nameRef}
          autoFocus
          label="Name"
          value={name}
          onChange={(value) => {
            setName(value);
            if (nameInvalid && value.trim().length > 0) setNameInvalid(false);
          }}
          placeholder="e.g. Release Shepherd"
          isRequired
          {...(nameInvalid ? { status: { type: "error" as const, message: "Enter a name." } } : {})}
          width="100%"
          data-testid="create-bot-name"
        />
        <TextArea
          label="Job / Instructions"
          value={instructions}
          onChange={setInstructions}
          placeholder="What should this bot do?"
          width="100%"
          data-testid="create-bot-instructions"
        />
        <Button
          label="Create bot"
          variant="primary"
          type="submit"
          isLoading={creating}
          data-testid="create-bot-submit"
        />
      </VStack>
    </form>
  );

  if (isMobile) {
    return (
      <BottomSheetWithReturnFocus
        label="Create a bot"
        returnFocusRef={mobileReturnFocusRef}
        isOpen={isOpen}
        onOpenChange={handleOpenChange}
        height="tall"
        purpose="form"
      >
        {content}
      </BottomSheetWithReturnFocus>
    );
  }

  return (
    <Dialog isOpen={isOpen} onOpenChange={handleOpenChange} width={520} purpose="form">
      <DialogHeader title="Create a bot" subtitle="Name your teammate and describe its job." />
      {content}
    </Dialog>
  );
}
