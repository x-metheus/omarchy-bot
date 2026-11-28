import { useState, type FormEvent, type JSX } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { VStack } from "@astryxdesign/core/VStack";
import type { BotViewDto } from "@omarchy-bot/protocol";
import { apiErrorMessage } from "../lib/api.ts";

export function SkillCreationForm({ bots, selectedBotId, onCreate, onCancel }: {
  bots: BotViewDto[];
  selectedBotId?: string;
  onCreate(botId: string, description: string): Promise<void>;
  onCancel(): void;
}): JSX.Element {
  const [chosenBotId, setChosenBotId] = useState(selectedBotId);
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const botId = bots.some((bot) => bot.id === chosenBotId) ? chosenBotId : bots[0]?.id;
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (pending || !botId || !description.trim()) return;
    setPending(true);
    setError(undefined);
    try { await onCreate(botId, description.trim()); }
    catch (failure) { setError(apiErrorMessage(failure, "Skill creation could not start.")); }
    finally { setPending(false); }
  };
  return <form onSubmit={(event) => void submit(event)}>
    <VStack gap={3}>
      <Heading level={3}>Create skill</Heading>
      <Text color="secondary">Your Bot uses Skill Creator to build and validate a reusable Skill in the shared installation for all Bots and Agents. Nothing is published automatically.</Text>
      {bots.length ? <RadioList label="Create with Bot" value={botId} onChange={setChosenBotId} width="100%">
        {bots.map((bot) => <RadioListItem key={bot.id} value={bot.id} label={bot.name} isDisabled={pending} />)}
      </RadioList> : <Banner status="warning" title="Create a Bot first" description="Close Plugins and choose New bot, then return here to create a Skill." />}
      <TextArea label="What should this Skill do?" placeholder="Describe when to use it, what it should do, and an example result." value={description} onChange={setDescription} isRequired isDisabled={pending} width="100%" />
      <Text color="secondary">Starts a new conversation. Existing conversations and unsent drafts stay unchanged.</Text>
      {error ? <Banner status="error" title="Creation not started" description={error} /> : null}
      {pending ? <Text role="status">Starting creation…</Text> : null}
      <Button label="Start creation" type="submit" isDisabled={pending || !botId || !description.trim()} />
      <Button label="Cancel" variant="ghost" isDisabled={pending} onClick={onCancel} />
    </VStack>
  </form>;
}
