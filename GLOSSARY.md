# Metheus

Metheus lets people work with persistent assistants on a local or remote Agent Daemon.

## Language

**Bot**

A named personal assistant with an ongoing job and one continuous **Conversation**. The user can change its job in chat.

**Agent**

The executor for a **Bot** that handles its messages and coordinates its ongoing work.

**Agent Daemon**

The service that runs **Agents** and connects them to desktop clients. It can run on the same computer as a client or on a remote host.

**Conversation**

The continuous exchange of messages between the user and one **Bot**.

**Message History**

The original messages in a **Conversation**.

**UserMemory**

The user's explicitly stated facts and standing preferences, shared by all **Bots** on the same **Agent Daemon**.

**Observational Memory**

A summary of earlier messages in one **Conversation** that helps its **Agent** maintain continuity.

**Recall**

A **Bot**'s on-demand retrieval of earlier original messages and their sources.

**Provider Configuration**

A saved pairing of a model provider and a selected model for an **Agent Daemon**. An **Agent Daemon** can keep configurations for multiple providers.
