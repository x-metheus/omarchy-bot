# Shared Plugins, Native Discovery, and Default Cross-Agent Skill Creation

Status: ready-for-agent

## Problem Statement

Users want every Bot to be a capable teammate in the Shared Workspace, not a separate plugin installation that must be configured by hand. Today the Bot Client separates connected services, custom MCP connections, and Skills, but official integrations are not represented as complete units containing their official tools, companion Skills, and authorization. A user can connect a service without receiving its official usage workflow, and some service cards expose locally maintained REST request tools rather than the provider's official Agent integration.

The current managed-plugin runtime is also disconnected from ordinary native Agent configuration. Managed Skills are stored in application data and supplied to Pi by absolute path. MCP connections run in the daemon and their tools are injected into Pi. That can make a managed capability available inside the product, but it does not make a custom MCP connection discoverable when a user starts an Agent directly in the Shared Workspace. Native edits and installations are not a complete, bidirectional management surface for the plugin panel.

Users should be able to ask a Bot to search for and install a Skill, add or change an MCP connection, or create a reusable Skill. The result must be visible in the Bot Client and available to other Bots, rather than hidden in the creating Bot's conversation or a private directory. Creating Skills must be a default capability of every supported Bot, across Agent backends, not an optional Pi-only feature that first requires the user to discover and install a creator.

Native Agents do not share one universal configuration format or discovery policy. Pi supports native Skills but needs an MCP extension. Codex and Claude Code have different native MCP formats and different Skill discovery and precedence rules. Configuration portability also does not imply shared OAuth credentials or immediate runtime reload. The product must make these differences work predictably without silently replacing user configuration, dropping unsupported fields, or claiming compatibility that has not been exercised.

## Solution

Retain three user-facing plugin categories with clear ownership:

- **Service** contains provider-official integrations curated by Omarchy Bot. A Service includes its official MCP connection or connections, any provider-published companion Skills, and account authorization. Its components are managed as one unit.
- **MCP** contains custom connections added by the user or a Bot. The same connection can be represented in the native project configuration formats of the supported clients.
- **Skill** contains independently installed, externally discovered, or locally created Skills. The default discovery catalog is skills.sh, but a catalog listing is not required for installation or use.

Let the user and Bots operate the same plugin management capabilities. Bots may autonomously search, inspect, add, update, enable, disable, and remove plugins without a second Omarchy Bot approval policy. Native Agent approvals, provider consent, and account login still apply. The panel reflects changes whether they originate in the Client, a Bot management Tool Call, a native command, or direct edits to workspace configuration and Skill files.

Use the Shared Workspace's native discovery locations. Preserve each Agent's default treatment of user-level resources and same-name conflicts. Synchronize shared custom MCP entries across project configuration formats while retaining client-specific settings and reporting conflicts or unrepresentable fields. Reuse the existing Pi MCP extension ecosystem rather than maintaining a parallel custom MCP implementation for Pi.

Provision an official Skill Creator and its required companion resources as a default part of the Bot environment. A new Bot can immediately create a local Skill through its existing file and execution capabilities. The completed directory is discovered and shown as a shared Skill; it can be used by another Bot and by a compatible native Agent in the Shared Workspace. There is no remote publication, separate registration action, draft/publish workflow, or new Skill-creation service.

Automatically update remotely installed content where its source and version mechanism support it. Preserve local modifications and report updates that require attention rather than overwriting user or Bot work. Distinguish configuration changes from effective runtime state, and use each Agent or extension's actual reload behavior.

## User Stories

### Plugin organization and official integrations

1. As an Omarchy user, I want Service, MCP, and Skill to remain separate categories, so that I can distinguish provider integrations from my custom connections and independent Skills.
2. As an Omarchy user, I want a Service to contain its official tools, companion Skills, and authorization, so that adding one integration does not require coordinating three unrelated panels.
3. As an Omarchy user, I want the Service catalog to use provider-published capabilities, so that a first-party integration is not silently replaced by third-party or locally invented behavior.
4. As an Omarchy user, I want an official MCP used when it is applicable to the service and my account, so that the product reuses the provider's maintained Agent interface.
5. As an Omarchy user, I want existing official companion Skills installed with their Service, so that Bots receive the provider's workflow guidance as well as its tools.
6. As an Omarchy user, I want a Service without an official companion Skill to say so honestly, so that a locally written substitute is not presented as provider-authored.
7. As an Omarchy user, I want unavailable account types, provider policies, permissions, and functionality explained, so that I do not mistake a visible card for a usable integration.
8. As an Omarchy user, I want a Service without an applicable official MCP to be unavailable rather than silently fall back to a custom REST implementation, so that its provenance remains trustworthy.
9. As an Omarchy user, I want a Service's components visible in its details but not duplicated as independent custom installations, so that the plugin panel does not imply multiple unrelated installations.
10. As an Omarchy user, I want Service enable, disable, and remove operations to cover its dedicated MCP connections and companion Skills together, so that the integration has one understandable lifecycle.
11. As an Omarchy user, I want removing one Service to preserve independently installed Skills and other Services using the same provider account, so that unrelated capabilities are not removed accidentally.
12. As an Omarchy user, I want provider accounts and enabled Service components distinguished, so that disabling a capability does not misleadingly claim that the provider account was revoked.
13. As an Omarchy user, I want multiple connected accounts retained and identifiable, so that a Bot can use the account intended for my task rather than assume a default.
14. As an Omarchy user, I want to add a third-party alternative under custom MCP or Skill when an official Service is unsuitable, so that the official catalog does not limit my own integrations.

