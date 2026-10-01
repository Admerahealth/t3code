# Hermes

T3 Code uses the Hermes Agent CLI installed on the connected environment. With a remote
environment, its Hermes login and configuration apply, not the setup on your desktop or phone.

## Install Hermes Agent

Install the Hermes Agent CLI on the machine T3 Code connects to, then confirm it is on `PATH`:

```bash
hermes --version
```

If you installed it somewhere else, set **Binary path** on the Hermes provider in Settings to the
full path of the `hermes` executable.

## Configure credentials

Hermes manages its own credentials and model configuration outside T3 Code, in its own config
files. Run:

```bash
hermes model
```

and follow the prompts to pick a model provider and store its API key. T3 Code does not ask for a
Hermes API key or run an OAuth flow of its own — the `hermes` process T3 Code starts inherits
whatever you configured this way.

## Enable Hermes in T3 Code

Hermes ships as an early-access provider and is off by default. In **Settings > Providers**, add or
enable a Hermes provider. T3 Code checks that `hermes acp --check` succeeds before marking the
provider ready; if it reports an error, rerun `hermes model` or update Hermes Agent and refresh the
provider status.

## Model list

Select **Configured Hermes model** to use the model chosen with `hermes model`. To choose a
specific model from T3 Code, add its Hermes model ID, such as `openrouter:model-name`, under
**Custom models** on the Hermes provider in Settings.

Hermes Mixture of Agents presets work the same way. Run `hermes moa configure review`,
then add `moa:review` as a custom model in T3 Code. Set the acting model, advisers, and their
reasoning levels in the Hermes preset; selecting that model in T3 Code runs the complete preset.

## Approvals

Hermes asks the host to approve tool calls and commands over ACP, the same way Cursor and Grok do
in T3 Code. Approve, approve for the session, or decline from the same approval prompts you already
use for other providers — Hermes has no separate permission-mode CLI flags to configure.

Hermes conversations can be resumed after restarting T3 Code. Conversation rewind is unavailable
because Hermes does not expose it to connected clients.
