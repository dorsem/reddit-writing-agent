# Security and private data

Do not attach `.env`, `agent.config.json`, `.local/`, tokens, account notices or real discussion exports to public issues. Report a reproducible problem with synthetic data; use GitHub's private vulnerability reporting if enabled by the repository owner for sensitive findings.

OAuth tokens are stored locally in plaintext with restrictive POSIX permissions. Use disk encryption and a trusted local machine. The OAuth callback binds to loopback and validates an unpredictable state value. The app does not request passwords, private-message scopes, voting scopes or moderation scopes. Revoke its OAuth grant through Reddit when no longer needed.

The default model endpoint is local Ollama. Enabling a remote endpoint is an explicit data-transfer decision. Never add model or Reddit secrets to the mission, topics, community description or prompts. Read third-party models' terms before use.

The agent does not execute model output, follow model URLs, or expose tools to the model. Forum content remains untrusted. Generation quality and community compliance require operator judgment. Treat a compromised local configuration or state directory as compromise of the installation; local controls do not defend against the machine owner editing the program.