### Bot management capabilities

15. As an Omarchy user, I want a Bot to inspect the same plugin inventory shown in the Client, so that its decisions reflect what is actually installed and usable.
16. As an Omarchy user, I want a Bot to add and manage Services, so that setup can start from a conversation rather than requiring manual panel navigation.
17. As an Omarchy user, I want a Bot to initiate a required authorization flow and return the user-facing action, so that it can help with setup without pretending to log in or grant consent for me.
18. As an Omarchy user, I want a Bot to add and modify custom MCP connections, so that I can supply an endpoint or command in a conversation.
19. As an Omarchy user, I want a Bot to check an MCP connection and report its observed condition, so that a saved configuration is not confused with successful tool access.
20. As an Omarchy user, I want a Bot to search skills.sh and inspect a candidate's source and contents, so that it can choose a Skill appropriate to the task.
21. As an Omarchy user, I want a Bot to install a Skill from a catalog entry or specified source, so that installation is not limited to manual UI actions.
22. As an Omarchy user, I want a Bot to enable, disable, remove, and update plugins, so that it can maintain the shared environment rather than only add to it.
23. As an Omarchy user, I want Bots to manage plugins autonomously without a new product-level approval prompt, so that the product preserves the Agent's native working model.
24. As an Omarchy user, I want native Agent approvals and provider consent to remain effective, so that plugin-management autonomy is not treated as permission to bypass them.
25. As an Omarchy user, I want Bot management results to distinguish completed, pending authorization, pending reload, and failed work, so that a Bot does not report a capability ready when it is not.
26. As an Omarchy user, I want plugin management to appear through ordinary Tool Call and error behavior, so that it fits the existing Thread experience rather than introducing another conversation system.
27. As an Omarchy user, I want one Bot's plugin changes to be shared with other Bots, so that the creating Bot does not become the owner of a private installation.

### Independent Skill installation and default creation

28. As an Omarchy user, I want skills.sh to remain the default search and browsing source, so that the existing discovery experience remains useful.
29. As an Omarchy user, I want to install a Skill from an explicitly selected repository, Skill URL, or local directory, so that a remote catalog listing is not a prerequisite.
30. As an Omarchy user, I want installation to retain the complete Skill and its companion resources, so that scripts, references, and assets referenced by the instructions are available.
31. As an Omarchy user, I want the exact selected Skill and source installed, so that an ambiguous name or stale catalog entry does not result in a guessed replacement.
32. As an Omarchy user, I want every new supported Bot to be able to create a Skill without asking me to install a creator first, so that creation is a default product capability.
33. As an Omarchy user, I want Skill creation to work across supported Agent backends, so that the feature is not coupled to Pi-specific tool names or conversation events.
34. As an Omarchy user, I want an official Skill Creator and its complete required resources supplied by default, so that default creation is real functionality rather than a documentation link.
35. As an Omarchy user, I want a Bot to use its native file and execution tools when creating a Skill, so that the product does not add a separate authoring service or runtime.
36. As an Omarchy user, I want a created Skill stored as ordinary local Skill files in the shared discovery area, so that I can inspect and edit it with my normal tools.
37. As an Omarchy user, I want a newly created Skill to appear in the plugin panel without a separate registration action, so that file creation and product discovery remain consistent.
38. As an Omarchy user, I want another Bot to discover and use a created Skill, so that useful workflows are shared rather than trapped in the original Thread.
39. As an Omarchy user, I want a compatible native Agent started in the Shared Workspace to discover and use that same Skill, so that creation produces a portable resource rather than a product-private object.
40. As an Omarchy user, I want locally created Skills to require no remote upload or publication, so that private workflows remain local.
41. As an Omarchy user, I want a created Skill's real dependencies and compatibility requirements reported, so that a portable file format is not mistaken for universally available external tools.
42. As an Omarchy user, I want invalid or incomplete Skill files reported without being presented as working capabilities, so that a generated template is not counted as a finished Skill.
43. As an Omarchy user, I want removal of a Bot to preserve its created Skills and the shared plugin environment, so that shared work survives its original creator.

### Native discovery, editing, and cross-Agent configuration

