<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/korey-mark-dark.svg">
  <img align="right" src="assets/korey-mark-light.svg" alt="Korey" width="64">
</picture>

# bb-plugin-korey

**Ask Korey to work with your connected tools from any BB harness.**

BB lets you work across coding harnesses. Korey brings your connectors with you.
Connect services such as Shortcut, Sentry, and LaunchDarkly in Korey, and use them
from your BB conversations. Korey manages connector access and reauthentication
in one place. Your BB harnesses share that access, without a separate MCP server
to configure for each connector.

Give Korey the outcome and the context. It knows how to talk to the connected
services and can use your workspace’s conventions to do the work. For example,
you can delegate Story creation to Korey instead of walking your coding agent
through Shortcut’s fields and workflow one step at a time.

## Ask Korey…

> Ask Korey to create a Shortcut Story for the bug we just investigated, with
> reproduction steps and acceptance criteria.

> Ask Korey to summarize the Sentry errors introduced in our latest release.

> Ask Korey which LaunchDarkly flags control the new checkout flow and who has
> access to it.

> Ask Korey to compare this implementation plan with the existing Shortcut
> Stories and point out what we missed.

The plugin keeps a private Korey conversation linked to each BB thread, so you
can follow up with more context, attach workspace files, and continue the same
conversation as you change harnesses.

The current version supports research, analysis, and drafts across Korey’s
connected services, plus Shortcut Story creation and updates with a BB approval
prompt. Available data and actions depend on the connectors and permissions in
your Korey workspace. Story approvals use the BB desktop or web app.

## Get started

Requires a Korey account. Use BB 0.43.4 or newer; production builds are also
checked with BB 0.40.0. See [compatibility and validation](docs/development.md)
for the limits of those checks.

1. Connect the services you want to use in [Korey](https://korey.ai). See
   [Korey’s connector guides](https://korey.ai/docs/connectors/overview) for setup.
2. Create a Korey personal access token with `threads:read` and
   `threads:write` scopes.
3. Install the plugin:

   ```sh
   bb plugin install https://github.com/useshortcut/bb-plugin-korey
   ```

4. Add the token under **Settings → Installed plugins → Korey** in BB.
5. Ask your agent: “Ask Korey…”

Only the Korey connection is configured in BB. Keep each service’s connector
settings and credentials in Korey, where reauthentication is handled across
harnesses.

Check your connection with:

```sh
bb korey status
```

## From the CLI

```sh
bb korey ask "Summarize the Sentry errors introduced in our latest release"
bb korey ask "Review this rollout plan against our LaunchDarkly flags" --file plan.md
bb korey shortcut create "Create a Story for the bug investigated in this conversation"
```

When you ask for a Shortcut Story to be created or updated, the plugin shows the
request for approval before sending it to Korey. Korey handles the Story through
its Shortcut connector. You can also link an existing private Korey conversation
and continue work you started there.

## Reference

- [CLI, conversations, files, and operation recovery](docs/usage.md)
- [Development, CI, and the API contract](docs/development.md)

Maintained by Shortcut. MIT licensed; see [LICENSE](LICENSE).
