import { useId, useMemo, useState, type JSX } from "react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Item } from "@astryxdesign/core/Item";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import type { PluginStateDto } from "@omarchy-bot/protocol";
import { ServiceLogo } from "./ServiceLogo.tsx";

const categories = [
  { id: "documents", label: "Documents & Files", services: ["google-drive", "dropbox", "notion"] },
  { id: "communication", label: "Communication", services: ["gmail"] },
  { id: "productivity", label: "Productivity", services: ["workiq", "asana"] },
  { id: "development", label: "Development", services: ["github", "linear"] },
  { id: "support", label: "Customer Support", services: ["intercom", "intercom-eu"] },
  { id: "sales", label: "Sales", services: ["hubspot"] },
  { id: "design", label: "Design", services: ["miro"] },
  { id: "scheduling", label: "Scheduling", services: ["google-calendar"] },
  { id: "other", label: "Other", services: [] },
];
const otherCategory = categories[categories.length - 1]!;
const styles = stylex.create({
  root: { minWidth: 0, width: "100%" },
  summary: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "var(--spacing-2)" },
  grid: { display: "grid", gridTemplateColumns: { default: "repeat(2, minmax(0, 1fr))", "@media (max-width: 640px)": "minmax(0, 1fr)" }, gap: "var(--spacing-3)", minWidth: 0 },
  entry: { minWidth: 0, padding: "var(--spacing-2)", borderRadius: "var(--radius-container)" },
  status: { paddingInline: "var(--spacing-2)" },
});

export function ServicesBrowser({ data, onSelectService }: {
  data: PluginStateDto;
  onSelectService(serviceId: string): void;
}): JSX.Element {
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const panelId = useId();
  const services = useMemo(() => data.providers.flatMap((provider) => provider.services.map((service) => {
    const category = categories.find((entry) => entry.services.includes(service.id)) ?? otherCategory;
    const accounts = data.accounts.filter((account) => account.providerId === provider.id && account.enabledServices.includes(service.id));
    const needsAuthorization = accounts.some((account) => account.status === "reauthorize" || account.components?.some((component) => component.serviceId === service.id && component.status === "needs-auth"));
    const connected = accounts.filter((account) => account.status === "connected" && account.components?.some((component) => component.serviceId === service.id && component.status === "connected")).length;
    const status = connected ? `${connected} connected account${connected === 1 ? "" : "s"}` : needsAuthorization ? "Authorization required" : accounts.length ? "Configured; check connection" : provider.setupReason ? "Setup required" : "Not connected";
    return { provider, service, category, connected, status, searchText: `${service.name} ${provider.name} ${service.description} ${category.label}`.toLocaleLowerCase() };
  })), [data.providers, data.accounts]);
  const availableCategories = categories.filter((category) => services.some((entry) => entry.category.id === category.id));
  const activeCategory = selectedCategory === "all" || selectedCategory === "connected" || availableCategories.some((category) => category.id === selectedCategory) ? selectedCategory : "all";
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const visible = services.filter((entry) => (activeCategory === "all" || (activeCategory === "connected" ? entry.connected > 0 : entry.category.id === activeCategory)) && terms.every((term) => entry.searchText.includes(term)));
  const groups = availableCategories.map((category) => ({ category, entries: visible.filter((entry) => entry.category.id === category.id) })).filter((group) => group.entries.length > 0);
  const connectedCount = services.filter((entry) => entry.connected > 0).length;
  const tabs = [{ id: "all", label: "All" }, { id: "connected", label: `Connected (${connectedCount})` }, ...availableCategories];

  return <VStack gap={4} {...stylex.props(styles.root)} data-testid="services-browser">
    <div {...stylex.props(styles.summary)}><Heading level={2}>Services</Heading><Text color="secondary">{services.length} services · {connectedCount} connected</Text></div>
    <TextInput label="Search services" placeholder="Search by name, provider, or what you want to do" value={search} onChange={setSearch} width="100%" />
    <TabList role="tablist" aria-label="Service categories" value={activeCategory} onChange={setSelectedCategory} size="sm" overflow="scroll">
      {tabs.map((tab) => <Tab key={tab.id} id={`${panelId}-${tab.id}`} value={tab.id} label={tab.label} panelId={panelId} />)}
    </TabList>
    <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${activeCategory}`} tabIndex={0}>
      <VStack gap={5}>
        {terms.length > 0 ? <Text role="status" color="secondary">{visible.length} matching service{visible.length === 1 ? "" : "s"}</Text> : null}
        {groups.map(({ category, entries }) => <VStack key={category.id} gap={2}>
          <div {...stylex.props(styles.summary)}>
            <Heading level={3}>{category.label}</Heading>
            {activeCategory === "all" ? <Button label="View all" aria-label={`View all ${category.label} services`} variant="ghost" size="sm" onClick={() => setSelectedCategory(category.id)} /> : null}
          </div>
          <div {...stylex.props(styles.grid)}>{entries.map(({ provider, service, status }) => <div key={`${provider.id}/${service.id}`} {...stylex.props(styles.entry)}>
            <Item startContent={<ServiceLogo serviceId={service.id} serviceName={service.name} />} label={service.name} description={service.description} onClick={() => onSelectService(service.id)} />
            <Text color="secondary" {...stylex.props(styles.status)}>{status}</Text>
          </div>)}</div>
        </VStack>)}
        {!visible.length ? <VStack gap={2}>
          <Heading level={3}>{!services.length ? "No services available" : activeCategory === "connected" && !terms.length ? "No connected services" : "No matching services"}</Heading>
          <Text color="secondary">{!services.length ? "The service catalog is currently unavailable." : "Try another search or browse all categories. Open a service to review its setup and accounts."}</Text>
          {search || activeCategory !== "all" ? <Button label="Show all services" variant="secondary" onClick={() => { setSearch(""); setSelectedCategory("all"); }} /> : null}
        </VStack> : null}
      </VStack>
    </div>
  </VStack>;
}