44. As an Omarchy user, I want the Shared Workspace used for project-level plugin discovery rather than the daemon's launch or installation directory, so that behavior is stable across development and installed execution.
45. As an Omarchy user, I want a supported native Agent started directly in the Shared Workspace to find the expected Skills and MCP configuration, so that using the product is not the only way to access my setup.
46. As an Omarchy user, I want Pi's existing MCP extension installed and configured for the workspace, so that direct Pi use does not depend on a nonexistent built-in MCP loader.
47. As an Omarchy user, I want custom MCP entries represented in each supported client's own configuration format, so that protocol compatibility is not confused with file-format compatibility.
48. As an Omarchy user, I want shared MCP changes synchronized across compatible project formats, so that editing one shared entry does not leave other clients using stale settings.
49. As an Omarchy user, I want Agent-specific settings and unrelated entries preserved during synchronization, so that common plugin management does not flatten richer native configuration.
50. As an Omarchy user, I want unsupported fields and conflicting edits reported without data loss, so that synchronization does not quietly change the meaning of a connection.
51. As an Omarchy user, I want native command installations and direct file edits recognized by the panel, so that the panel represents my actual environment rather than only its own database writes.
52. As an Omarchy user, I want deletion of a native workspace entry reflected in the panel and shared configuration, so that removed resources do not reappear from stale managed state.
53. As an Omarchy user, I want panel edits reflected in the corresponding workspace files, so that native clients and the Client are not competing configuration owners.
54. As an Omarchy user, I want each Agent's user-level directories and precedence rules respected, so that the product does not invent a new global conflict policy.
55. As an Omarchy user, I want the source and effective applicability of discovered resources visible, so that a same-name native resource can be understood without silently overriding it.
56. As an Omarchy user, I want invalid configuration edits to produce an actionable error without rewriting my file, so that I can repair the source of the problem.
57. As an Omarchy user, I want discovery and synchronization to converge after restart, so that a missed live filesystem event does not permanently desynchronize the panel.
58. As an Omarchy user, I want an explicit Thread working directory preserved, so that shared default configuration does not remove the Agent's ability to work elsewhere.

### Authorization, runtime state, and updates

59. As an Omarchy user, I want account credentials kept out of model-visible management results and shared workspace files, so that configuration portability does not expose my tokens.
60. As an Omarchy user, I want external native clients allowed to authenticate separately, so that the product does not promise unsupported cross-client OAuth reuse.
61. As an Omarchy user, I want configuration presence, enablement, connection, authorization needs, and loaded runtime state distinguished, so that the panel does not label every saved entry connected.
62. As an Omarchy user, I want changes applied using the Agent or extension's real reload mechanism, so that the product does not pretend arbitrary edits hot-reload an active tool set.
63. As an Omarchy user, I want a configuration reload or plugin update not to terminate an unrelated Active Turn, so that shared management does not silently interrupt other Bots.
64. As an Omarchy user, I want obsolete runtime connections and tools released at their safe lifecycle boundary, so that disabling or removing a plugin does not leave duplicate or stale capabilities indefinitely.
65. As an Omarchy user, I want remotely installed Skills and other version-manageable plugin content updated automatically, so that maintained integrations do not require repetitive manual updates.
66. As an Omarchy user, I want a failed update to leave the prior usable installation available, so that network or packaging failures do not destroy a working capability.
67. As an Omarchy user, I want local modifications detected and preserved before automatic replacement, so that my work or a Bot's improvements are not discarded.
68. As an Omarchy user, I want locally modified items shown as requiring update attention, so that a user or Bot can decide what to keep without an automatic merge system.
69. As an Omarchy user, I want locally created Skills without an upstream source excluded from remote updates, so that the updater does not invent an origin or overwrite them.
70. As an Omarchy user, I want new authorization requirements surfaced after an upstream update, so that an updater does not attempt to grant permissions on my behalf.
71. As an Omarchy user, I want remote MCP server upgrades distinguished from locally controlled package versions, so that the product makes no false rollback or pinning promise for a hosted endpoint.

### Continuity, presentation, and migration

72. As an Omarchy user, I want the plugin panel to update while open without losing my current Thread or Composer draft, so that background Bot management does not interrupt conversation work.
73. As an Omarchy user, I want plugin management usable in the existing desktop dialog and narrow-screen presentation, so that these capabilities remain accessible on all supported Client layouts.
74. As an Omarchy user, I want source, version, local modification, conflict, and applicability details available without exposing credentials, so that I can understand the shared environment safely.
75. As an Omarchy user, I want existing custom MCP connections, installed Skill contents, account identities, and enablement choices migrated conservatively, so that the cutover does not discard my setup.
76. As an Omarchy user, I want existing service cards that no longer meet the official-only contract to explain their unavailability, so that removed REST implementations are not disguised as working official MCP integrations.
77. As an Omarchy user, I want only one effective runtime route for a given MCP connection, so that the cutover does not invoke the same capability through both the old daemon path and the Pi extension.
78. As an Omarchy user, I want source-only or fixture-backed compatibility claims distinguished from real native execution, so that I know what actually works with my installed Agents and accounts.
79. As an Omarchy user, I want the feature to preserve the Host Session and shared work, so that plugin setup or validation does not modify or restart my desktop environment.
80. As a maintainer, I want the feature built on existing plugin management and Agent seams, so that the Client, Bot tools, and native files do not acquire three separate implementations of the same behavior.

## Implementation Decisions

### Domain and ownership

- Use the existing Workspace and Agent Integration domain vocabulary. A Bot is a persistent teammate backed by an Agent; sharing plugins does not merge Bot identity, Threads, or Native Sessions. Service in this specification is a plugin-panel category, not a replacement name for an Agent or a backend implementation module.
- Treat plugin configuration and locally created Skills as shared resources, not per-Bot or per-Thread resources. Preserve the Shared Workspace default and explicit Thread working-directory behavior. Do not fall back to product source, installation, or daemon launch locations.
- Preserve native Agent capabilities and approval behavior. Bot plugin-management autonomy adds no product approval gate and does not remove native approvals or provider authorization. Do not add a permission manifest, general sandbox, or file-locking policy to Shared Workspace work.
- Bot deletion does not remove shared plugin files, locally created Skills, user-level Agent resources, or Agent-owned Native Sessions. Explicit plugin removal remains a separate management action.

### Shared management interface

