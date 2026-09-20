# Repository Instructions

## Commit Signing

All commits created or rewritten in this repository must be SSH-signed with the configured 1Password key.

The configured `op-ssh-sign` program does not work from the agent execution environment. It fails with `1Password: failed to fill whole buffer`, even when the outer command has a PTY. Use Git's standard `ssh-keygen` signer instead; it can access the same key through the 1Password SSH agent.

Run signing commands outside the filesystem sandbox with a PTY so the SSH agent is accessible and 1Password can request approval. Do not disable signing to work around a prompt or signer failure.

Create a signed commit with:

```bash
git -c gpg.ssh.program=/run/current-system/sw/bin/ssh-keygen commit -S <normal commit arguments>
```

Before relying on the signer, a non-branch-moving test can be made with:

```bash
git -c gpg.ssh.program=/run/current-system/sw/bin/ssh-keygen \
  commit-tree -S HEAD^{tree} -p HEAD -m 'test: verify 1Password agent signing'
```

This creates an unattached commit object and does not modify the branch or worktree.

Verify a commit immediately after creating it:

```bash
git -c gpg.ssh.program=/run/current-system/sw/bin/ssh-keygen verify-commit HEAD
git show -s --format='%H %G? %GS %s' HEAD
```

`verify-commit` must report a good signature, and `%G?` must be `G`. The expected signer is `sam@chouse.dev` with ED25519 fingerprint `SHA256:4p1AKmEfhuHl/ZPIvLgQ5Xbio7yiBkQghj3IXE/Turc`.

### Rebases

Rebases rewrite commits, so every local commit replayed by a rebase must be signed again. When the normal rebase path tries to invoke `op-ssh-sign`, prevent signing of the intermediate replay commits and amend each one with the working signer:

```bash
GIT_EDITOR=true git rebase --no-gpg-sign --force-rebase \
  --exec 'git -c gpg.ssh.program=/run/current-system/sw/bin/ssh-keygen commit --amend --no-edit -S' \
  <upstream>
```

Only use `--force-rebase` when a history rewrite is intended and authorized. Preserve dirty worktree changes before rebasing and restore them afterward.

After the rebase, verify every local commit:

```bash
for commit in $(git rev-list --reverse <upstream>..HEAD); do
  git -c gpg.ssh.program=/run/current-system/sw/bin/ssh-keygen verify-commit "$commit" || exit 1
done
```

Use `git range-diff` against the pre-signing commit series when commits were rewritten only to add signatures. The patches must remain equivalent.
