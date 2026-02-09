flowchart LR
  %% ========================
  %% External Systems
  %% ========================
  subgraph External["External Systems"]
    LLMs["LLM Providers<br/>(OpenAI / Anthropic / Tool APIs)"]
    UserUI["Chat Interfaces<br/>(Web / WhatsApp / Desktop)"]
    SelfHosted["Customer Self-Hosted Assistants<br/>(UI + Brain)"]
  end

  %% ========================
  %% GCP Project Boundary
  %% ========================
  subgraph GCP["vellum-ai-prod (GCP Project)"]
    direction LR

    %% ------------------------
    %% Control Plane
    %% ------------------------
    subgraph Control["Control Plane"]
      ChatProxy["Chat Proxy<br/><small>Repo: chat-proxy</small><br/>Auth · Billing · Credential Resolution"]
    end

    %% ------------------------
    %% Data / Infra
    %% ------------------------
    subgraph Infra["Private GCP Resources"]
      Alloy["AlloyDB"]
      Storage["Cloud Storage"]
    end

    %% ------------------------
    %% Execution Plane (GKE)
    %% ------------------------
    subgraph GKE["GKE – Private, Unexposed Cluster"]
      Vembda["Vembda 2.0<br/><small>Repo: vembda</small>"]
      Assistants["Vellum Hosted Assistants<br/><small>Repo: assistants</small>"]
      Doctor["The Doctor<br/><small>Repo: doctor</small>"]
    end
  end

  %% ========================
  %% Traffic Flow
  %% ========================
  UserUI -->|Chat Requests| ChatProxy
  SelfHosted -->|Proxy API| ChatProxy

  ChatProxy -->|Model Calls| LLMs
  ChatProxy -->|Read / Write| Alloy
  ChatProxy -->|Artifacts| Storage

  ChatProxy -->|Execution| Vembda
  Vembda --> Assistants
  Assistants --> Doctor
  Doctor --> Assistants