- Extend the existing plugin management module and public protocol rather than creating separate Client-only and Bot-only management systems. The Bot Client and Agent-exposed management tools consume the same operations and observable state.
- Expose capabilities to list and inspect the plugin inventory; manage Service membership and enablement; initiate required authorization; add, edit, inspect, check, enable, disable, and remove custom MCP connections; search and inspect catalog Skills; install from supported explicit sources; enable, disable, remove, inspect, and update Skills; and inspect update or synchronization problems.
- Specify those capabilities as a coherent interface, not a mandated count of one tool per verb. Management tools are distinct from the MCP business tools that read mail, search documents, or act on a provider's data.
- Route management through existing Tool Call, Turn cancellation, and error conventions. A failed or incomplete action must return its observed state rather than a generic success acknowledgment. A saved connection is not automatically connected; initiating OAuth is not completing OAuth.
- Extend existing public state with the minimum information needed to distinguish category, stable resource identity, provenance, Service membership, source location, management scope, requested enablement, runtime applicability, observed connection or authorization condition, installed and available revision, local modifications, and synchronization or update errors. The exact schema is implementation work; do not duplicate secrets in DTOs or model-visible tool results.
- Keep the Client informed of management and externally discovered changes using the existing application refresh/event conventions. Filesystem discovery and automatic synchronization are system behavior, not manual tools that a Bot must remember to invoke after every edit.

### Service composition and official-only behavior

- A Service coordinates its provider-official MCP definitions, any provider-official companion Skill resources, and account authorization. Do not synthesize locally maintained REST business tools as an invisible replacement for missing official MCP functionality.
- Use verified provider sources and complete published resources. Catalog names, third-party descriptions, or a first-party-looking URL are not sufficient provenance. Retain source and revision information so updates can be attributed.
- Use the provider's existing package structure where applicable rather than reconstructing its business instructions. Absence of an official companion Skill is acceptable; absence of an applicable official MCP makes the Service unavailable under this contract.
- Service enablement, disablement, and removal operate over its dedicated components as a unit. Details may show components and individual failure conditions, but the custom MCP and independent Skill lists must not duplicate those owned components as separate user-managed installations.
- Preserve independently installed resources and account grants still used by other Services. Keep shared provider account pools and multiple-account identity explicit. Service removal, local account disconnection, and remote provider revocation are not interchangeable actions.
- Provider-specific tenant, account-type, license, authorization, region, and tool-coverage requirements must be discovered and shown honestly. A visible Service card, successful configuration parse, or OAuth fixture is not evidence of working provider access.

### Pi MCP runtime and native clients

- Use an existing Pi MCP extension rather than building a second MCP implementation. The researched integration candidate is pi-mcp-adapter; its documented project discovery, programmatic integration, official-bundle loading support, OAuth facilities, and runtime status interface provide the intended reusable seam. Select and exercise a compatible version before claiming runtime support.
- Provision the extension as a project/product dependency so direct Pi startup in the Shared Workspace can load it. Do not require a host-global installation or import unrelated host configurations as a side effect.
- Move Pi's custom MCP execution to the selected extension and remove the obsolete duplicate connection/tool route after migration. A configured MCP must not be connected or registered once through the old managed tool injection path and again through the extension. Reuse extension lifecycle and status interfaces instead of parsing its terminal UI or reimplementing transports.
- Integrate official Service components with the chosen runtime without requiring users to install their constituent MCPs independently. Preserve real provider authentication requirements rather than assuming a generic MCP login fits every provider.
- Support native project discovery and configuration compatibility for Pi with its extension, Codex, and Claude Code. Do not introduce Codex or Claude Bot workers, Agent registry readiness claims, or full Native Session adapters as part of this feature.
- A versioned extension dependency and its actual runtime behavior, not an online README alone, define the exercised Pi compatibility claim. An unavailable prerequisite must produce an honest setup/compatibility condition.

### Native file discovery and synchronization

- Store or expose independent Skills in the Shared Workspace's native discovery locations. Share the same Skill content across supported clients through their native mechanisms rather than maintaining divergent per-Bot copies. Follow actual loader support for shared directories and links.
- Expose custom MCP definitions in each supported client's native project format. There is no universal native MCP configuration file across all clients. Share meaning and resource identity, not an assumption that all clients parse identical bytes.
- Make panel operations, Bot management tools, native commands, and direct workspace-file edits converge on the same discoverable state. Configuration storage must not be an independent authoritative database that silently restores deleted native entries or overwrites external edits.
- Synchronize shared MCP additions, edits, removals, and representable enablement across compatible project formats. Preserve unrelated entries, client-specific options, and configuration content that does not belong to the shared entry. Do not flatten client-specific behavior into a lossy common subset.
- Represent an incompatible field or contradictory native edit as a conflict or unsupported projection, preserve the affected files, and explain the unresolved difference. Do not declare successful synchronization after dropping values. A nonconflicting later edit must be able to reconcile without recreating duplicate entries.
- Use native source identity and explicit Service ownership to avoid confusing a Service-owned component with a separately installed custom resource of a similar name.
- Preserve each Agent's normal user-level discovery, trust, and precedence behavior. Do not write user-level configuration as part of project synchronization, force one cross-Agent same-name rule, or migrate all discovered user resources into workspace ownership. Inherited user resources can be shown with source and effective applicability; inherited configuration is not permission to edit their source files.
- Detect changes while the product is running and reconcile again at startup. Atomic-save patterns, removal, invalid intermediate edits, and restarts must not leave permanent stale inventory or destructive rewrite loops. Parse failures are visible; do not repair them by silently replacing the user's file with cached content.

