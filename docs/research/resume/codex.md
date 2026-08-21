# Codex session resume

Sources: [official Developer commands reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

## Interactive behavior

Codex documents `/resume` as a local action: it opens a saved-session picker, then reloads the selected chat’s
transcript so work continues with the original history intact. The command does not represent a normal user prompt.

The command-line equivalent is `codex resume`:

* A session can be selected by ID or name.
* `--last` resumes the most recent chat for the current working directory.
* `--all` deliberately expands that search beyond the current working directory.
* If the current and saved directories differ, Codex asks which directory to use unless configured otherwise.

Codex makes copying history a separate `codex fork` operation. This distinction is useful: resume means continue the
existing transcript; creating a new branch must be explicit.

## What Senko should take from it

* Treat `/resume` as a picker and session transition, never as text sent to the model.
* Default to the current project rather than scanning every old session.
* Preserve the selected transcript instead of duplicating it.
* Keep cross-directory selection and forking separate from the first release; Senko has no need for either to make
  project-local resumption useful.
