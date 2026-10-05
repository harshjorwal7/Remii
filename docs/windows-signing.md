# Windows desktop signing

Builds use the root Remii release number plus `-internal.g<commit>`. The workflow verifies
that both the packaged app and installer embed that version, and includes `build-version.json`
with the binaries. See [desktop build versions](releasing.md#desktop-build-versions).

The [Desktop Windows signing workflow](../.github/workflows/desktop-signing.yml)
builds Remii and its NSIS installer with the existing DigiCert certificate in
Azure Key Vault. It retains verified binaries and signature evidence as Actions
artifacts for 14 days. It does not create or publish a release. Desktop version
`0.0.0` remains a validation build.

Ordinary Desktop CI and fork PR builds remain unsigned. The
`tauri.windows-signing.conf.json` overlay is passed explicitly to Tauri only by
the protected signing job. Do not rename it `tauri.windows.conf.json`: Tauri
automatically merges that filename into every Windows build.

## Request a signed validation build

Before this workflow is merged to `main`, add the `windows-signing` label to a
same-repository PR and approve its `windows-signing` environment deployment.
The workflow checks out the exact PR head SHA from the labeling event. New
pushes run the regression job; remove and reapply the label to sign the new SHA.
Fork PRs cannot enter this signing job. There is no `pull_request_target` trigger.

After merge, use **Actions → Desktop Windows signing → Run workflow**, select the
ref to validate, and set `signing-mode` to `keyvault`. The default `none` runs
only credential-free regressions. Environment reviewers should check the exact
source SHA and workflow changes before approving access to the publisher's key.

A successful signing run extracts `remii-desktop.exe` from the NSIS installer
with 7-Zip, then verifies **both** that payload and the single `*-setup.exe`
installer using Windows Authenticode and
`signtool verify /pa /all /v /tw`. Signatures must be valid, timestamped, and carry
the publisher named in your own code-signing certificate. Any warning or nonzero
SignTool exit fails the job.
`signatures.json` records the source SHA, artifact SHA-256 hashes, signer and
timestamp certificates; the companion text files retain verbose SignTool output.
The binaries upload only after both pass. The extracted app is retained from
`desktop/signed-app/`: Tauri restores the unsigned build executable after bundling,
so verifying `target/release/remii-desktop.exe` would inspect the wrong copy.
These checks do not test SmartScreen reputation or exercise the app UI.

## One-time infrastructure setup

None of this exists yet for this repository: it needs your own Azure tenant, your
own Key Vault holding a code-signing certificate you have bought, and an Entra
application whose federated credential trusts this repository. Until then the
workflow runs in its default `none` mode, which exercises every credential-free
regression and signs nothing.

Use the protected GitHub environment `windows-signing` with required reviewers, and
set these environment **variables** in it. They are public identifiers, not
passwords:

| Variable | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | Application (client) id of an app registration you create |
| `AZURE_TENANT_ID` | Your Microsoft Entra tenant id |
| `AZURE_SUBSCRIPTION_ID` | Subscription containing your Key Vault |
| `AZURE_KEY_VAULT_URL` | `https://<your-vault>.vault.azure.net` |
| `CODE_SIGNING_CERT_NAME` | Name of the certificate in that vault |

Create the application and the federated credential with your own ids:

```sh
az ad app create --display-name remii-windows-signing \
  --sign-in-audience https://github.com/your-org
az ad app federated-credential create \
  --id <your-client-id> \
  --parameters desktop/signing/azure-federation.json
```

`desktop/signing/azure-federation.json` is a **template**. Its `subject` names this
repository and the `windows-signing` environment, and the environment id in it is a
placeholder to replace with the id your Azure environment reports — GitHub only
issues a token whose subject matches that credential exactly, so an unreplaced
placeholder means the workflow can never authenticate. Put the client id and tenant
id you created above into the environment variables, never into that file.

An owner of that application, or an appropriately authorized application
administrator, must add the federated credential. Check existing credentials
first; do not duplicate or replace another repository's credential. An
`Insufficient privileges` response requires an authorized app owner/administrator
to run the command; GitHub environment approval does not grant Entra permissions.

The signing identity needs certificate read and key sign permissions. With Key
Vault RBAC, **Key Vault Certificate User** plus **Key Vault Crypto User** cover
these operations; Crypto User alone does not grant certificate read access. No
client secret, exported private key, PFX, or Tauri updater signing key is needed.

The workflow pins Azure Login and AzureSignTool 7.0.1, checks the downloaded
tool's SHA-256, and obtains Key Vault access tokens through GitHub OIDC. The
wrapper refreshes the token for each signing invocation, registers it for log
masking, and clears its process environment afterward. Tokens are never written
to workflow outputs, `GITHUB_ENV`, or artifacts. Tauri invokes the wrapper for
the app and installer, as well as NSIS components it needs to sign.

## Check the scripts

```sh
pwsh -NoProfile -File desktop/scripts/test-windows-signing.ps1
```

The regression suite uses synthetic command results to test missing config,
native failures, unsigned/altered signatures, publisher mismatch, absent
timestamps, absent/stale installers, and evidence for both files. It runs on
Windows PR CI without Azure access. Only a protected signing run proves the
certificate, OIDC federation, and real Windows signature chain together.

References: [Tauri custom signing](https://v2.tauri.app/distribute/sign/windows/),
[AzureSignTool 7.0.1](https://github.com/vcsjones/AzureSignTool/tree/v7.0.1),
[Windows SignTool verification](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool),
[GitHub OIDC subjects](https://docs.github.com/en/actions/reference/security/oidc),
[Entra federated credentials](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust).