### Default creation across Agents

- Make creating a Skill a default capability for every Bot backed by a supported Agent. A fresh Bot must not require the user to browse the catalog, install a creator, configure a creation endpoint, or invoke a publication action before creation is possible.
- Omarchy Bot must locally provision a first-party published Skill Creator, including the companion scripts and references required for the supported creation path, as part of the default Bot environment. Reuse the official creator rather than authoring a replacement; "do not build our own creator" does not mean "do not provide a creator locally." Do not rely on the selected Agent happening to ship a creator already, or on the model remembering how to write Skills without the promised default resource.
- The exact compatible upstream creator and revision are implementation selections, not an already confirmed vendor choice. OpenAI and Anthropic official creator sources were researched. A similarly named third-party catalog entry is not equivalent. Select the source on verified compatibility, disclose its provenance, and avoid importing host-specific evaluation requirements into unrelated Agents.
- A Pi-only installation must support the complete default creation workflow without Codex or Claude installed, configured, authenticated, or invoked. A Skill's publisher does not determine its executing Agent. Select an official creator whose required workflow runs through Pi's existing capabilities; a version that requires another Agent CLI for a necessary creation step is not an acceptable Pi default. Ordinary script-runtime dependencies must be supplied or checked through the existing host-safe dependency mechanisms, not confused with a requirement to install another Agent.
- Keep the default creation entry available across supported Agents through native Skill provisioning and existing Agent file/execution tools. Do not implement a Pi-only creation tool, a separate creation service, a private Skill format, or a parallel model runtime.
- Creator instructions guide intent capture, trigger description, complete content, supporting resources, and appropriate validation. Initialization that only produces placeholders is not completion. Metadata checks do not prove task quality, executable safety, or cross-Agent compatibility.
- Completed Skills live in shared native discovery locations and enter the ordinary Skill inventory through file discovery. Locally created Skills have local provenance and no invented upstream source. No user-facing draft/published state machine, registration database, remote upload, or separate publish button is required.
- The cross-Agent guarantee covers the common creation workflow and native discovery/use of portable Skills. A Skill may truthfully declare specific tool or runtime dependencies; standard file syntax must not be marketed as a guarantee that every specialized Skill works with every Agent. Default creation itself must not depend on an optional Claude-only evaluation pipeline when used by Pi or another Agent.
- New supported Agent backends must satisfy default creation and shared discovery when integrated later. This compatibility obligation does not authorize adding those Bot workers in the present feature.

### Authorization and lifecycle

- Keep account secrets outside shared work files, public plugin state, model-visible management results, and logs. Store authentication using the selected provider/runtime's appropriate local credential mechanism. Do not copy OAuth tokens between clients simply because an endpoint is synchronized.
- External native clients may authenticate separately. Do not promise that a Bot Client authorization automatically signs in another Agent, or that clients share refresh-token and client-registration formats.
- Preserve the native authorization and reload requirements of the selected extension and Agent. Model installed/configured, requested enablement, authentication needs, connection state, and effective runtime loading separately where the difference is observable.
- Product-initiated changes should be reconciled at the next safe Turn/session reload boundary without terminating unrelated work. Do not replace active tool registries or release in-use resources merely to make the panel look current. Explicit provider-side revocation can still interrupt a call and must be reported as such.
- Direct native edits follow actual loader semantics. Do not retain the old blanket claim that every native file revision is frozen for an entire Turn unless that property is genuinely enforced and exercised. Reflect pending reload instead of claiming instant activation.
- Ensure removed or disabled MCPs cease to be offered after the applicable reload and their obsolete connections are released. Do not retain duplicate old/new MCP execution systems as a compatibility shim.

### Installation and updates

- Retain skills.sh search and browsing, including the existing separation between discovery results and installed state. Add installation from explicit supported repositories, Skill URLs, and local directories through the same management interface.
- Install complete self-contained resources from an exact identified source. Preserve existing protection against ambiguous identity, missing companion files, unsafe archive contents, and source substitution. An invalid installation must not poison later valid installations.
- Continue automatic updating for enabled remotely installed Skills and extend automatic updating to other supported version-manageable Service content and local MCP packages. Use source-supported version mechanisms; do not interpret this as authority to run host-global update commands.
- Record sufficient source, installed revision, and local-content baseline information to distinguish clean upstream content from local modifications. Before replacing content, recheck the actual local state so a Bot edit made during download is not overwritten.
- A clean supported installation can update automatically. A locally modified one must remain intact and show update attention. Do not automatically discard changes or build an automatic merge/conflict-resolution engine. A user or Bot may explicitly decide how to proceed using the management and native file tools.
- A locally created Skill without an upstream origin is not subject to remote replacement. An explicitly linked live local source must not be treated as a disposable remote cache.
- Failed installation or update must not present an incomplete bundle as fully ready or destroy the previous working content. Newly required permissions are pending user authorization, not automatically granted.
- A hosted MCP server controls its own deployment. Display that distinction and do not imply that a local revision can freeze or roll back remote server behavior.

### Migration, presentation, and documentation cutover

