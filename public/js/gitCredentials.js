import { api } from "./api.js";
import { formDialog, confirmDialog } from "./ui.js";
import { t } from "./i18n.js";
const tr = (key, params) => t(`features:codebase.${key}`, params);

export async function openGitCredentials() {
  const data = await api("/api/git-credentials");
  let next;
  await formDialog({
    title: tr("gitCredentials"),
    description: `${tr("credentialsHelp")} ${data.storage?.keySource === "external" ? tr("externalKey") : tr("localKey")} ${data.transportAllowed ? "" : tr("secureTransport")}`,
    fields: (data.credentials || []).map((credential) => ({
      name: credential.id,
      label: credential.name,
      value: `${credential.type} · ${credential.username ? `${credential.username}@` : ""}${credential.host}:${credential.port}${credential.repositoryPrefix ? `/${credential.repositoryPrefix}` : ""}${credential.fingerprint ? ` · ${credential.fingerprint}` : ""}`,
      readOnly: true,
    })),
    actions: [
      ...(data.transportAllowed
        ? [
            {
              label: tr("addCredential"),
              onClick: () => {
                next = () => editCredential();
              },
            },
            {
              label: tr("generateKey"),
              onClick: () => {
                next = generateCredential;
              },
            },
          ]
        : []),
      ...(data.credentials || []).map((credential) => ({
        label: tr("manageCredential", { name: credential.name }),
        onClick: () => {
          next = () => manageCredential(credential, data.transportAllowed);
        },
      })),
    ],
    submit: t("common:actions.close"),
  });
  if (next) await next();
}
async function manageCredential(credential, transportAllowed) {
  let next;
  await formDialog({
    title: credential.name,
    description: `${credential.host} · ${credential.type}${credential.fingerprint ? ` · ${credential.fingerprint}` : ""}`,
    fields: credential.publicKey
      ? [
          {
            name: "publicKey",
            label: tr("publicKey"),
            type: "textarea",
            value: credential.publicKey,
            readOnly: true,
          },
          ...(credential.hostFingerprint
            ? [
                {
                  name: "hostFingerprint",
                  label: tr("hostKey"),
                  value: credential.hostFingerprint,
                  readOnly: true,
                },
              ]
            : []),
        ]
      : [],
    actions: [
      ...(transportAllowed &&
      credential.type === "ssh-key" &&
      credential.encryptedKey
        ? [
            {
              label: tr("unlockKey"),
              onClick: () => {
                next = () => unlockCredential(credential);
              },
            },
          ]
        : []),
      ...(transportAllowed
        ? [
            {
              label: tr("replaceCredential"),
              onClick: () => {
                next = () => editCredential(credential);
              },
            },
          ]
        : []),
      {
        label: tr("removeCredential"),
        onClick: () => {
          next = async () => {
            if (
              await confirmDialog(
                tr("removeCredential"),
                tr("removeCredentialConfirm", { name: credential.name }),
              )
            )
              await api(
                `/api/git-credentials/${encodeURIComponent(credential.id)}`,
                {
                  method: "DELETE",
                  body: { expectedVersion: credential.version },
                },
              );
          };
        },
      },
    ],
    submit: t("common:actions.close"),
  });
  if (next) await next();
}
async function editCredential(existing) {
  await formDialog({
    title: existing ? tr("replaceCredential") : tr("addCredential"),
    description: tr("credentialSecretHelp"),
    fields: [
      {
        name: "name",
        label: t("sessions:name"),
        value: existing?.name || "",
        required: true,
        maxLength: 100,
      },
      {
        name: "host",
        label: tr("credentialHost"),
        value: existing?.host || "",
        required: true,
      },
      {
        name: "port",
        label: tr("credentialPort"),
        value: existing?.port || "",
        type: "number",
        min: 1,
        max: 65535,
      },
      {
        name: "type",
        label: tr("credentialType"),
        type: "select",
        value: existing?.type || "https-token",
        options: [
          { value: "https-token", label: tr("httpsToken") },
          { value: "ssh-key", label: tr("sshKey") },
        ],
      },
      {
        name: "username",
        label: tr("credentialUsername"),
        value: existing?.username || "",
      },
      {
        name: "repositoryPrefix",
        label: tr("repositoryPrefix"),
        value: existing?.repositoryPrefix || "",
      },
      {
        name: "secret",
        label: tr("credentialSecret"),
        type: "password",
        autocomplete: "new-password",
      },
      {
        name: "sshSecret",
        label: tr("sshKey"),
        type: "textarea",
        secret: true,
        value: "",
        autocomplete: "off",
        help: tr("sshSecretHelp"),
      },
      {
        name: "hostKey",
        label: tr("hostKey"),
        type: "textarea",
        value: "",
        help: tr("hostKeyHelp"),
      },
      {
        name: "passphrase",
        label: tr("passphrase"),
        type: "password",
        autocomplete: "off",
        help: tr("passphraseHelp"),
      },
    ],
    onSave: async (values) => {
      const body = {
        ...values,
        ...(existing ? { expectedVersion: existing.version } : {}),
      };
      if (body.type === "ssh-key") body.secret = body.sshSecret;
      delete body.sshSecret;
      if (!body.secret.trim()) throw new Error(tr("missingSecret"));
      if (!body.port) delete body.port;
      if (!body.passphrase) delete body.passphrase;
      if (body.type !== "ssh-key") delete body.hostKey;
      await api(
        `/api/git-credentials${existing ? `/${encodeURIComponent(existing.id)}` : ""}`,
        { method: existing ? "PUT" : "POST", body },
      );
    },
  });
}
async function unlockCredential(credential) {
  await formDialog({
    title: tr("unlockKey"),
    description: tr("unlockHelp"),
    fields: [
      {
        name: "passphrase",
        label: tr("passphrase"),
        type: "password",
        required: true,
        autocomplete: "off",
      },
    ],
    onSave: async (values) => {
      await api(
        `/api/git-credentials/${encodeURIComponent(credential.id)}/unlock`,
        {
          method: "POST",
          body: {
            passphrase: values.passphrase,
            expectedVersion: credential.version,
          },
        },
      );
    },
  });
}
async function generateCredential() {
  let created;
  await formDialog({
    title: tr("generateKey"),
    description: tr("generateHelp"),
    fields: [
      {
        name: "name",
        label: t("sessions:name"),
        required: true,
        maxLength: 100,
      },
      { name: "host", label: tr("credentialHost"), required: true },
      {
        name: "port",
        label: tr("credentialPort"),
        type: "number",
        min: 1,
        max: 65535,
      },
      { name: "username", label: tr("credentialUsername"), value: "git" },
      { name: "repositoryPrefix", label: tr("repositoryPrefix") },
      {
        name: "hostKey",
        label: tr("hostKey"),
        type: "textarea",
        required: true,
        help: tr("hostKeyHelp"),
      },
    ],
    onSave: async (values) => {
      const body = { ...values };
      if (!body.port) delete body.port;
      created = await api("/api/git-credentials/generate", {
        method: "POST",
        body,
      });
    },
  });
  if (created?.publicKey)
    await formDialog({
      title: tr("generatedKey"),
      description: tr("registerPublicKey"),
      fields: [
        {
          name: "publicKey",
          label: tr("publicKey"),
          type: "textarea",
          value: created.publicKey,
          readOnly: true,
        },
        {
          name: "fingerprint",
          label: tr("fingerprint"),
          value: created.fingerprint || "",
          readOnly: true,
        },
      ],
      submit: t("common:actions.close"),
    });
}
