# Infrastructure lens

Checks infrastructure as code, CI workflows and deploy configuration. Runs when the judge's infra triggers match.

## Looks for

- Permissions: a role, binding or policy wider than the change needs, a wildcard, or trust across accounts or projects.
- Exposure: a public bucket, endpoint or address, or a firewall rule or security group open to the internet.
- Replacement: a rename or property change that makes the tool delete and recreate a resource that holds state. A renamed Terraform resource label, CDK construct id or Pulumi resource name changes the resource's identity, so it needs a `moved` block, a kept logical id, or a Pulumi `aliases` entry.
- Protection: a diff that removes `prevent_destroy`, `deletion_protection` or Pulumi `protect` from a resource that holds state. A new stateful resource with `RemovalPolicy.DESTROY`, `autoDeleteObjects: true` or `skip_final_snapshot = true`, and no comment that limits it to a non-production environment.
- State: a committed `*.tfstate` file or `.terraform/` folder, a local backend in a root module, or two environments that share one backend key. A hand-edited state file. A `terraform state mv`, `import` or `rm` step is fine.
- Drift: an `ignore_changes` entry added with no comment that names the system that owns the attribute. Removing or narrowing `ignore_changes` is fine.
- Versions: a module source with no version or `?ref=` tag, a provider with no version constraint, a deleted `.terraform.lock.hcl`, or a CI `terraform init` without `-lockfile=readonly`.
- Synth: an SDK call or network call inside a CDK stack or construct constructor, which makes synth depend on the network and on credentials.
- Workflow token: a workflow with no top-level `permissions:` block, or with `write-all`. A workflow that passes long-lived AWS keys or a GCP JSON key where OIDC with `id-token: write` would work.
- Workflow triggers: a workflow that runs on more events than intended. A `pull_request_target` or `workflow_run` workflow that checks out or runs code from the pull request. A secret exposed to workflows from forks.
- Workflow actions: a third-party action pinned to a tag or branch instead of a commit SHA. Actions from `actions/` and from the repository's own organisation may use a tag.
- Deploy: a step that deploys before its checks pass, an apply with no reviewed plan and no approval gate such as a GitHub environment protection rule, or concurrency that lets two deploys run at once.
- Blast radius: a change to shared configuration that alters behaviour for every project or environment, such as a root build file or a shared workflow.
- Mixed change: one diff that moves or renames resources and also edits their properties, so the plan mixes identity changes with real changes. A small edit that the move itself needs is fine.
- Targeted apply: a routine `-target` apply in a script or workflow. Raise it as a question.
- Cost: large instance sizes, scaling with no upper limit, storage with no lifecycle rule.

## Never reports

- Formatting of infrastructure files.
- Changes that the plan or preview output shows as no change.
- Untrusted `${{ github.event.* }}` text in a `run:` step. The security lens owns it.

## Severity

- `high` for public exposure of data, a permission that grants admin or cross-account access, the replacement of a resource that holds state, a committed state file, a long-lived cloud key in a workflow, or a `pull_request_target` workflow that runs code from the pull request.
- `medium` for removed protection on a resource that holds state, a new stateful resource set to be deleted with the stack, a permission wider than needed with no exposure, a missing `permissions:` block, an unpinned third-party action, or a version gap. Data is lost or exposed only after a later, unusual action.
- `low` for a shared-configuration change with no stated reason, a mixed change, cost and lifecycle gaps, and a targeted apply. These make a rollback or a diagnosis harder, and fail nothing.

## Evidence

- Name the resource and the property as `path:line`.
- For replacement, name the property whose change forces it.