- Evolve the existing plugin panel and public plugin operations rather than adding a second store or management application. Preserve the desktop/narrow-layout behavior, ongoing Thread selection, and Composer drafts while inventory changes.
- Migrate existing managed Skills, custom MCP definitions, relevant enablement choices, account identities, and source metadata conservatively into the native-discovery model. Preserve local contents and identify conflicts instead of overwriting a same-name native installation.
- Remove duplicate managed Skill injection once native loading is authoritative for that resource; preserve native naming and conflict behavior rather than registering the same Skill twice with synthetic aliases.
- Retire locally maintained REST business-tool paths that violate the Service official-only contract. Preserve relevant user account data and report any now-unavailable integration; do not silently relabel an old REST route as official MCP or erase unrelated grants.
- Update the existing domain integration documentation and public support claims during implementation. Explicitly replace the older no-native-configuration-write rule for workspace-scoped shared entries, the daemon-only MCP execution description, and any unconditional per-Turn Skill-revision guarantee that no longer holds. Preserve credential confidentiality, native approvals, explicit working directories, local-only Bot deletion, and shared work-file ownership.
- Keep execution on the Omarchy side and reuse the existing Web Bot Client. No Tauri shell, alternate frontend, new desktop session, or Host Session modification is part of this work.

## Testing Decisions

### Primary seam

- Use the existing real-daemon integration harness as the primary behavioral seam. Drive public plugin management operations, the existing Bot/Turn Tool Call protocol, and external edits to temporary native resource files. Observe public inventory, preserved file content, applicable native configuration, actual downstream capability use, errors, and restart behavior.
- Treat Client and Bot management as callers of the same interface, not separate test targets with duplicated business assertions. Use scripted workers for deterministic request, cancellation, and error scenarios, but do not use their acknowledgments as proof that an upstream Agent discovered or executed a Skill or MCP tool.
- Prefer this high seam to unit tests of parsers, watcher callbacks, private maps, registration helpers, or implementation-specific state fields. Add a lower-seam test only when it defends a distinct externally meaningful boundary that cannot be exercised reliably at the main seam.
- The user clarified that default, cross-Agent Skill creation is a required acceptance outcome while the proposed test seam was being checked. The specification therefore requires fresh-Bot creation and cross-Bot/cross-Agent consumption, not merely creator installation or a successful directory scan.

### Behavioral acceptance scenarios

1. Add an official Service with a controlled provider fixture containing MCP and companion Skills. Verify it appears as one Service, its component provenance is available in details, and its owned components do not duplicate custom entries. Disable and remove it, then verify it is no longer offered after the real reload boundary while an independent Skill and another Service using the account survive.
2. Exercise a representative real provider authorization and official MCP call separately from the fixture scenario. Show account/tenant prerequisites and actual results. Missing production registration, consent, or credentials is an explicit unmet live-verification prerequisite, not a passing integration.
3. Add and change a custom MCP through a Bot management Tool Call. Observe the panel-facing inventory and use a real local MCP server through Pi's selected extension to perform a bounded task with a verifiable result. Verify there is no second old-runtime invocation.
4. Exercise the same management capability through the public Client interface and verify it changes the same native state. Do not assert only that one helper forwarded another helper's parameters.
5. Add, edit, disable, and remove a shared MCP through a native configuration file. Verify compatible project representations converge, other clients can consume the effective shared configuration, and unrelated/client-specific settings remain intact.
6. Introduce contradictory edits and an unrepresentable client-specific option. Verify original file data is preserved, synchronization does not silently declare success, and the problem remains visible and recoverable without resetting the environment.
7. Save malformed configuration, perform an atomic replacement, remove an entry, and restart the daemon. Verify invalid states are visible, removed entries do not resurrect, and corrected state is rediscovered without a manual database repair.
8. Install a Skill through skills.sh and through representative explicit repository, URL, and local sources. Verify the exact selected Skill and required companion resource work, not merely that a file or list item exists. Retain deterministic identity and unsafe-archive regressions.
9. Start with a fresh isolated Pi-only product environment, no preinstalled creator, and no available Codex or Claude executable, configuration, or credentials. Create a new Pi Bot and, without a manual creator installation, ask it to create a bounded useful Skill with complete instructions and any required resources. Verify Omarchy Bot supplied the official creator locally, the task completed through Pi and ordinary supported script runtimes without invoking another Agent, and the result contains no placeholders or remote publication requirement.
10. Have a different Pi Bot in that same Pi-only environment use the created Skill to complete a concrete task with checkable output. Delete the creating Bot and confirm the Skill and its usable content remain shared. This is the core default-creation acceptance scenario for the currently implemented Agent backend.
11. Separately start the supported native clients in an isolated Shared Workspace with the necessary client prerequisites. Verify discovery and meaningful use of the same portable created Skill across Pi and the target non-Pi clients. Separately verify default creator discovery and an actual creation task under the target native clients; file visibility alone is not proof of portable authoring. These compatibility checks remain required for cross-Agent support claims, but installing or authenticating Codex or Claude must never be a prerequisite for a user to create Skills with Pi. Report unavailable client prerequisites without presenting the cross-Agent scenario as passed.
12. Exercise native user/project same-name cases under each client's actual loader behavior. Verify the product reports effective applicability without imposing one invented precedence rule or writing user-level configuration.
13. Update clean remote content and verify the new behavior is available after the applicable reload. Modify content locally before and during an update attempt; verify those modifications survive and update attention is shown. Verify locally created content is not remotely updated.
14. Fail a source download or bundle update after work has started. Verify the prior usable installation survives and incomplete content is not presented as a ready capability. Require neither a new user-facing publication state machine nor a mock success fallback.
15. Keep one Bot in an Active Turn while another modifies plugins. Verify unrelated work is not forcibly stopped, effective/pending state is truthful, and later work uses the updated capability after the supported lifecycle transition.
16. Exercise authorization-needed, denied/revoked access, connection failure, and cancellation. Verify errors propagate through normal Tool Call/Turn behavior and that no credentials enter public state, model-visible management output, shared config content, or captured diagnostic logs.
17. Migrate an existing installation with managed Skills, custom MCPs, accounts, disabled choices, and a conflicting native resource. Verify preserved content and account identity, explicit conflicts/unavailable Services, no duplicate registrations, and restart convergence. Do not test migration solely by inspecting internal database rows.

### Existing prior art and necessary real surfaces

- The existing daemon harness already isolates application data and starts the real daemon with controllable workers. Shared Workspace integration scenarios provide prior art for shared files, explicit working directories, restart, and deletion preservation.
- Bot mailbox integration and browser scenarios provide prior art for initiating a capability through a Bot Tool Call and observing another Bot's behavior. Reuse their public-flow pattern, not incidental internal-row or forwarding assertions.
- Existing plugin Skill regressions cover canonical source identity and archive failure that must not leave a poisoned installation. Preserve those observable guarantees while moving broader coverage to the higher seam.
- Existing Pi conformance tests provide a real-worker and Native Session entry point. Extend or supplement only the relevant plugin/Skill scenarios; do not require unrelated computer-control scenarios to prove a plugin change.
- Use the real Pi extension and actual native client loaders for native-discovery and MCP claims. Local MCP servers and isolated source fixtures provide deterministic business effects without third-party account dependence. Live provider checks remain separately identified.
- Verify the actual Bot Client with browser interaction on desktop and narrow layouts: three categories, grouped Service details, Bot-created and externally edited content appearing without navigation loss, update/conflict conditions, accessible actions, and no credential exposure. Prefer accessible roles and visible outcomes over CSS structure or exact wording snapshots.
- Native CLI verification is not a new Bot worker implementation. Use temporary homes, configuration roots, workspaces, and project-managed dependencies. Do not change real user Agent config, host packages, compositor state, or graphical-session services to make a scenario pass.
- Record actual client and extension versions, source revisions, exercised scenarios, and missing prerequisites. A config parse or generated file is not native runtime proof; a fixture is not live OAuth proof; Chromium is not Tauri/WebView proof.
- Retain permanent tests only where plausible regressions would break observable behavior. Use focused smoke runs for straightforward new paths; do not add tests that pin source text, helper wiring, field copies, incidental defaults, or cosmetic wording. Specification publication itself does not claim these implementation scenarios have been executed.

## Out of Scope

- Implementing Codex or Claude Bot workers, their full Native Session lifecycle, or new Agent Readiness claims.
- A new MCP protocol stack, a second Pi MCP implementation, or a permanent old/new dual runtime for the same connection.
- Third-party or self-maintained REST business tools presented as provider-official Services; automatic fallback that hides missing official functionality.
- A new Skill-creation service, private Skill format, dedicated authoring model backend, registration service, or mandatory create-skill API.
- A remote Skill marketplace, automatic upload to skills.sh, publication to upstream repositories, or a local draft/review/publish product workflow.
- A product-owned continuous learning system that automatically distills every conversation into Skills. Bots may use their native reasoning and authorized tools; this feature does not introduce an autonomous background training or evaluation subsystem.
- Mandatory Anthropic-specific benchmark, human review, or trigger-optimization infrastructure for every created Skill. Appropriate task verification is still required; format validation alone is not a quality claim.
- Automatic merging or discarding of locally modified Skills during upstream updates.
- Rewriting user-level Agent configuration, forcing one cross-Agent precedence policy, or automatically granting trust to arbitrary external projects.
- Cross-client OAuth token replication, transparent single sign-on across native clients, or copying secrets into shared workspace configuration.
- Universal immediate hot reload, unconditional immutable native file snapshots during every Active Turn, or pinning the behavior of remote MCP deployments.
- Unrestricted capability promises for arbitrary Agent versions, arbitrary third-party MCPs, or Skills with unavailable host-specific dependencies.
- New memory behavior, work-file locking, per-Bot workspaces, conversation migration beyond what plugin cutover requires, or changes to Bot identity/deletion semantics.
- Tauri implementation, new Bot Screen infrastructure, desktop/session changes, host package installation, host-global updates, or restarting Host Session services.

## Further Notes

### Authority and confirmed product decisions

This specification records the completed design discussion plus the later clarification that Skill creation must be a default capability of all supported Bots across Agents. The user authorized specification publication, not feature implementation. The local issue tracker uses the canonical `Status: ready-for-agent` line; this file is the published feature specification, not a claim that the feature is implemented.

The main confirmed decisions are: retain Service/MCP/Skill categories; accept only provider-official Service components; allow autonomous Bot management; support native workspace discovery and bidirectional file/panel changes; synchronize shared MCP entries across client formats; preserve native user-level loading policies; use an existing Pi MCP extension; allow separate external-client login; update supported content automatically without overwriting local changes; and do not add Codex/Claude Bot workers.

The default creation clarification is normative: a creator that is merely searchable or optionally installable does not meet this specification. A completed local Skill must be usable beyond its creating Bot and creating Agent. No remote publication is required. The exact upstream creator was not selected by the user; choosing and validating a compatible official source is implementation work, not a reason to reduce creation to optional installation.

Local provision and upstream authorship are separate responsibilities: Omarchy Bot supplies the official creator by default, but does not develop a replacement creator. The current Pi-only environment must work independently of Codex and Claude. Cross-Agent portability remains a separate compatibility obligation, not a requirement that the user install several Agents to use one Bot.

### Repository baseline and documentation relationships

- [Context routing](../../CONTEXT-MAP.md), [Workspace glossary](../../docs/contexts/workspace/CONTEXT.md), and [Agent Integration glossary](../../docs/contexts/agent-integration/CONTEXT.md) define the domain terms used here.
- [Native capability preservation](../../docs/contexts/agent-integration/adr/0003-preserve-native-agent-capabilities.md), [local-only Bot deletion](../../docs/adr/0006-bot-deletion-is-local-only.md), [Shared Workspace ownership](../../docs/adr/0009-share-work-files-isolate-bot-screens.md), and [Web Client reuse](../../docs/adr/0010-reuse-web-client-in-tauri.md) remain in force.
- [The product boundary](../../docs/workspace-redesign.md#shared-workspace-and-plugin-boundary) still separates shared work from source, installation, conversation data, and the Host Session. Shared project plugin configuration does not turn the workspace into a sandbox or move secrets and conversation databases into it.
- [Current Agent integration documentation](../../docs/agents-integration.md#managed-plugin-snapshots) describes the existing daemon-owned MCP/Skill snapshot model. This specification intentionally changes workspace-native configuration ownership and Pi MCP execution. Implementation must reconcile those documented contracts explicitly rather than leave contradictory guarantees in place.
- Current relevant implementation includes the plugin panel, daemon plugin management and provider registry, Skill materializer, shared workspace resolver, Pi resource loader, and worker protocol. The existing real-daemon harness, plugin Skill regressions, Shared Workspace integration, Bot mailbox flows, and Pi conformance are the testing prior art named above; the specification does not freeze their current file organization.

### Concrete native locations observed during research

These are compatibility evidence and starting points, not a promise that every future client version has identical loading behavior:

- Shared Workspace default: `~/.omarchy-bot/workspace/`.
- Pi and Codex can discover project Skills in `.agents/skills/`; Pi also has `.pi/skills/`. Claude Code documents `.claude/skills/`. Use actual supported linking/discovery behavior to share content.
- The researched Pi MCP adapter reads project `.mcp.json` and Pi-specific `.pi/mcp.json` overrides. Claude Code also uses project `.mcp.json`. Codex uses `.codex/config.toml` with its own schema.
- User-level locations and precedence are client-specific, including `~/.agents/skills/`, Pi's user resources, and Claude's user resources. They are not one universal directory with one universal override policy.
- Existing managed Skill storage is under the daemon plugin data directory rather than native workspace discovery. Migration must preserve these contents and installed-source identity while removing duplicate loading paths.

### Primary-source research

- [Agent Skills format](https://agentskills.io/specification) and [client integration guidance](https://agentskills.io/client-implementation/adding-skills-support): standard local files, progressive disclosure, native discovery responsibilities, and the cross-client directory convention.
- [OpenAI official Skill Creator](https://github.com/openai/skills/tree/main/skills/.system/skill-creator): local initialization, authoring resources, basic validation, and iteration.
- [Anthropic official Skill Creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator): authoring and optional evaluation workflows, some tied to Claude tooling.
- [Pi 0.84.4 source used by the repository](https://github.com/earendil-works/pi/tree/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent): native Skills, extensions, package loading, and no built-in MCP implementation.
- [Pi MCP Adapter](https://github.com/nicobailon/pi-mcp-adapter): project/shared configuration discovery, local plugin bundles, SDK integration, OAuth, and runtime status. Research observed main-branch package metadata identifying version 2.33.0; this is not yet a repository-installed or runtime-verified dependency.
- [Codex Skills](https://developers.openai.com/codex/skills/) and [Codex MCP](https://developers.openai.com/codex/mcp/); [Claude Code Skills](https://code.claude.com/docs/en/skills) and [Claude Code MCP](https://code.claude.com/docs/en/mcp): actual client-specific discovery, configuration, trust, and authentication behavior.
- [Microsoft Work IQ official plugins](https://github.com/microsoft/work-iq) and [official Work IQ usage Skill](https://github.com/microsoft/work-iq/blob/main/plugins/workiq-preview/skills/workiq-preview/SKILL.md): evidence that official service integrations may combine MCP and Skills; not proof that every account type or current Graph operation is covered.
- [Work IQ MCP documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/tooling-servers-overview) and [Work IQ API licensing notice](https://www.microsoft.com/en-us/licensing/news/work-iq-general-availability): different documented surfaces and eligibility/charging statements must not be collapsed into one assumed entitlement.

Upstream main-branch references can change. Pin and exercise selected package revisions during implementation. This specification is based on repository inspection and primary-source research; no new plugin installation, real provider authorization, default creation scenario, or cross-Agent smoke test was performed while writing it.
